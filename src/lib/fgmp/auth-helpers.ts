import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import {
  authOptions,
  assertAuthConfigured,
  JWT_SECRET_CONFIGURED,
  type SessionUser,
} from "@/lib/auth";
import { canAccessApi, hasCapability, isSuperAdmin } from "@/lib/fgmp/rbac-core";
import { ApiError } from "@/lib/fgmp/api-error";
import type { Role } from "@/lib/fgmp/types";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { PREVIEW_COOKIE, verifyPreviewToken } from "@/lib/fgmp/role-preview";
import { getSessionState } from "@/lib/auth-identity";

/**
 * Server-side auth helpers (Task 31-A)
 * ────────────────────────────────────────────────────────────────────────────
 * Drop-in guards for App Router API routes. Each helper resolves the NextAuth
 * session via getServerSession() and returns either the authenticated user
 * (for happy-path use) or a ready-made NextResponse error (401 / 403) the
 * caller can return verbatim.
 *
 * Usage pattern:
 *   export async function POST(req: Request) {
 *     const auth = await requireRole(req, ["ADMIN", "NOC_OPERATOR"]);
 *     if ("error" in auth) return auth.error;
 *     const { user } = auth;            // SessionUser
 *     …
 *   }
 *
 * The helpers are intentionally tiny so they can be reused by every route
 * without bloating handler code.
 */

export type AuthResult =
  | { user: SessionUser; error?: undefined }
  | { user?: undefined; error: NextResponse };

/**
 * Resolve the server session and return the authenticated user. Returns a
 * 401 NextResponse if the request is unauthenticated (no session or no user).
 *
 * If NEXTAUTH_SECRET is missing or too short, this returns 503 instead of
 * silently falling back to a build-time placeholder secret — a misconfigured
 * deployment must not issue tokens that anyone could have forged.
 */
export async function requireAuth(_request?: Request): Promise<AuthResult> {
  if (!JWT_SECRET_CONFIGURED) {
    try {
      assertAuthConfigured();
    } catch (err) {
      return {
        error: NextResponse.json(
          {
            error: "Auth not configured",
            code: "AUTH_MISCONFIGURED",
            detail: err instanceof Error ? err.message : String(err),
          },
          { status: 503 },
        ),
      };
    }
  }
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return {
      error: NextResponse.json(
        { error: "Unauthorized", code: "UNAUTHENTICATED" },
        { status: 401 },
      ),
    };
  }

  // ── Session revalidation (security fix, 2026-10) ────────────────────────
  // A JWT is a claim about the PAST: it carries the role, tenant and identity
  // from sign-in time and, with an 8-hour lifetime and no session store, nothing
  // took them away again. Measured on a live server before this block existed:
  //
  //   • `UPDATE "User" SET role='READONLY'` — the signed-in session still
  //     reported REGIONAL_MANAGER and still passed REGIONAL_MANAGER checks.
  //   • `UPDATE "User" SET active=false`    — the deactivated account kept full
  //     access (GET /api/fgmp/state 200) until the token expired.
  //   • a password reset did not terminate the sessions that used the old one.
  //
  // So every authenticated request now re-reads the authoritative account state.
  // This is one primary-key lookup, and it is deliberately NOT cached: a cached
  // answer is a window in which a revoked session still works.
  //
  // The DB values REPLACE the token's for role and tenant. That makes a demotion
  // effective on the next request instead of on the next login — the alternative
  // (reject only when the token is stale) would force a re-login to apply a
  // permission reduction, which is precisely what an attacker holding a stolen
  // token wants.
  const state = await getSessionState(session.user.id);
  if (!state) {
    return {
      error: NextResponse.json(
        { error: "Unauthorized", code: "ACCOUNT_NOT_FOUND" },
        { status: 401 },
      ),
    };
  }
  if (!state.active) {
    return {
      error: NextResponse.json(
        {
          error: "This account has been deactivated.",
          code: "ACCOUNT_DISABLED",
        },
        { status: 401 },
      ),
    };
  }
  // Tokens minted before the counter existed carry no value; that is read as 0,
  // the default epoch of every existing user, so an upgrade does not sign
  // anybody out. Any later bump does.
  if ((session.user.sessionEpoch ?? 0) !== state.sessionEpoch) {
    return {
      error: NextResponse.json(
        {
          error: "This session is no longer valid. Sign in again.",
          code: "SESSION_REVOKED",
        },
        { status: 401 },
      ),
    };
  }
  // A PENDING (MFA) session deliberately carries no role/tenant. It must keep
  // carrying none: the only paths it may reach are the MFA completion endpoints,
  // and handing it the DB role here would be the escalation the pending state
  // exists to prevent.
  const revalidated: SessionUser = session.user.mfaPending
    ? session.user
    : {
        ...session.user,
        role: state.role,
        tenantId: state.tenantId,
      };

  // ── Role preview overlay (proposal §8.16) ──────────────────────
  // A valid preview token temporarily overlays the session role.
  // It is signed, expiry-bound and user-bound, and it NEVER writes
  // the User row — so the permanent role is preserved and a fresh
  // login automatically returns to it. verifyPreviewToken fails
  // closed (null) on any inconsistency, leaving the permanent role
  // in charge.
  const overlayRole = await applyRolePreview(revalidated);
  const user = overlayRole ?? revalidated;

  // Endpoint policies are capability-based and applied here, before handlers
  // perform database work. Matching client-side gates avoid making these
  // requests at all; this server check remains authoritative for direct or
  // forged HTTP requests.
  if (_request && !canAccessApi(user.role, _request.url, _request.method)) {
    return {
      error: NextResponse.json(
        {
          error: "Forbidden",
          code: "INSUFFICIENT_CAPABILITY",
        },
        { status: 403 },
      ),
    };
  }

  return { user };
}

/**
 * Apply the session-scoped role-preview overlay, if one is active.
 *
 * Returns the session user with `role` replaced by the previewed
 * role plus `permanentRole`/`previewRole` markers, or null when no
 * valid overlay exists. Reading the cookie can only happen inside a
 * request scope; outside one (unit tests, scripts) there is simply
 * no overlay, which is the correct answer.
 */
async function applyRolePreview(sessionUser: SessionUser): Promise<SessionUser | null> {
  if (!sessionUser.id || !sessionUser.role) return null;
  // ── The preview overlay needs a CURRENT admin behind it (security fix) ────
  // The token is minted only for a permanent admin, but it outlives the role
  // that justified it: it is signed for 15 minutes and nothing re-checks the
  // caller's authority when it is USED. Demote an admin mid-preview and, before
  // this guard, the overlay kept handing back the previewed role — including a
  // role ABOVE the demoted one — until the token expired. A permission a user
  // has already lost must not survive in a cookie, so the DB role (which
  // `requireAuth` has just re-read) gates the overlay itself. Fails closed: no
  // overlay, and the caller keeps exactly its current role.
  if (!isSuperAdmin(sessionUser.role) && sessionUser.role !== "ADMIN") return null;
  let token: string | undefined;
  try {
    const store = await cookies();
    token = store.get(PREVIEW_COOKIE)?.value;
  } catch {
    // Called outside a request scope — no cookie, no overlay.
    return null;
  }
  if (!token) return null;
  const previewRole = verifyPreviewToken(token, sessionUser.id);
  if (!previewRole) return null;
  return {
    ...sessionUser,
    role: previewRole,
    permanentRole: sessionUser.role,
    previewRole,
  };
}

/**
 * Require an authenticated session AND a role in the supplied allow-list.
 * Returns 401 if unauthenticated, 403 if the role is not permitted.
 *
 * SUPERADMIN bypass: SUPERADMIN holds the `*` capability and is the
 * platform-level cross-tenant role, so it is admitted to ANY role-gated
 * route regardless of the supplied allow-list. This keeps route handlers
 * declarative — `requireRole(req, ROLES.ADMIN_ONLY)` admits both ADMIN
 * (tenant admin) and SUPERADMIN (platform admin) without each route having
 * to spell out `SUPER_OR_ADMIN`. Routes that genuinely want to EXCLUDE
 * super-admin (none currently exist) can add an explicit guard after.
 *
 * Fail-fast on a malformed allow-list: a missing ROLES.* key resolves to
 * `undefined`, and `roles.includes(...)` on `undefined` threw a TypeError
 * *inside* the handler — a per-request 500 that hid the real bug (see
 * `ROLES.DISPENSER_CONTROL`, which two routes referenced before it existed).
 * We now validate the shape and throw at the call site with an actionable
 * message instead of failing opaquely per-request.
 */
export async function requireRole(
  _request: Request,
  roles: Role[],
): Promise<AuthResult> {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error(
      "requireRole() called with an empty or non-array role allow-list. " +
        "This usually means a route referenced a ROLES.<KEY> entry that does " +
        "not exist in src/lib/fgmp/auth-helpers.ts.",
    );
  }
  const auth = await requireAuth(_request);
  if ("error" in auth) return auth;
  if (isSuperAdminUser(auth.user)) return auth;
  if (!roles.includes(auth.user.role as Role)) {
    return {
      error: NextResponse.json(
        {
          error: "Forbidden",
          code: "INSUFFICIENT_ROLE",
          required: roles,
          actual: auth.user.role,
        },
        { status: 403 },
      ),
    };
  }
  return auth;
}

/**
 * Permission-matrix guard. Wraps hasCapability() from rbac.ts so routes can
 * enforce fine-grained capability keys (e.g. "alarm:ack", "gen:control")
 * rather than hard-coded role lists.
 */
export function can(user: SessionUser, permission: string): boolean {
  return hasCapability(user.role as Role, permission);
}

// ── Re-exported role sets for convenience ────────────────────────────────────
// Common role groups used across the FGMP API surface. Importing these keeps
// route handlers declarative and centralizes the policy in one place.
//
// Task 49 — Super-admin model:
//   SUPERADMIN_ONLY — platform-level mutations (create tenants, create
//                     tenant admins for any tenant, delete tenants, …).
//   SUPER_OR_ADMIN  — tenant-user management. SUPERADMIN can touch any
//                     tenant's users; ADMIN can touch only their own
//                     tenant's users (and never SUPERADMIN accounts).
//   ADMIN_ONLY      — tenant-level admin mutations within the caller's own
//                     tenant (legacy alias; kept for routes that have not
//                     yet been migrated to the super/admin split).
export const ROLES = {
  SUPERADMIN_ONLY: ["SUPERADMIN"] as Role[],
  /** User management — super-admin (any tenant) + tenant admin (own tenant). */
  SUPER_OR_ADMIN: ["SUPERADMIN", "ADMIN"] as Role[],
  ADMIN_ONLY: ["ADMIN"] as Role[],
  /** Alarm acknowledge / resolve — NOC ops + managers. */
  ALARM_OPS: ["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER"] as Role[],
  /** Correlation-rule authoring/evaluation — ADMIN and regional supervisors. */
  ALARM_RULES: ["ADMIN", "REGIONAL_MANAGER"] as Role[],
  /** Generator remote control — admins + NOC ops. */
  CONTROL: ["ADMIN", "NOC_OPERATOR"] as Role[],
  /** Fuel delivery create / dispatch / verify. */
  DELIVERY: ["ADMIN", "REGIONAL_MANAGER", "FIELD_ENGINEER"] as Role[],
  /** Maintenance ticket create / complete. */
  MAINTENANCE: ["ADMIN", "REGIONAL_MANAGER", "FIELD_ENGINEER"] as Role[],
  /** Notification dismissal / mark-sent. */
  NOTIFICATION: ["ADMIN", "NOC_OPERATOR"] as Role[],
  /** Edge gateway + ESP firmware OTA management (Task 48). ADMIN-only —
   *  covers gateway PATCH/DELETE/reboot, firmware release create/delete,
   *  and OTA deployment dispatch. */
  EDGE_MANAGE: ["ADMIN"] as Role[],
  /**
   * Fuel-dispenser / ESP32 hardware control — rebooting an embedded
   * controller and queueing OTA deployments. Operationally this is a
   * hands-on-the-hardware action, so it is limited to roles that can
   * actually be at the pump.
   *
   * This key was MISSING while two routes already referenced it
   * (`edge/esp/[dispenserId]/reboot` and `edge/firmware/deploy`), which made
   * `requireRole(req, ROLES.DISPENSER_CONTROL)` receive `undefined` and
   * throw a TypeError on every request. The module-load assertion below is
   * what stops that class of bug recurring.
   */
  DISPENSER_CONTROL: ["ADMIN", "NOC_OPERATOR", "FIELD_ENGINEER"] as Role[],
  /**
   * Advance the global simulation clock (`POST /api/fgmp/tick`).
   *
   * `engine.tick()` mutates EVERY tenant's sites, tanks, generators, alarms
   * and audit log — it is not tenant-scoped in any way. It was previously
   * gated on a bare `requireAuth()`, so a READONLY account could fast-forward
   * the whole platform 60×/min at up to 3600 simulated seconds per call.
   * Restricted to operator roles that legitimately drive the simulation.
   */
  TICK: ["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER"] as Role[],
} as const;

/**
 * Module-load assertion: every ROLES.* entry must be a non-empty array of
 * real Role values. This turns a typo'd role-set reference into an
 * immediate, named failure at import time instead of a per-request 500 with
 * no useful context (the bug that `ROLES.DISPENSER_CONTROL` shipped as).
 */
const VALID_ROLES = new Set<string>([
  "SUPERADMIN",
  "ADMIN",
  "NOC_OPERATOR",
  "REGIONAL_MANAGER",
  "FIELD_ENGINEER",
  "EXECUTIVE",
  "READONLY",
]);
const ROLE_SET_ENTRIES = Object.entries(
  ROLES as unknown as Record<string, readonly string[]>,
);
for (const [key, value] of ROLE_SET_ENTRIES) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`ROLES.${key} must be a non-empty array of Role values.`);
  }
  for (const r of value) {
    if (!VALID_ROLES.has(r)) {
      throw new Error(`ROLES.${key} contains unknown role "${r}".`);
    }
  }
}

// ── Super-admin helpers (Task 49) ───────────────────────────────────────────
// SUPERADMIN is the platform-level role. It does NOT bypass tenant isolation:
// no role does, and no connection in the request path has BYPASSRLS. What the
// role gets is the platform API surface (/api/fgmp/platform/**) plus the right
// to NAME another tenant explicitly on the user routes.
//
// These helpers answer "is this person a platform operator?", which is a
// question about the ROUTE's policy. They must not be used to widen a tenant
// filter: a WHERE clause cannot widen RLS (see docs/SUPERADMIN.md §8, and the
// audit route for a measured example of a comment that claimed otherwise).
//
// Cross-tenant ACCESS is a separate, time-boxed grant:
// src/lib/fgmp/support-session.ts.

/** Whether the authenticated user is a platform super-admin. */
export function isSuperAdminUser(user: { role?: string } | null | undefined): boolean {
  return isSuperAdmin(user?.role);
}

// ── Tenant isolation helpers (Round 45) ─────────────────────────────────────
// These helpers enforce multi-tenant data scoping. EVERY query that reads or
// mutates tenant-owned data MUST use one of them — otherwise a user in Tenant A
// can read/modify Tenant B's data by guessing a CUID.
//
// Models with a direct `tenantId` column (User, Site, Alarm, AuditLog,
// Notification, AlarmSuppression, ApiKey, Region): use `tenantWhere(me)`.
//
// Child models scoped via their parent Site (FuelTank, Generator, BatteryBank,
// IotDevice, FuelDispenser, FuelTransaction, FuelDelivery, MaintenanceTicket,
// SensorReading, SiteEvent): use `siteTenantWhere(me)`.
//
// Single-record access (GET/PUT/PATCH/DELETE by id): after fetching the record,
// call `assertTenantOwned(record, me)` — it returns a 404 NextResponse (NOT 403,
// to avoid cross-tenant existence disclosure) if the record belongs to a
// different tenant, or `null` if access is allowed.

/**
 * The tenant a request is scoped to, or a hard failure.
 *
 * ── WHY THIS THROWS RATHER THAN RETURNING `undefined` ────────────────────────
 * `SessionUser.tenantId` is OPTIONAL, and deliberately so: a PENDING MFA session
 * must not carry one, and an absent key is falsy so the ~80 existing
 * `user.role === X` checks deny it without auditing any of them.
 *
 * That optionality has to be resolved exactly once, at the boundary where a
 * tenant becomes a query filter. Every tenant-scoping helper below calls this,
 * so "this request has no tenant, therefore it must not proceed" is decided in
 * one place.
 *
 * The alternative — `as string`, or `?? ""` — would typecheck and be WRONG. An
 * empty-string tenantId builds a filter that matches NOTHING while looking
 * perfectly valid, and a caller who reads `me.tenantId!` directly gets no error
 * at all. Failing closed converts a silent empty result (or, worse, a missing
 * filter) into a loud 403 with a code the client can act on.
 *
 * This is also defence in depth: the MFA guard already refuses these paths by
 * URL, so if that guard is ever bypassed or mis-ordered, a tenant-less session
 * still cannot construct a valid tenant filter at all.
 */
export function requireTenantId(me: SessionUser): string {
  // Narrow here rather than delegating to tenantIdOrThrow: this must RETURN the
  // tenant when one exists and THROW when it does not, and the compiler has to
  // be able to see that.
  if (typeof me.tenantId === "string" && me.tenantId.trim() !== "") return me.tenantId;
  // Platform users also carry the platform tenant id. Their role does not
  // create an unscoped tenant context; only explicit control-plane paths may
  // name another tenant.
  throw new ApiError(
    403,
    "This request is not scoped to a tenant. Complete multi-factor authentication first.",
  );
}

/** Build a `{ tenantId }` filter for models that carry a direct tenantId column. */
export function tenantWhere(me: SessionUser): { tenantId: string } {
  return { tenantId: requireTenantId(me) };
}

/**
 * Legacy-named list filter. It always scopes rows to the authenticated
 * session's tenant, including SUPERADMIN sessions (whose tenant is PLATFORM).
 * Fleet aggregates belong in explicit control-plane stores, never in an
 * ordinary customer-row list query.
 */
export function tenantWhereOrAll(me: SessionUser): { tenantId: string } {
  return { tenantId: requireTenantId(me) };
}

/**
 * Build a `{ site: { tenantId } }` filter for child models scoped via their
 * parent Site (tanks, generators, batteries, IoT, dispensers, deliveries,
 * maintenance tickets, sensor readings, site events).
 */
export function siteTenantWhere(me: SessionUser): { site: { tenantId: string } } {
  return { site: { tenantId: requireTenantId(me) } };
}

/**
 * Legacy-named child-list filter. It always scopes through the parent site to
 * the authenticated session's tenant. Platform fleet aggregates must use an
 * explicit control-plane path instead of widening this customer-data query.
 */
export function siteTenantWhereOrAll(me: SessionUser): { site: { tenantId: string } } {
  return { site: { tenantId: requireTenantId(me) } };
}

/**
 * Assert that a fetched record belongs to the caller's tenant. Returns a 404
 * NextResponse if the record is null OR belongs to a different tenant (we use
 * 404 — not 403 — to avoid leaking the existence of cross-tenant records).
 * Returns `null` when access is allowed, so the caller can proceed.
 *
 * SUPERADMIN bypasses this POST-FETCH comparison — but not the database. Their
 * routes resolve an explicit tenant with `resolveTenantScope()` (or, for support
 * work, a time-boxed support session), so the row they fetched came from the
 * tenant they actually named. "Skip the comparison" is not "read any tenant":
 * see docs/SUPERADMIN.md.
 *
 * Usage:
 *   const rec = await db.alarm.findUnique({ where: { id } });
 *   const denied = assertTenantOwned(rec, me);
 *   if (denied) return denied;
 */
export function assertTenantOwned(
  record: { tenantId?: string } | null,
  me: SessionUser,
): NextResponse | null {
  if (isSuperAdminUser(me)) return null;
  if (!record || record.tenantId !== tenantIdOrThrow(me.tenantId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

/**
 * Assert that a fetched child record (no direct tenantId) belongs to the
 * caller's tenant via its parent Site. Pass the Site row (or a record carrying
 * `tenantId`) that was fetched separately.
 */
export function assertSiteTenantOwned(
  site: { tenantId?: string } | null,
  me: SessionUser,
): NextResponse | null {
  return assertTenantOwned(site, me);
}
