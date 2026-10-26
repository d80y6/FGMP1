/**
 * Rules about who may change whose privileges.
 *
 * ── WHY THESE RULES LIVE IN ONE PURE FUNCTION ──────────────────────────────
 * Privilege changes are the highest-value action in the system: one request
 * turns an ordinary account into a tenant administrator, or removes the last
 * administrator a tenant has. Three routes can each perform part of that — PUT
 * (role), PATCH (active), DELETE (soft-delete) — and the rules must be identical
 * on all three. Previously each route re-checked only the super-admin boundary,
 * so:
 *
 *   * an admin could change their OWN role (self-promotion was blocked only by
 *     the fact that SUPERADMIN was already refused — every other role was
 *     reachable);
 *   * a tenant could deactivate its last administrator, leaving nobody able to
 *     create users, rotate API keys or change settings. Recovery then requires
 *     database access, which is exactly the situation a control is supposed to
 *     prevent.
 *
 * `evaluateGrantChange()` is pure and total: it returns a refusal or null, and
 * takes the counts it needs as inputs. That makes every rule testable without a
 * database, and makes it impossible for a route to "mostly" apply them.
 *
 * ── THE SPLIT OF RESPONSIBILITY ────────────────────────────────────────────
 * Pure rules here; counting in `countTenantAdmins` / `countPlatformSuperAdmins`
 * below (which need the database); wiring in the user routes. The count is
 * passed in because the caller already has a transaction open, and because a
 * count computed inside a decision function could observe a different snapshot
 * than the write it guards.
 */

import { ALL_ROLES, hasCapability, type Role } from "./rbac-core";

export interface GrantRefusal {
  status: number;
  code: string;
  error: string;
}

export interface GrantChange {
  /** The actor performing the change. */
  actorId: string;
  actorRole: string | undefined;
  /** The current state of the target account. */
  targetId: string;
  targetRole: string;
  targetActive: boolean;
  /** The requested new role, if role is being changed. */
  newRole?: string;
  /** The requested new active flag, if it is being changed. */
  newActive?: boolean;
  /**
   * Number of OTHER active administrators in the target's tenant.
   * Only read when the change would remove the target from the ADMIN set.
   */
  otherActiveAdminsInTenant: number;
  /**
   * Number of OTHER active super-admins platform-wide. Only read when the
   * change would remove the target from the SUPERADMIN set.
   */
  otherActiveSuperAdmins: number;
}

/**
 * "May this actor hand out the platform role?" — asked of the CAPABILITY, not
 * of the role name.
 *
 * These rules used to compare `role === "SUPERADMIN"` directly. That is the same
 * answer today (SUPERADMIN holds `*` and no other role holds this key) but it is
 * the wrong QUESTION, and the difference matters the moment a second platform
 * role exists: `user:grant-superadmin` is declared in
 * `SUPERADMIN_ONLY_CAPABILITIES` precisely so that "who may grant the platform
 * role" has ONE answer, in ONE place. A string comparison here would silently
 * ignore a matrix edit, and
 * `__tests__/platform-tier-parity.test.ts` deliberately fails when the declared
 * capability and the enforced behaviour disagree. Asking the matrix means the
 * matrix is the source of truth, which is the property that test exists to keep.
 *
 * `Role` is a closed union, so an unknown string (a forged or stale role) is
 * normalised to READONLY — the deny-everything end of the union — rather than
 * being looked up in a record that would return `undefined`.
 */
const ROLE_UNION: readonly Role[] = ALL_ROLES;

function actorMayGrantPlatformRole(role: string | undefined): boolean {
  const known = ROLE_UNION.find((r) => r === role);
  return known ? hasCapability(known, "user:grant-superadmin") : false;
}

const isSuper = actorMayGrantPlatformRole;

/**
 * Decide whether a privilege/state change may proceed.
 *
 * Order matters: the cheap, absolute rules (self-change, super-admin boundary)
 * come before the counting rules, so the common refusal never depends on a
 * count that could be stale.
 */
export function evaluateGrantChange(change: GrantChange): GrantRefusal | null {
  const roleIsChanging = change.newRole !== undefined && change.newRole !== change.targetRole;
  const activeIsChanging = change.newActive !== undefined && change.newActive !== change.targetActive;
  // `targetActive` matters: demoting an ALREADY-INACTIVE administrator cannot
  // reduce the number of active ones, so the last-administrator rule must not
  // fire. Without this, a tenant with a single active admin could not clean up
  // an old inactive admin account.
  const removingSuper = change.targetActive && change.targetRole === "SUPERADMIN" &&
    ((roleIsChanging && change.newRole !== "SUPERADMIN") || (activeIsChanging && change.newActive === false));
  const removingAdmin = change.targetActive && change.targetRole === "ADMIN" &&
    ((roleIsChanging && change.newRole !== "ADMIN") || (activeIsChanging && change.newActive === false));

  // 1. Nobody changes their own role. This is not about trust — it is about the
  //    audit trail. A self-grant has no second party in it, so the record reads
  //    "X promoted X", which no review can distinguish from an account
  //    compromise.
  if (roleIsChanging && change.actorId === change.targetId) {
    return {
      status: 403,
      code: "CANNOT_CHANGE_OWN_ROLE",
      error:
        "You cannot change your own role. Ask another administrator to make the change, so the audit trail names a second party.",
    };
  }

  // 2. The platform boundary, stated once for both directions.
  if (!isSuper(change.actorRole)) {
    if (change.targetRole === "SUPERADMIN" || (roleIsChanging && change.newRole === "SUPERADMIN")) {
      return {
        status: 403,
        code: "CANNOT_TOUCH_SUPERADMIN",
        error: "Only a super-admin can grant or modify the super-admin role.",
      };
    }
  }

  // 3. The last administrator of a tenant cannot be demoted or deactivated.
  //    Checked on BOTH role and active flag: `active = false` removes the
  //    administrator just as effectively as a demotion.
  if (removingAdmin && change.otherActiveAdminsInTenant === 0) {
    return {
      status: 409,
      code: "LAST_TENANT_ADMIN",
      error:
        "This is the last active administrator for the tenant. Promote another administrator first: without one, nobody can manage users, settings or API keys for this tenant.",
    };
  }

  // 4. The last super-admin of the platform cannot be removed either. Same
  //    reasoning, one level up: the platform would lose its only account able
  //    to create tenants and tenant administrators.
  if (removingSuper && change.otherActiveSuperAdmins === 0) {
    return {
      status: 409,
      code: "LAST_SUPERADMIN",
      error:
        "This is the last active super-admin on the platform. Create another super-admin before demoting or deactivating this one.",
    };
  }

  return null;
}

/** True when `change` would move the target out of the role it currently holds
 *  (including via the active flag). Used to decide whether a count is needed
 *  before calling the pure function. */
export function removesRole(
  target: { role: string; active: boolean },
  next: { role?: string; active?: boolean },
): boolean {
  const roleChanges = next.role !== undefined && next.role !== target.role;
  const deactivates = next.active !== undefined && next.active === false && target.active;
  if (target.role === "ADMIN") return roleChanges || deactivates;
  if (target.role === "SUPERADMIN") return roleChanges || deactivates;
  return false;
}

// ── Counting ─────────────────────────────────────────────────────────────────
// These need the database, so they are deliberately kept OUT of the decision
// function above. The caller passes the transaction client it will write with,
// so the count and the write observe the same snapshot.

/** Minimal shape of the Prisma client these helpers use — enough to type the
 *  call without importing the generated client (which a test process may not
 *  have). */
interface UserCounter {
  user: { count: (args: { where: Record<string, unknown> }) => Promise<number> };
}

/**
 * Active administrators in `tenantId` other than `excludeUserId`.
 *
 * Run inside the caller's tenant transaction: `User` is FORCE-RLS protected, so
 * an unscoped count returns 0 and would make every tenant look as though it had
 * no administrators — the check would then refuse every change, which is safe
 * but useless. (Verified: the scoped count is the only one that returns a
 * sensible number.)
 */
export function countOtherActiveTenantAdmins(
  tx: UserCounter,
  tenantId: string,
  excludeUserId: string,
): Promise<number> {
  return tx.user.count({
    where: { tenantId, role: "ADMIN", active: true, id: { not: excludeUserId } },
  });
}

/**
 * Active super-admins platform-wide, other than `excludeUserId`.
 *
 * There is no cross-tenant read path as `fgmp_app`, and deliberately so. This
 * fans out one scoped count per tenant, which is O(tenants) — acceptable for a
 * rare check on a privileged account, and it keeps the invariant that nothing
 * reads across tenants without setting a context first.
 */
export async function countOtherActiveSuperAdmins(excludeUserId: string): Promise<number> {
  const { db } = await import("@/lib/db");
  const { withTenant } = await import("./tenant-context");
  const tenants = await db.tenant.findMany({ select: { id: true } });
  let total = 0;
  for (const t of tenants) {
    total += await withTenant(t.id, (tx) =>
      tx.user.count({
        where: { tenantId: t.id, role: "SUPERADMIN", active: true, id: { not: excludeUserId } },
      }),
    );
  }
  return total;
}
