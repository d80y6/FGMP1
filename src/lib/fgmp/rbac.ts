import "server-only";

import type { Role } from "./types";
import { db } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { getOpsDb } from "@/lib/fgmp/owner-db";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

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
// bootstrap() (src/lib/fgmp/index.ts) feeds its result into 83 API route
// handlers, and many use it for TENANT SCOPING (assertTenantOwned,
// tenantWhere, rate-limit keys, audit attribution) rather than merely for
// logging. So any transient failure of `import("next-auth")` silently
// substituted the wrong tenant — a fail-open authorization bug triggered by an
// operational fault. `_current` was also process-global module state, so once
// degraded the wrong identity persisted for the life of the process and leaked
// across requests.
//
// It now FAILS CLOSED: no session means an exception, never an identity.
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

export interface FgmpUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
}

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
    // `Me` declares tenantId as a plain string because that is what every
    // AUTHENTICATED user has. A PENDING MFA session has none — it is not yet
    // authorised — so this is the one place the two meet.
    //
    // requireTenantId THROWS rather than defaulting to "". An empty-string
    // tenant would build a filter matching nothing while looking perfectly
    // valid, which reads as "no data" instead of "not allowed".
    return {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      role: session.user.role as Role,
      tenantId: tenantIdOrThrow(session.user.tenantId),
    };
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
