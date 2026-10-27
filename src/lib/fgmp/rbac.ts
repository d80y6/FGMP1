import "server-only";

import type { Role } from "./types";
import { db } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { getOpsDb } from "@/lib/fgmp/owner-db";
import { toCurrentFgmpUser, type FgmpUser } from "@/lib/fgmp/session-principal";
import { getSessionState } from "@/lib/auth-identity";

export {
  ALL_ROLES,
  canView,
  hasCapability,
  isSuperAdmin,
  ROLE_PERMISSIONS,
  SUPERADMIN_ONLY_CAPABILITIES,
} from "./rbac-core";
export type { Permission, Role } from "./rbac-core";

// ── Session (NextAuth-backed) ─────────────────────────────────────────────
// Production auth is handled by NextAuth (Task 31-A, src/lib/auth.ts) and the
// session is the source of truth.
//
// SECURITY (Phase 0.3): getCurrentUser() used to wrap the session lookup in a
// bare `catch {}` that fell through to a hardcoded t-default "mock" identity.
// At the time, bootstrap() fed its result into dozens of API route handlers,
// many using it for tenant scoping, rate-limit keys and audit attribution. A
// transient NextAuth import failure could therefore substitute the wrong
// tenant — a fail-open authorization bug triggered by an operational fault.
// The old session fallback was process-global; `_current` is now only the cache
// for an explicitly requested system identity, never a request-session source.
// Bootstrap consumes the exact principal that passed the request guard, and
// getCurrentUser() independently revalidates session state for any direct use.
//
// It fails closed: no session means an exception, never an identity.
// System/seed contexts that legitimately have no HTTP session must call
// getSystemUser() explicitly, so the intent is visible at every call site
// instead of being an invisible side effect of an import failure.

/**
 * Owner/ops client for SYSTEM-level identity work.
 *
 * `getSystemUser()` and `setCurrentRole()` operate on the platform identity
 * itself — the tenant and the user that owns it — which by definition cannot be
 * tenant-scoped, since a tenant's own row is what must be created before any
 * context exists. Under Phase 1's FORCE RLS the ambient `db` (the non-owner
 * `fgmp_app` role) returns zero rows for these and the WITH CHECK rejects the
 * write, so the bootstrap silently failed.
 *
 * This is a deliberate, narrow ops path — the same role split the rest of the
 * system uses (see src/lib/fgmp/seed.ts). It is NOT a licence to move the web
 * app's DATABASE_URL to the owner role, which would disable RLS everywhere.
 */
function systemDb(): PrismaClient {
  return getOpsDb() ?? db;
}

const DEFAULT_USER = {
  id: "u-noc-1",
  name: "A. Al-Rashid",
  email: "noc.operator@fgmp.telecom",
  role: "NOC_OPERATOR" as Role,
  tenantId: "t-default",
};

let _current: FgmpUser | null = null;

/**
 * Resolve the authenticated user for the current HTTP request.
 *
 * THROWS when no NextAuth session is present — deliberately. Callers on the
 * request path have already passed requireAuth()/requireRole(), which return
 * the session user; they should prefer `auth.user` over this helper.
 *
 * Request handlers that still need this should treat a throw as 401, not
 * swallow it.
 */
export async function getCurrentUser(): Promise<FgmpUser> {
  const { getServerSession } = await import("next-auth");
  const { authOptions } = await import("@/lib/auth");
  const session = await getServerSession(authOptions);
  if (session?.user?.id) {
    // Never consume the JWT's old role or tenant as current authority. This
    // helper is not the route guard, but it must still fail closed if a caller
    // uses it after an account was disabled, revoked, or changed.
    const state = await getSessionState(session.user.id);
    try {
      return toCurrentFgmpUser(session.user, state);
    } catch {
      throw new Error("getCurrentUser(): session is not an active, fully authenticated session.");
    }
  }
  throw new Error(
    "getCurrentUser(): no authenticated session. Request handlers must use the " +
      "user returned by requireAuth()/requireRole(). Non-request contexts " +
      "(seed/CLI/system jobs) must call getSystemUser() explicitly.",
  );
}

/**
 * The default platform identity for contexts that have no HTTP session —
 * seed scripts, CLI jobs, and internal engine work.
 *
 * Callers must name this function deliberately. It is NEVER invoked as a
 * fallback by getCurrentUser(), so it cannot silently mask an authentication
 * failure on a request path.
 */
export async function getSystemUser(): Promise<FgmpUser> {
  if (_current) return _current;
  try {
    const system = systemDb();
    const tenant = await system.tenant.upsert({
      where: { code: "NATIONAL-TELCO" },
      update: {},
      create: { id: "t-default", name: "National Telecom Operator", code: "NATIONAL-TELCO", country: "Yemen" },
    });
    const user = await system.user.upsert({
      where: { email: DEFAULT_USER.email },
      update: {},
      create: { id: DEFAULT_USER.id, tenantId: tenant.id, email: DEFAULT_USER.email, name: DEFAULT_USER.name, role: DEFAULT_USER.role },
    });
    _current = { id: user.id, name: user.name, email: user.email, role: user.role as Role, tenantId: user.tenantId };
  } catch {
    _current = { ...DEFAULT_USER };
  }
  return _current;
}

/**
 * Switch the *system* identity's role.
 *
 * This mutates a real User row, so it is only meaningful for seed/CLI contexts
 * that have opted into getSystemUser(). It has no effect on a live NextAuth
 * session — use PATCH /api/fgmp/me for that.
 */
export async function setCurrentRole(role: Role) {
  const u = await getSystemUser();
  _current = { ...u, role };
  try {
    await systemDb().user.update({ where: { id: u.id }, data: { role } });
  } catch {
    /* ignore */
  }
  return _current;
}
