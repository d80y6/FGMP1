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
  return withTenant(user.tenantId, fn);
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