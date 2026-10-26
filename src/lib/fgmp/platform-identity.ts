/**
 * Where a SUPERADMIN account is allowed to live.
 *
 * ── THE INVARIANT, AND WHY IT IS NOT COSMETIC ──────────────────────────────
 * `docs/SUPERADMIN.md` and `docs/SECURITY.md` state the same thing in two ways:
 * a super-admin's ordinary session is scoped to the platform tenant, and
 * customer content is reachable only through a time-boxed, audited support
 * session. Both sentences rest on one structural assumption:
 *
 *     every SUPERADMIN account belongs to t-platform.
 *
 * Nothing in the schema says that. `User.tenantId` is a plain column, and a
 * super-admin's session context is whatever that column holds (`asTenant(me, …)`
 * → `withTenant(me.tenantId)` → `SET LOCAL app.tenant_id`). So a SUPERADMIN row
 * whose tenant is a CUSTOMER tenant is not a configuration quirk — it is a
 * permanent, ambient read of that customer's operational data: `/api/fgmp/state`,
 * every list route, every detail route, with no support session, no stated
 * reason, no expiry, and nothing recorded in the customer's audit log. That is
 * precisely the standing cross-tenant access the support-session design exists
 * to eliminate (option "A" in `support-session.ts`, rejected there).
 *
 * ── WHY THE ROUTES DID NOT ALREADY ENFORCE IT ──────────────────────────────
 * `POST /api/fgmp/users` defaulted a new super-admin's tenant to `t-platform`
 * and the create dialog disabled the tenant picker for that role, so the
 * ordinary path was correct. `PUT /api/fgmp/users/[id]` had no check at all:
 * an existing user in ANY tenant could be promoted to SUPERADMIN in place, and
 * the edit dialog offered the option, so this was reachable from the shipped UI
 * — not merely by hand-rolling a request.
 *
 * ── WHY THE ANSWER IS "REFUSE", NOT "MOVE THE USER" ────────────────────────
 * Silently relocating an account to `t-platform` would change which tenant's
 * data its owner can see, as a side effect of a role edit. That is a tenant
 * reassignment performed by nobody, reported by nothing, and it would let a
 * caller "promote" a customer's administrator into the platform tenant — the
 * most surprising possible outcome of a role dropdown. Refusing is the only
 * answer that keeps the operator's model true: a super-admin account is created
 * in the platform tenant, and an account elsewhere stays where it is.
 *
 * This module is pure so both rules can be tested without a database — which is
 * the only way they can be tested at all in this repository's sandbox.
 */

/**
 * The one tenant that may own SUPERADMIN accounts.
 *
 * `t-platform` is seeded in `src/lib/fgmp/seed.ts` as an ordinary tenant to RLS:
 * it has no special policy and no bypass. Its only privilege is social — the
 * platform accounts live in it, so "a super-admin's session" and "a customer's
 * data" never point at the same `app.tenant_id`.
 */
export const PLATFORM_TENANT_ID = "t-platform";

/** A refusal shape the routes can turn into a response without re-deciding. */
export interface PlacementRefusal {
  status: 400;
  code: "SUPERADMIN_TENANT_FIXED";
  error: string;
}

export type SuperAdminPlacement =
  | { ok: true; tenantId: string }
  | ({ ok: false } & PlacementRefusal);

/**
 * Which tenant a NEW super-admin account is created in.
 *
 * `requested` is the client-supplied `tenantId` (optional). The rules:
 *
 *   - nothing requested        → the platform tenant (the default the UI has
 *                                always relied on);
 *   - the platform tenant      → the platform tenant (explicit and correct);
 *   - any other tenant         → refused, naming the rule.
 *
 * Refusing rather than ignoring matters: a caller who asked for a customer
 * tenant must be told that the request was not honoured, because the alternative
 * is an account that exists and is not where they believe it is.
 */
export function superAdminPlacement(requested?: string | null): SuperAdminPlacement {
  const named = typeof requested === "string" ? requested.trim() : "";
  if (named === "" || named === PLATFORM_TENANT_ID) {
    return { ok: true, tenantId: PLATFORM_TENANT_ID };
  }
  return {
    ok: false,
    status: 400,
    code: "SUPERADMIN_TENANT_FIXED",
    error:
      `A super-admin account must belong to the platform tenant (${PLATFORM_TENANT_ID}); ` +
      `it cannot be created in tenant ${named}. An account whose tenant is a customer ` +
      `would read that customer's data from its ordinary session, permanently — the ` +
      `standing access the support-session model exists to avoid. Create the account in ` +
      `the platform tenant, then use a support session for cross-tenant work.`,
  };
}

/**
 * Why an EXISTING user may not be promoted to SUPERADMIN, or null when it may.
 *
 * Promotion changes authority, not location: the row stays in the tenant it was
 * read from. So the rule is a check on the target's CURRENT tenant — the tenant
 * the promoting request is scoped to, which is the platform tenant for every
 * legitimate call and a customer tenant for the case this refuses.
 */
export function superAdminPromotionRefusal(existingTenantId: string): PlacementRefusal | null {
  if (existingTenantId === PLATFORM_TENANT_ID) return null;
  return {
    status: 400,
    code: "SUPERADMIN_TENANT_FIXED",
    error:
      `This account belongs to tenant ${existingTenantId}, so it cannot be promoted to ` +
      `super-admin in place: a super-admin's session is scoped to its own tenant, and the ` +
      `role would give it permanent access to that tenant's operational data with no ` +
      `support session, no reason and no expiry. Super-admin accounts belong to ` +
      `${PLATFORM_TENANT_ID}; create one there instead.`,
  };
}

/** The platform tenant id a client may compare against, or null when the
 *  caller is not a super-admin. Exposed by `GET /api/fgmp/me` so the user
 *  editor can hide an option the server would refuse — the client rule and the
 *  server rule are then the same rule, stated once here. */
export function platformTenantIdFor(isSuperAdmin: boolean): string | null {
  return isSuperAdmin ? PLATFORM_TENANT_ID : null;
}
