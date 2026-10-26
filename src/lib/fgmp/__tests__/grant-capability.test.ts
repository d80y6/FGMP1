/**
 * `user:grant-superadmin` — the declared capability is the enforced rule.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * `user:grant-superadmin` sat in `SUPERADMIN_ONLY_CAPABILITIES` (rbac-core.ts)
 * from the day that list was written and was enforced NOWHERE. The decision "may
 * this actor hand out the platform role?" was answered by comparing the role
 * STRING to `"SUPERADMIN"` in four independent places:
 *
 *   POST   /api/fgmp/users          `!isSuperAdminUser(me) && role === "SUPERADMIN"`
 *   PUT    /api/fgmp/users/[id]     `!isSuperAdminUser(me) && parsed.data.role === "SUPERADMIN"`
 *   lib/grant-guards.ts             `const isSuper = (role) => role === "SUPERADMIN"`
 *   users-view.tsx (create + edit)  `meRole === "SUPERADMIN"`
 *
 * All four agree today, which is exactly why the drift was invisible — and why
 * it would have stayed invisible. The matrix said one thing; the enforcement said
 * another; nothing compared them. Give a hypothetical second platform role this
 * capability and the four comparisons above would ignore it, while the nav and
 * `canAccessApi` (which ARE matrix-driven) would start showing that role the
 * platform surfaces. That is the failure mode the parity test exists to prevent,
 * and it cannot see this one because it only reads route guards and nav.
 *
 * So the decision is now asked of the matrix in all four places, and this file
 * asserts the two properties that make that real:
 *
 *   1. BEHAVIOUR — for every role, `evaluateGrantChange()` allows granting the
 *      platform role iff that role holds the capability. Derived over ALL_ROLES,
 *      so a matrix edit and an enforcement edit cannot diverge silently.
 *   2. WIRING — the four call sites ask the capability, not the role name. A
 *      behavioural test cannot see the dialogs or the route guards (they need a
 *      database and a browser), so the wiring is checked as source, in the same
 *      spirit as `route-authorization-contract.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ROLES, hasCapability, isSuperAdmin } from "../rbac-core";
import { evaluateGrantChange, type GrantChange } from "../grant-guards";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const GRANT_CAPABILITY = "user:grant-superadmin";

function change(overrides: Partial<GrantChange> = {}): GrantChange {
  return {
    actorId: "u-actor",
    actorRole: "ADMIN",
    targetId: "u-target",
    targetRole: "NOC_OPERATOR",
    targetActive: true,
    otherActiveAdminsInTenant: 1,
    otherActiveSuperAdmins: 1,
    ...overrides,
  };
}

describe("the capability decides who may grant the platform role", () => {
  test("for every role: allowed iff it holds user:grant-superadmin", () => {
    const mismatched: string[] = [];
    for (const role of ALL_ROLES) {
      // A promotion by that actor, of somebody else (self-changes refuse for a
      // different reason and would mask the answer).
      const refusal = evaluateGrantChange(change({ actorRole: role, newRole: "SUPERADMIN" }));
      const holder = hasCapability(role, GRANT_CAPABILITY);
      const allowed = refusal === null;
      if (allowed !== holder) {
        mismatched.push(
          `${role}: capability=${holder}, guard=${allowed ? "allowed" : refusal?.code}`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  test("and only the platform role holds it — the two families stay separate", () => {
    const holders = ALL_ROLES.filter((role) => hasCapability(role, GRANT_CAPABILITY));
    expect(holders).toEqual(ALL_ROLES.filter((role) => isSuperAdmin(role)));
    expect(holders).toEqual(["SUPERADMIN"]);
  });

  test("a tenant administrator is still refused with the documented code", () => {
    // The code is part of the contract: `users-view.tsx` maps it to a toast and
    // the API documents it. Changing it silently breaks the message, not the
    // protection — which is the kind of break nobody notices.
    expect(evaluateGrantChange(change({ actorRole: "ADMIN", newRole: "SUPERADMIN" }))).toMatchObject({
      status: 403,
      code: "CANNOT_TOUCH_SUPERADMIN",
    });
  });

  test("touching an EXISTING super-admin is the same decision, from the other side", () => {
    // Demoting or deactivating a platform account is the inbound half of the
    // same boundary; the guard must use the same predicate for both.
    for (const role of ALL_ROLES) {
      const refusal = evaluateGrantChange(
        change({ actorRole: role, targetRole: "SUPERADMIN", targetId: "u-super", newActive: false }),
      );
      const holder = hasCapability(role, GRANT_CAPABILITY);
      if (holder) expect(refusal).toBeNull();
      else expect(refusal?.code).toBe("CANNOT_TOUCH_SUPERADMIN");
    }
  });

  test("an unknown or forged role string grants nothing", () => {
    // `actorRole` comes from a session claim. A role name that is not in the
    // union must fail closed rather than fall through a record lookup.
    const refusal = evaluateGrantChange(
      change({ actorRole: "PLATFORM_WIZARD" as never, newRole: "SUPERADMIN" }),
    );
    expect(refusal?.code).toBe("CANNOT_TOUCH_SUPERADMIN");
  });
});

describe("every place that offers or performs the grant asks the capability", () => {
  test("POST /api/fgmp/users", () => {
    const source = read("src/app/api/fgmp/users/route.ts");
    expect(source).toContain(`can(me, "${GRANT_CAPABILITY}")`);
    // The old role-string form must be gone: a leftover copy would be a second
    // decision that nobody would think to update.
    expect(source).not.toContain('!superAdmin && role === "SUPERADMIN"');
  });

  test("PUT /api/fgmp/users/[id]", () => {
    const source = read("src/app/api/fgmp/users/[id]/route.ts");
    expect(source).toContain(`can(me, "${GRANT_CAPABILITY}")`);
    expect(source).not.toContain('!isSuperAdminUser(me) && parsed.data.role === "SUPERADMIN"');
  });

  test("grant-guards.ts — the shared rule both mutations and PATCH go through", () => {
    const source = read("src/lib/fgmp/grant-guards.ts");
    expect(source).toContain("hasCapability");
    expect(source).toContain(GRANT_CAPABILITY);
    // Only the ACTOR predicate is forbidden. The file keeps comparing the
    // TARGET's role to "SUPERADMIN" — that is a fact about the row being edited,
    // not a permission question — and the count query filters on it.
    expect(source).not.toContain('const isSuper = (role: string | undefined) => role === "SUPERADMIN"');
    expect(source).toContain("actorMayGrantPlatformRole");
  });

  test("the create dialog offers the platform role only with the capability", () => {
    const source = read("src/components/fgmp/views/users-view.tsx");
    expect(source).toContain(`hasCapability(meRole, "${GRANT_CAPABILITY}")`);
    expect(source).toContain("excludeSuperAdmin={!canGrantSuperAdmin}");
  });

  test("the edit dialog requires the capability AND the platform placement", () => {
    const source = read("src/components/fgmp/views/users-view.tsx");
    // Both conditions, in this order: the capability is authority, the placement
    // is the invariant that promotion must not create standing access to a
    // customer tenant. Either one alone is wrong.
    expect(source).toContain(
      "canGrantSuperAdmin && platformTenantId !== null && target?.tenantId === platformTenantId",
    );
  });

  test("the tenant picker is gated on the capability its endpoint requires", () => {
    // GET /api/fgmp/tenants is behind `view:tenants`. The create dialog used to
    // show the picker for `meRole === "SUPERADMIN"` and fetch the list
    // unconditionally — the same answer today, but a request a role without the
    // capability should never make.
    const source = read("src/components/fgmp/views/users-view.tsx");
    expect(source).toContain('hasCapability(meRole, "view:tenants")');
    expect(source).toContain('canNameTenant ? "/api/fgmp/tenants" : null');
  });
});
