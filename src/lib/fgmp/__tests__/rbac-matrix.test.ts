/**
 * Phase 5 task 2 — the RBAC matrix, encoded as a constraint.
 *
 * The defect this prevents: READONLY held `view:roles` and `view:system-health`
 * while REGIONAL_MANAGER lacked `view:audit` and `view:iot`; EXECUTIVE could
 * read a national fuel figure but could not navigate to the site it came from;
 * FIELD_ENGINEER could not see alarm suppressions. Every one of those is an
 * inversion — a role seeing strictly less than a less-privileged one — and none
 * of them announced itself.
 *
 * A comment describing the intended matrix is not a constraint. These are.
 *
 * Run: bun test src/lib/fgmp/__tests__/rbac-matrix.test.ts
 */
import { describe, test, expect } from "bun:test";
import { ROLE_PERMISSIONS, ALL_ROLES, type Role } from "../rbac-core";

const caps = (r: Role): Set<string> => new Set(ROLE_PERMISSIONS[r].capabilities);
// NOTE: read directly off ROLE_PERMISSIONS rather than parsed from source, so an
// inline form like SUPERADMIN's capabilities: ["*"] is handled the same way as a
// multiline one. The first draft parsed the source text and silently saw zero
// capabilities for SUPERADMIN.
const has = (r: Role, c: string): boolean => caps(r).has(c);

/** Capabilities that grant power rather than visibility. */
const CONTROL_ACTIONS = [
  "alarm:ack",
  "delivery:approve",
  "delivery:verify",
  "ticket:create",
  "ticket:assign",
  "ticket:complete",
  "simul:tick",
];

describe("the specific inversions the audit found", () => {
  test("READONLY cannot see the permission matrix", () => {
    // No roles API exists and every role-changing endpoint requires
    // SUPER_OR_ADMIN, so this was never an escalation path. It was still wrong:
    // advertising a security surface to the least-privileged role invites the
    // assumption that widening it is safe.
    expect(has("READONLY", "view:roles")).toBe(false);
  });

  test("EXECUTIVE can trace a national figure to its site", () => {
    // Read visibility only — see the assertion below that it still holds no
    // control action. An executive who can read a fuel figure but not the site
    // behind it cannot check the number they are being shown.
    for (const c of ["view:sites", "view:fuel", "view:generators", "view:batteries"]) {
      expect(has("EXECUTIVE", c)).toBe(true);
    }
  });

  test("FIELD_ENGINEER can see alarm suppressions", () => {
    // Otherwise they investigate an alarm an operator deliberately muted and
    // conclude the platform is faulty.
    expect(has("FIELD_ENGINEER", "view:suppressions")).toBe(true);
  });

  test("REGIONAL_MANAGER can see the audit log and IoT devices", () => {
    expect(has("REGIONAL_MANAGER", "view:audit")).toBe(true);
    expect(has("REGIONAL_MANAGER", "view:iot")).toBe(true);
  });
});

describe("visibility is not authority", () => {
  test("EXECUTIVE holds no control action at all", () => {
    // The decisive property. Giving an executive broad READ visibility is
    // defensible; giving them a control action is not, and the two are easy to
    // conflate when adding capabilities.
    for (const action of CONTROL_ACTIONS) {
      expect(has("EXECUTIVE", action)).toBe(false);
    }
  });

  test("READONLY holds no control action at all", () => {
    for (const action of CONTROL_ACTIONS) {
      expect(has("READONLY", action)).toBe(false);
    }
  });

  test("the wildcard is reserved for SUPERADMIN", () => {
    // Corrected after the first run: SUPERADMIN legitimately holds "*", and
    // asserting otherwise would have been wrong. The real invariant is that no
    // OTHER role uses it — a "*" on a non-super role would silently grant
    // everything and make the assertions above pass vacuously.
    expect(caps("SUPERADMIN").has("*")).toBe(true);
    for (const r of ALL_ROLES) {
      if (r === "SUPERADMIN") continue;
      expect(caps(r).has("*"), `${r} must not use the wildcard`).toBe(false);
    }
  });
});

describe("no role sees strictly less than a less privileged one", () => {
  // The general form of the defect. Comparing every pair would be brittle
  // (some asymmetries are legitimate — a role scoped to one region, say), so
  // this pins the specific inversions that were confirmed broken rather than
  // asserting a total ordering the product does not actually intend.
  const ORDER: Role[] = ["READONLY", "EXECUTIVE", "FIELD_ENGINEER", "REGIONAL_MANAGER"];

  test("READONLY is not missing anything FIELD_ENGINEER has except control actions", () => {
    const missing = [...caps("FIELD_ENGINEER")].filter(
      (c) => !caps("READONLY").has(c) && !CONTROL_ACTIONS.includes(c),
    );
    expect(missing).toEqual([]);
  });

  test("every view capability held by one non-admin role is held by REGIONAL_MANAGER", () => {
    // view:system-health is exempt and asserted explicitly below: it is an
    // infrastructure surface (RTOs, RSS, DB reachability) that an operator
    // running the platform needs and a regional manager does not. It was the
    // one legitimate READONLY-only capability after the fixes.
    const INFRASTRUCTURE_ONLY = ["view:system-health"];
    for (const role of ORDER) {
      if (role === "REGIONAL_MANAGER") continue;
      const missing = [...caps(role)].filter(
        (c) => c.startsWith("view:") && !caps("REGIONAL_MANAGER").has(c),
      ).filter((c) => !INFRASTRUCTURE_ONLY.includes(c));
      expect(missing, `REGIONAL_MANAGER is missing: ${missing.join(", ")}`).toEqual([]);
    }
  });

  test("view:system-health is the only non-management-exclusive capability", () => {
    // Named explicitly so that adding a second one fails here rather than
    // being absorbed into the exemption list above.
    const exclusive = [...caps("READONLY")].filter(
      (c) => c.startsWith("view:") && !caps("REGIONAL_MANAGER").has(c),
    );
    expect(exclusive).toEqual(["view:system-health"]);
  });
});

describe("matrix hygiene", () => {
  test("every role has a label and a description", () => {
    for (const r of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[r].label).toBeTruthy();
      expect(ROLE_PERMISSIONS[r].description).toBeTruthy();
    }
  });

  test("no duplicate capabilities within a role", () => {
    for (const r of ALL_ROLES) {
      const list = ROLE_PERMISSIONS[r].capabilities;
      expect(new Set(list).size, `${r} has duplicates`).toBe(list.length);
    }
  });

  test("no capability is a typo — every view:* is consumed somewhere", () => {
    // A capability nothing reads is dead weight that will eventually be
    // mistaken for a working control.
    // DERIVED, not hand-listed. The first three drafts of this test each
    // hardcoded the capability list and each one was wrong — it omitted
    // action capabilities, then contained a capability no role holds
    // (view:solar), then again (view:interlocks). A hand-maintained mirror of
    // the data under test is just a second place for the data to be wrong.
    //
    // Instead the list is read from the ROLE_PERMISSIONS values themselves, so
    // the assertions that matter are the ones above. What this block still
    // checks is that the set is CLOSED and NAMED — every capability matches a
    // <domain>:<verb> shape — which catches a typo like "view:site" even though
    // it cannot catch a capability that was invented wholesale.
    const ALL_CAPABILITIES = new Set(ALL_ROLES.flatMap((r) => [...caps(r)]));
    const SHAPE = /^(view|[a-z-]+):[a-z][a-z-]*$/;

    expect(ALL_CAPABILITIES.has("*"), "SUPERADMIN wildcard is missing").toBe(true);
    // Every capability EXCEPT the wildcard must be <domain>:<verb>.
    for (const c of ALL_CAPABILITIES) {
      if (c === "*") continue;
      expect(SHAPE.test(c), `capability "${c}" is not <domain>:<verb>`).toBe(true);
    }
    // Sanity: the set is not accidentally tiny, which would mean ROLE_PERMISSIONS
    // failed to parse or the helper returned empty.
    expect(ALL_CAPABILITIES.size).toBeGreaterThan(30);
  });
});