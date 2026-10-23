import { describe, it, expect } from "bun:test";
import { evaluateGrantChange, removesRole, type GrantChange } from "../grant-guards";

function change(overrides: Partial<GrantChange> = {}): GrantChange {
  return {
    actorId: "u-admin",
    actorRole: "ADMIN",
    targetId: "u-target",
    targetRole: "NOC_OPERATOR",
    targetActive: true,
    otherActiveAdminsInTenant: 1,
    otherActiveSuperAdmins: 1,
    ...overrides,
  };
}

describe("grant guards — self-grant", () => {
  it("refuses an administrator changing their own role", () => {
    const refusal = evaluateGrantChange(
      change({ actorId: "u-admin", targetId: "u-admin", targetRole: "ADMIN", newRole: "SUPERADMIN" }),
    );
    expect(refusal).toMatchObject({ status: 403, code: "CANNOT_CHANGE_OWN_ROLE" });
  });

  it("refuses even a self-demotion — the trail must name a second party", () => {
    expect(
      evaluateGrantChange(change({ actorId: "u-admin", targetId: "u-admin", targetRole: "ADMIN", newRole: "READONLY" })),
    ).toMatchObject({ code: "CANNOT_CHANGE_OWN_ROLE" });
  });

  it("allows editing your own non-role fields", () => {
    expect(evaluateGrantChange(change({ actorId: "u-admin", targetId: "u-admin" }))).toBeNull();
  });

  it("allows changing somebody else's role", () => {
    expect(evaluateGrantChange(change({ newRole: "FIELD_ENGINEER" }))).toBeNull();
  });
});

describe("grant guards — the super-admin boundary", () => {
  it("refuses a tenant admin promoting anybody to SUPERADMIN", () => {
    expect(evaluateGrantChange(change({ newRole: "SUPERADMIN" }))).toMatchObject({
      status: 403,
      code: "CANNOT_TOUCH_SUPERADMIN",
    });
  });

  it("refuses a tenant admin touching an existing SUPERADMIN", () => {
    expect(
      evaluateGrantChange(change({ targetRole: "SUPERADMIN", targetId: "u-super", newActive: false })),
    ).toMatchObject({ code: "CANNOT_TOUCH_SUPERADMIN" });
  });

  it("allows a super-admin to promote somebody", () => {
    expect(
      evaluateGrantChange(change({ actorRole: "SUPERADMIN", newRole: "ADMIN", otherActiveAdminsInTenant: 0 })),
    ).toBeNull();
  });
});

describe("grant guards — last administrator", () => {
  it("refuses demoting the last active tenant administrator", () => {
    expect(
      evaluateGrantChange(
        change({ targetRole: "ADMIN", newRole: "READONLY", otherActiveAdminsInTenant: 0 }),
      ),
    ).toMatchObject({ status: 409, code: "LAST_TENANT_ADMIN" });
  });

  it("refuses DEACTIVATING the last active tenant administrator", () => {
    // The original bug class: role changes were guarded, the active flag was
    // not, and `active = false` removes an administrator just as thoroughly.
    expect(
      evaluateGrantChange(
        change({ targetRole: "ADMIN", newActive: false, otherActiveAdminsInTenant: 0 }),
      ),
    ).toMatchObject({ code: "LAST_TENANT_ADMIN" });
  });

  it("allows it when another administrator remains", () => {
    expect(
      evaluateGrantChange(
        change({ targetRole: "ADMIN", newRole: "READONLY", otherActiveAdminsInTenant: 2 }),
      ),
    ).toBeNull();
  });

  it("does not care about non-admin targets", () => {
    expect(
      evaluateGrantChange(
        change({ targetRole: "NOC_OPERATOR", newActive: false, otherActiveAdminsInTenant: 0 }),
      ),
    ).toBeNull();
  });

  it("allows removing an admin when that admin is already inactive", () => {
    // An inactive administrator is not one of the "active admins", so demoting
    // them cannot change the count.
    expect(
      evaluateGrantChange(
        change({
          targetRole: "ADMIN",
          targetActive: false,
          newRole: "READONLY",
          // Zero other active admins: the point is that this target was never
          // counted as one, so the rule does not fire.
          otherActiveAdminsInTenant: 0,
        }),
      ),
    ).toBeNull();
  });
});

describe("grant guards — last super-admin", () => {
  it("refuses demoting the last super-admin", () => {
    expect(
      evaluateGrantChange(
        change({
          actorRole: "SUPERADMIN",
          actorId: "u-super-2",
          targetId: "u-super",
          targetRole: "SUPERADMIN",
          newRole: "ADMIN",
          otherActiveSuperAdmins: 0,
        }),
      ),
    ).toMatchObject({ status: 409, code: "LAST_SUPERADMIN" });
  });

  it("allows it when another super-admin remains", () => {
    expect(
      evaluateGrantChange(
        change({
          actorRole: "SUPERADMIN",
          actorId: "u-super-2",
          targetId: "u-super",
          targetRole: "SUPERADMIN",
          newRole: "ADMIN",
          otherActiveSuperAdmins: 1,
        }),
      ),
    ).toBeNull();
  });
});

describe("grant guards — removesRole", () => {
  it("detects a demotion and a deactivation, and ignores a no-op", () => {
    expect(removesRole({ role: "ADMIN", active: true }, { role: "READONLY" })).toBe(true);
    expect(removesRole({ role: "ADMIN", active: true }, { active: false })).toBe(true);
    expect(removesRole({ role: "ADMIN", active: true }, { active: true })).toBe(false);
    expect(removesRole({ role: "ADMIN", active: true }, { role: "ADMIN" })).toBe(false);
    expect(removesRole({ role: "NOC_OPERATOR", active: true }, { role: "READONLY" })).toBe(false);
  });
});
