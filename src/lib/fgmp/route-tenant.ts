/**
 * Tenant-scoped data access for route handlers.
 *
 * ── WHY ROUTES COULD NOT DO THIS THEMSELVES ─────────────────────────────────
 * Phase 1 enabled FORCE Row Level Security on all 24 tenant tables. A `db.*`
 * query made without a tenant context returns ZERO rows rather than raising an
 * error, and an explicit `where: { tenantId }` does not help — the policy's
 * USING clause is ANDed with it and `current_setting('app.tenant_id', true)` is
 * NULL. Measured against the live database:
 *
 *     db.site.count()                                     -> 0
 *     db.site.count({ where: { tenantId: "t-default" } }) -> 0
 *     withTenant("t-default", tx => tx.site.count())      -> 52
 *
 * That second line is why the Phase 0 application-level defences went inert
 * rather than merely bypassed. `assertTenantOwned(record, user)` compares
 * `record.tenantId` AFTER the row was fetched; under RLS the fetch returns
 * null, so the check sees nothing and every request 404s. The checks are
 * correct and must be KEPT as defence in depth — but they only start working
 * again once the read is actually scoped.
 *
 * ── WHY A HELPER RATHER THAN INLINE withTenant() ────────────────────────────
 * Two reasons, both about not getting this subtly wrong across ~80 routes:
 *
 *   1. `withTenant` gives you a TRANSACTION client. A query accidentally left
 *      on the outer `db` while the rest runs on `tx` still returns zero rows —
 *      the same silent failure, reintroduced inside a "fixed" route. The helper
 *      takes the client as the first argument everywhere so the scoping is
 *      visible in the signature.
 *   2. An empty result and a hidden result must not look the same. Every helper
 *      here either returns rows the caller can act on, or throws — never a
 *      silent empty array.
 */

import { withTenant } from "./tenant-context";
import type { SessionUser } from "@/lib/auth";
import { isSuperAdmin } from "@/lib/fgmp/rbac-core";
import type { Prisma } from "@prisma/client";

/**
 * The transaction client `withTenant` hands back. Every tenant-scoped query must
 * run on THIS client — a query on the outer `db` lands on a different pooled
 * connection with no tenant context and silently returns zero rows.
 */
export type TenantScopedClient = Prisma.TransactionClient;

/**
 * Run `fn` as the authenticated user's tenant.
 *
 * ── WHY THE PARAMETER IS THE USER, NOT THE TENANT ID ───────────────────────
 * This helper previously took `tenantId: string`. That made every call site
 * correct-or-wrong by CONVENTION, and the convention was already broken in two
 * live routes:
 *
 *     geography/regions/route.ts   asTenant(tenantId, …)  where tenantId = parsed.data.tenantId
 *     users/route.ts                asTenant(tenantId, …)  where tenantId = clientTenantId
 *
 * Both were safe only because a 403 gate sat a few lines earlier — a tenant
 * admin's entire isolation resting on an `if` statement away from the call that
 * opens the transaction. One refactor and a request body reaches the database
 * context directly.
 *
 * Taking the user makes that unrepresentable rather than merely discouraged: a
 * request body value cannot satisfy this parameter's type at the call site, so
 * the mistake becomes a COMPILE ERROR instead of a silent cross-tenant context.
 *
 * ── WHY `Pick<SessionUser, "tenantId">` AND NOT THE FULL USER ───────────────
 * `tenantId` is the only field the helper reads. Tightening the type to the
 * whole SessionUser would suggest the helper validates identity, which it does
 * not — and it could not, because a structurally-identical object literal is
 * indistinguishable from a real session user. Requiring the full type would be
 * security theatre: it would look like a control while proving nothing.
 *
 * What actually provides the protection is that a body/query/header value
 * cannot produce this type AT THE CALL SITE. Both versions achieve that; the
 * narrower one just does not overstate what is being checked.
 *
 * Two user types exist in this codebase — `SessionUser` (auth.ts, role:
 * `string`) from `requireAuth()`, and `FgmpUser` (rbac.ts, role: `Role`) from
 * `bootstrap()`. They are NOT mutually assignable: FgmpUser -> SessionUser
 * works, SessionUser -> FgmpUser does not. Typing the parameter as the LOOSER
 * `SessionUser` shape is what lets both be passed, which is why the routes that
 * bind their actor from either source all compile.
 *
 * ── CROSS-TENANT WORK IS DELIBERATELY NOT SUPPORTED HERE ───────────────────
 * There is no variant of this function that accepts an arbitrary tenant id.
 * A super-admin acting for another tenant must go through a separate, named and
 * runtime-checked helper, so that capability is greppable and auditable rather
 * than being a string that happens to be in the right variable.
 */
export function asTenant<T>(
  user: Pick<SessionUser, "tenantId">,
  fn: (tx: TenantScopedClient) => Promise<T>,
): Promise<T> {
  return withTenant(tenantIdOrThrow(user.tenantId), fn);
}

/**
 * Coerce a possibly-absent tenant id to the non-optional form a tenant-scoped
 * call requires, failing CLOSED if there is none.
 *
 * ── WHY NOT `user.tenantId!` ────────────────────────────────────────────────
 * `SessionUser.tenantId` is optional on purpose: a PENDING MFA session must not
 * carry a tenant, and an absent key is falsy so the ~80 existing
 * `user.role === X` checks deny it for free.
 *
 * That optionality must be resolved exactly once — here, where a session
 * becomes a query context. `user.tenantId!` would typecheck while handing
 * `undefined` to `withTenant`, which sets `app.tenant_id` to a non-string and
 * leaves RLS filtering on a NULL context: the caller gets an empty result that
 * reads as "no data" rather than "not allowed".
 *
 * This is also defence in depth. The MFA guard refuses these paths by URL, so
 * if it is ever bypassed or mis-ordered, a tenant-less session still cannot
 * construct a valid tenant context at all.
 */
export function tenantIdOrThrow(tenantId: string | undefined | null): string {
  if (typeof tenantId === "string" && tenantId.trim() !== "") return tenantId.trim();
  throw new Error(
    "[route-tenant] A tenant-scoped call was made without a tenant id. This " +
      "happens when a session is pending multi-factor authentication: such a " +
      "session deliberately carries no tenant and must not be able to query " +
      "anything. Guard the route with the MFA guard, or use the unscoped " +
      "helpers (tenantWhereOrAll / siteTenantWhereOrAll) if cross-tenant read " +
      "is genuinely intended.",
  );
}

/**
 * Run `fn` as ANOTHER tenant — a deliberate, privileged capability.
 *
 * ── WHY THIS IS A SEPARATE NAMED FUNCTION AND NOT A THIRD asTenant FORM ──────
 * The named cross-tenant user-administration routes use this capability to
 * operate on a tenant explicitly named in the request. Operational site and
 * geography writes do not use it; platform operators must use tenant or
 * support control-plane surfaces for customer data.
 *
 * Routing them through `asTenant(user, …)` would be the worst possible outcome:
 * it type-checks and silently redirects a super-admin's cross-tenant write into
 * their OWN tenant. A compile error is recoverable; a super-admin who believes
 * they provisioned a region for tenant B, and did not, is not. That is why
 * these sites were deliberately NOT converted during the signature change
 * rather than swept by it.
 *
 * So the capability is its own name, greppable and reviewable, and it carries its
 * authorization INSIDE the helper rather than relying on a caller to have
 * checked something nearby. A tenant admin reaching this function fails loudly
 * instead of obtaining a cross-tenant context.
 *
 * ── SCOPE OF THE PRIVILEGE ──────────────────────────────────────────────────
 * This grants a database CONTEXT, not an authorisation decision. It does not
 * decide whether the operation should be permitted — that remains the route's
 * own role guard. It ensures that IF a route does decide to act cross-tenant,
 * it cannot do so by accident, and that the route had to name this function in
 * order to try.
 *
 * `Tenant` counts, aggregate metrics and other non-row-bearing platform reads
 * deliberately do NOT belong here — a count is not another tenant's data. Those
 * use the ops connection (see health/route.ts `opsCounts`), which is a different
 * capability with a different justification.
 *
 * ── WHAT THE TYPE DOES AND DOES NOT PREVENT (stated precisely) ─────────────
 * GUARANTEED: a client-supplied value cannot reach the tenant context through
 *             `asTenant`, because body/query/path values do not have a type
 *             that satisfies it.
 * NOT GUARANTEED: an in-code mistake — passing a row, or a hand-built
 *             `{ tenantId }` — still compiles. `Pick<SessionUser, "tenantId">`
 *             accepts any object with a tenantId, which is why this helper's
 *             runtime assertion below matters: it re-checks the ROLE at the point
 *             the privilege is actually exercised, so a wrong object cannot
 *             silently acquire cross-tenant access.
 */
export function asTenantForAnotherTenant<T>(
  user: Pick<SessionUser, "tenantId" | "role">,
  // `string | undefined` on purpose: callers pass `me.tenantId`, which is
  // optional because a PENDING MFA session carries none. Accepting it here and
  // failing below makes the compiler force the caller through this check rather
  // than pushing them to `!` at the call site.
  targetTenantId: string | undefined,
  fn: (tx: TenantScopedClient) => Promise<T>,
): Promise<T> {
  // Inside the helper, not beside it. A caller that forgets to check still gets
  // refused; that is the whole reason this is not a plain string argument to
  // asTenant.
  if (!isSuperAdmin(user.role)) {
    throw new Error(
      "[route-tenant] asTenantForAnotherTenant() requires SUPERADMIN. " +
        `Caller role is ${JSON.stringify(user.role)} and tenantId is ` +
        `${JSON.stringify(tenantIdOrThrow(user.tenantId))}. This helper exists so that a ` +
        `cross-tenant context is a named, reviewable capability rather than a ` +
        `string that happens to be in the right variable. Use asTenant(user, …) ` +
        `for work in the caller's own tenant.`,
    );
  }
  // A super-admin may legitimately pass their own (absent) tenantId when the
  // caller means "the tenant named in the body". Resolving it here — after the
  // capability check, before the transaction — keeps both invariants: the caller
  // gets a clear error rather than an unconstrained `unknown` result, and the
  // cross-tenant capability still requires SUPERADMIN.
  return withTenant(tenantIdOrThrow(targetTenantId), fn);
}

/**
 * Resolve a `:id` path parameter to a row belonging to `tenantId`.
 *
 * Returns null when the row does not exist OR belongs to another tenant —
 * deliberately indistinguishable, so this cannot be used to enumerate whether
 * an id exists in some other tenant. Callers turn that into a plain 404.
 *
 * `tenantColumn` is needed for the handful of tables that reach tenancy
 * indirectly (e.g. via Site); passing the wrong one would scope to nothing.
 */
export async function findOwned<T extends { tenantId: string }>(
  tx: TenantScopedClient,
  tenantId: string,
  model: { findFirst: (args: unknown) => Promise<T | null> },
  id: string,
): Promise<T | null> {
  // Scoped by tenantId in the QUERY, not filtered afterwards. Under RLS the
  // second approach cannot work: the row is never returned to filter.
  const row = await model.findFirst({ where: { id, tenantId } });
  if (!row) return null;
  // Defence in depth. The query above already enforces this; re-checking costs
  // nothing and means a future change to the where clause cannot silently
  // become a cross-tenant read.
  return row.tenantId === tenantId ? row : null;
}

/**
 * Fetch several rows by id, all scoped to `tenantId`.
 *
 * Returns only the rows that belong to the tenant, so a caller cannot tell
 * which of the requested ids were foreign.
 */
export async function findOwnedMany<T extends { tenantId: string }>(
  tx: TenantScopedClient,
  tenantId: string,
  model: { findMany: (args: unknown) => Promise<T[]> },
  ids: string[],
): Promise<T[]> {
  if (ids.length === 0) return [];
  const rows = await model.findMany({ where: { id: { in: ids }, tenantId } });
  return rows.filter((r) => r.tenantId === tenantId);
}
/**
 * Resolve which tenant a request acts for, when the caller is allowed to name it.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A super-admin's session carries ONE tenant (`t-platform`, the tenant that owns
 * platform accounts). Every helper above is built on that assumption, so a
 * super-admin listing users "cross-tenant" through `tenantWhereOrAll() inside
 * asTenant(me, …)` actually got the platform tenant's users and a silent, wrong
 * answer — the same class of bug as the audit route.
 *
 * The fix is NOT to let the session wander. It is to require the caller to NAME
 * the tenant explicitly, and to funnel that name through the helper that already
 * re-checks SUPERADMIN at the point the privilege is used
 * (`asTenantForAnotherTenant`). A tenant admin that supplies `?tenant=` is
 * ignored rather than refused: their own scope is the only legal one, and
 * "ignore" cannot be turned into an oracle for whether a tenant id exists.
 *
 * Returns a tenant id plus a `run` that opens the right context. Callers should
 * prefer `run` over inspecting `tenantId`, because `tenantId` is informational
 * (used for audit rows) while `run` is what actually applies the policy.
 */
export function resolveTenantScope(
  user: Pick<SessionUser, "tenantId" | "role">,
  requestedTenantId?: string | null,
): { tenantId: string; crossTenant: boolean; run: <T>(fn: (tx: TenantScopedClient) => Promise<T>) => Promise<T> } {
  const own = tenantIdOrThrow(user.tenantId);
  const requested = typeof requestedTenantId === "string" ? requestedTenantId.trim() : "";
  if (!requested || requested === own) {
    return { tenantId: own, crossTenant: false, run: (fn) => withTenant(own, fn) };
  }
  if (!isSuperAdmin(user.role)) {
    // Ignoring the request is the safe answer, and it is also the honest one:
    // the caller cannot distinguish "tenant exists but you may not use it" from
    // "tenant does not exist" here, so no enumeration.
    return { tenantId: own, crossTenant: false, run: (fn) => withTenant(own, fn) };
  }
  return {
    tenantId: requested,
    crossTenant: true,
    // Re-checks SUPERADMIN inside, so the privilege cannot be obtained by
    // reaching this line with a hand-built object.
    run: (fn) => asTenantForAnotherTenant(user, requested, fn),
  };
}
