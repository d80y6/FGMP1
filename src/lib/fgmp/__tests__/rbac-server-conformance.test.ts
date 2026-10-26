/**
 * Server conformance: the route allow-list and the capability matrix must agree.
 * ─────────────────────────────────────────────────────────────────────────────
 * `route-inventory.ts` proves every handler is *reachable through* a policy.
 * `rbac-matrix.test.ts` proves the matrix is internally coherent. Neither proves
 * the two describe the SAME policy, which is where every defect in this review
 * lived: a route gated on a role set that admitted a different population than
 * the capability its path maps to.
 *
 * With one documented exception (`requireRole` always admits SUPERADMIN), each
 * check below compares the two descriptions directly. They are behavioural where
 * the code is behaviour (the export table, the capability lookups) and source
 * assertions only where the behaviour needs a database (the alarm route's
 * per-action gate).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_ROLES,
  EXPORT_TYPE_CAPABILITIES,
  apiReadCapabilities,
  canAccessApi,
  hasCapability,
  type Role,
} from "../rbac-core";
import { evaluatePendingSession, pendingAllowlistForTest } from "../mfa/guard";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Roles holding `cap` (SUPERADMIN always does, through the wildcard). */
const holders = (cap: string): Role[] => ALL_ROLES.filter((r) => hasCapability(r, cap));

describe("dispenser control: the route set and the capability holders are the same", () => {
  test("`dispenser:control` holders", () => {
    expect(holders("dispenser:control")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "NOC_OPERATOR",
      "FIELD_ENGINEER",
    ]);
  });

  test("the dispenser control route uses DISPENSER_CONTROL, not the generator set", () => {
    const src = read("src/app/api/fgmp/dispensers/[id]/control/route.ts");
    // `ROLES.CONTROL` is ADMIN + NOC — the generator set. It excluded
    // FIELD_ENGINEER, who holds `dispenser:control` and who the client offers
    // the control to, so the button produced a 403 for exactly the role that
    // stands in front of the hardware.
    expect(src.includes("ROLES.DISPENSER_CONTROL")).toBe(true);
    expect(src.includes("ROLES.CONTROL)")).toBe(false);
  });

  test("all three hardware routes agree with each other", () => {
    for (const route of [
      "src/app/api/fgmp/dispensers/[id]/control/route.ts",
      "src/app/api/fgmp/edge/esp/[dispenserId]/reboot/route.ts",
      "src/app/api/fgmp/edge/firmware/deploy/route.ts",
    ]) {
      expect({ route, uses: read(route).includes("ROLES.DISPENSER_CONTROL") }).toEqual({
        route,
        uses: true,
      });
    }
  });
});

describe("alarm actions: acknowledge and resolve are separable", () => {
  test("the matrix keeps them apart", () => {
    expect(holders("alarm:ack")).toEqual([
      "SUPERADMIN",
      "ADMIN",
      "NOC_OPERATOR",
      "REGIONAL_MANAGER",
    ]);
    expect(holders("alarm:resolve")).toEqual(["SUPERADMIN", "ADMIN", "NOC_OPERATOR"]);
  });

  test("the POST handler gates each action on its own capability", () => {
    // `ROLES.ALARM_OPS` is the union of the two holder sets, so a route-level
    // allow-list cannot express the difference: it admitted REGIONAL_MANAGER
    // for resolve, which the matrix does not grant and the UI no longer offers.
    const src = read("src/app/api/fgmp/alarms/route.ts");
    expect(src.includes('"alarm:resolve"')).toBe(true);
    expect(src.includes('"alarm:ack"')).toBe(true);
    // The per-action decision must be derived from the parsed action, not a
    // hardcoded true.
    expect(/resolving\s*=[^;]*bulkResolve/.test(src)).toBe(true);
  });

  test("the client asks the same question", () => {
    const view = read("src/components/fgmp/views/alarms-view.tsx");
    expect(view.includes('hasCapability(role, "alarm:ack")')).toBe(true);
    expect(view.includes('hasCapability(role, "alarm:resolve")')).toBe(true);
  });
});

describe("export: one table decides what exists and who may read it", () => {
  test("every exported type is implemented by the handler", () => {
    const src = read("src/app/api/fgmp/export/route.ts");
    for (const type of Object.keys(EXPORT_TYPE_CAPABILITIES)) {
      // The handler must have a branch for the type, so the policy can never
      // authorise a dataset the route answers with something else.
      expect({ type, implemented: src.includes(`type === "${type}"`) }).toEqual({
        type,
        implemented: true,
      });
    }
  });

  test("the type parameter is validated against the table", () => {
    const src = read("src/app/api/fgmp/export/route.ts");
    expect(src.includes("Object.hasOwn(EXPORT_TYPE_CAPABILITIES, type)")).toBe(true);
  });

  test("an unimplemented type is not authorisable", () => {
    // `alarms` and `deliveries` were listed in the policy but never implemented:
    // the `else` branch answered them with SITE records, so the policy granted
    // one dataset and the handler returned another.
    expect(Object.hasOwn(EXPORT_TYPE_CAPABILITIES, "alarms")).toBe(false);
    expect(Object.hasOwn(EXPORT_TYPE_CAPABILITIES, "deliveries")).toBe(false);
  });

  test("apiReadCapabilities() reads the same table for every type", () => {
    for (const [type, caps] of Object.entries(EXPORT_TYPE_CAPABILITIES)) {
      expect({ type, caps: apiReadCapabilities(`/api/fgmp/export?type=${type}`) })
        .toEqual({ type, caps });
    }
  });

  test("a non-site role cannot export site coordinates", () => {
    // `view:iot` and `view:inventory` used to be enough for `?type=sites`
    // (which is why the two screens that are not about sites could offer a
    // "site export"). Both capabilities are held only alongside `view:sites`
    // today, so this is defence against the next matrix edit.
    expect(apiReadCapabilities("/api/fgmp/export?type=sites")).not.toContain("view:iot");
    expect(apiReadCapabilities("/api/fgmp/export?type=sites")).not.toContain("view:inventory");
  });

  test("no view screen exports a dataset it is not about", () => {
    // An IoT or Delivery screen offering `?type=sites` is both a UX lie and the
    // reason the over-broad grant existed.
    for (const screen of ["iot-view", "inventory-view"]) {
      const src = read(`src/components/fgmp/views/${screen}.tsx`);
      expect({ screen, exportsSites: src.includes("export?type=sites") }).toEqual({
        screen,
        exportsSites: false,
      });
    }
  });
});

describe("route gates never admit a role the capability policy refuses", () => {
  // The ROLES sets are parsed from source so this stays a description of the
  // real code rather than a copy of it. `requireRole` always admits SUPERADMIN,
  // which is the one documented widening.
  const roleSets = (() => {
    const src = read("src/lib/fgmp/auth-helpers.ts");
    const block = src.slice(src.indexOf("export const ROLES = {"), src.indexOf("} as const;"));
    const out: Record<string, Role[]> = {};
    for (const m of block.matchAll(/^ {2}([A-Z_]+): \[([^\]]*)\] as Role\[\]/gm)) {
      out[m[1]] = [...m[2].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1] as Role);
    }
    return out;
  })();

  test("the sets parsed from source are the ones we think they are", () => {
    expect(Object.keys(roleSets).sort()).toEqual(
      [
        "ADMIN_ONLY",
        "ALARM_OPS",
        "ALARM_RULES",
        "CONTROL",
        "DELIVERY",
        "DISPENSER_CONTROL",
        "EDGE_MANAGE",
        "MAINTENANCE",
        "NOTIFICATION",
        "SUPERADMIN_ONLY",
        "SUPER_OR_ADMIN",
        "TICK",
      ].sort(),
    );
  });

  test("every write route's allow-list is a subset of its capability holders", () => {
    // Spot-checks the routes whose allow-list is easiest to get wrong: those
    // whose capability has several holders and whose ROLES entry has a
    // different name.
    const cases: { set: string; cap: string }[] = [
      { set: "ALARM_OPS", cap: "alarm:ack" },
      { set: "ALARM_RULES", cap: "alarm:configure" },
      { set: "DELIVERY", cap: "delivery:manage" },
      { set: "MAINTENANCE", cap: "ticket:manage" },
      { set: "DISPENSER_CONTROL", cap: "dispenser:control" },
      { set: "EDGE_MANAGE", cap: "edge:manage" },
      { set: "NOTIFICATION", cap: "notification:manage" },
    ];
    const violations: string[] = [];
    for (const { set, cap } of cases) {
      for (const role of roleSets[set] ?? []) {
        if (!hasCapability(role, cap)) violations.push(`ROLES.${set} admits ${role} without ${cap}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("spot checks on the sensitive surfaces", () => {
    // Tenant registry and isolation are SUPERADMIN-only: ADMIN holds a long
    // capability list and still must not see them.
    expect(canAccessApi("ADMIN", "/api/fgmp/tenants")).toBe(false);
    expect(canAccessApi("SUPERADMIN", "/api/fgmp/tenants")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/admin/tenant-isolation-test")).toBe(false);

    // Operational vs administrative.
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/api-keys")).toBe(false);
    expect(canAccessApi("READONLY", "/api/fgmp/health")).toBe(false);
    expect(canAccessApi("NOC_OPERATOR", "/api/fgmp/users")).toBe(false);
    expect(canAccessApi("ADMIN", "/api/fgmp/users")).toBe(true);

    // Reading alarms is wide; writing them is not. `POST` passes the capability
    // layer for REGIONAL_MANAGER (the rule is any-of ack|resolve) and is then
    // narrowed per action inside the handler — the split this file asserts.
    expect(canAccessApi("REGIONAL_MANAGER", "/api/fgmp/alarms")).toBe(true);
    expect(canAccessApi("REGIONAL_MANAGER", "/api/fgmp/alarms", "POST")).toBe(true);
    expect(canAccessApi("READONLY", "/api/fgmp/alarms", "POST")).toBe(false);
  });
});

describe("the MFA guard is wired, not merely written", () => {
  test("requireAuth consults the pending-session guard", () => {
    // B7: `mfa/guard.ts` was complete, documented and tested while no route
    // called it. The property that matters is the CALL SITE, so it is asserted
    // against the source: `requireAuth` evaluates the decision before it
    // evaluates capabilities, and every protected handler reaches the guard
    // through that one function.
    const source = read("src/lib/fgmp/auth-helpers.ts");
    const requireAuth = source.slice(
      source.indexOf("export async function requireAuth"),
      source.indexOf("async function applyRolePreview"),
    );
    expect(requireAuth).toContain("evaluatePendingSession(");
    expect(requireAuth).toContain("revalidated.mfaPending");
    expect(requireAuth.indexOf("evaluatePendingSession(")).toBeLessThan(
      requireAuth.indexOf("canAccessApi("),
    );
  });

  test("every requireAuth call site passes the request, so the guard knows the path", () => {
    // `requireAuth()` with no argument would evaluate a pathname of "/" and
    // refuse everything for a pending session — fail-safe, but it would also
    // make the allowlist unreachable. Every handler passes `req`.
    const files = ["state", "me", "preferences", "proposal"];
    // Comment lines mention `requireAuth()` in prose; strip them before
    // deciding, or the check reports documentation as a call site.
    const code = (p: string) =>
      read(p)
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
    const bare = files
      .map((f) => `src/app/api/fgmp/${f}/route.ts`)
      .filter((p) => /requireAuth\(\s*\)/.test(code(p)));
    expect(bare).toEqual([]);
  });

  test("a pending session is refused everywhere except the MFA endpoints", () => {
    const pending = { mfaPending: true };
    for (const path of [
      "/api/fgmp/state",
      "/api/fgmp/me",
      "/api/fgmp/preferences",
      "/api/fgmp/proposal",
      "/api/fgmp/generators/g1/control",
      "/api/fgmp/export",
    ]) {
      const d = evaluatePendingSession(path, pending);
      expect(d.blocked).toBe(true);
      if (d.blocked) {
        expect(d.status).toBe(403);
        expect(d.body.code).toBe("MFA_PENDING");
      }
    }
    for (const path of ["/api/fgmp/mfa/challenge", "/api/fgmp/mfa/status", "/api/auth/session"]) {
      expect(evaluatePendingSession(path, pending).blocked).toBe(false);
    }
    // A session with no MFA state at all costs nothing.
    expect(evaluatePendingSession("/api/fgmp/state", null).blocked).toBe(false);
    expect(evaluatePendingSession("/api/fgmp/state", { mfaPending: false }).blocked).toBe(false);
  });

  test("the pending allowlist really is tiny", () => {
    const { prefixes, exact } = pendingAllowlistForTest();
    expect(prefixes.length).toBeLessThanOrEqual(3);
    expect(exact.length).toBeLessThanOrEqual(3);
    // Nothing in the allowlist may match a data route.
    expect(prefixes.some((p) => p.includes("/fgmp/state") || p.includes("/fgmp/export"))).toBe(false);
  });
});
