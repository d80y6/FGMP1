/**
 * Unit tests for the control scope assertion (Phase 3).
 *
 * These are the tests that decide whether a cross-tenant control command is
 * refused. No database, no engine, no HTTP — the assertion is pure, which is
 * why it can be exhaustively tested here. Run: bun test src/lib/fgmp/control-scope.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  assertControlScope,
  assertGeneratorControlScope,
  controlScopeDenial,
} from "./control-scope";

const A = "t-default";
const B = "t-attacker";

describe("same-tenant control is allowed", () => {
  test("matching tenants pass", () => {
    const v = assertControlScope({
      expectedTenantId: A,
      assetTenantId: A,
      assetLabel: "Generator g1",
      action: "START",
    });
    expect(v.allowed).toBe(true);
    expect(controlScopeDenial({ expectedTenantId: A, assetTenantId: A, assetLabel: "g1", action: "START" })).toBeNull();
  });
});

describe("cross-tenant control is REFUSED", () => {
  test("mismatched tenants are denied with a stable code", () => {
    const v = assertControlScope({
      expectedTenantId: A,
      assetTenantId: B,
      assetLabel: "Generator g-evil",
      action: "START",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.code).toBe("ASSET_TENANT_MISMATCH");
      // MUST NOT disclose the other tenant's identity — that is an enumeration
      // oracle across tenant boundaries.
      expect(v.message).not.toContain(B);
      expect(v.message).toContain("does not belong to the requesting tenant");
    }
  });

  test("the refusal names the asset and the action so an operator can act on it", () => {
    const v = assertControlScope({
      expectedTenantId: A,
      assetTenantId: B,
      assetLabel: "Generator g-evil",
      action: "EMERGENCY_STOP",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.message).toContain("g-evil");
      expect(v.message).toContain("EMERGENCY_STOP");
    }
  });
});

describe("refusal is the default for every undeterminable input", () => {
  test("unknown ASSET tenant is refused, not assumed", () => {
    for (const assetTenantId of [undefined, null, "", "  ", 0 as unknown as string, {} as unknown as string]) {
      const v = assertControlScope({
        expectedTenantId: A,
        assetTenantId,
        assetLabel: "Generator g1",
        action: "START",
      });
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("ASSET_TENANT_UNKNOWN");
    }
  });

  test("unknown CALLER tenant is refused — never treated as a wildcard", () => {
    for (const expectedTenantId of [undefined, null, "", 0 as unknown as string]) {
      const v = assertControlScope({
        expectedTenantId,
        assetTenantId: A,
        assetLabel: "Generator g1",
        action: "START",
      });
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("TENANT_SCOPE_UNKNOWN");
    }
  });

  test("a malformed tenant id cannot be used to smuggle a value through", () => {
    // Anything outside the conservative identifier set is refused outright
    // rather than compared, so no injection-shaped string reaches the
    // comparison and no tenant name can be smuggled into the error text.
    for (const bad of ["t default", "t'; DROP TABLE", "a".repeat(200), "../../etc"]) {
      const v = assertControlScope({
        expectedTenantId: A,
        assetTenantId: bad,
        assetLabel: "Generator g1",
        action: "START",
      });
      expect(v.allowed).toBe(false);
      if (!v.allowed) expect(v.code).toBe("ASSET_TENANT_UNKNOWN");
    }
  });
});

describe("generator two-hop ownership", () => {
  test("generator + site agreeing on the caller's tenant passes", () => {
    const v = assertGeneratorControlScope({
      expectedTenantId: A,
      generatorId: "g1",
      generatorTenantId: A,
      siteTenantId: A,
      action: "START",
    });
    expect(v.allowed).toBe(true);
  });

  test("site belongs to another tenant -> refused", () => {
    const v = assertGeneratorControlScope({
      expectedTenantId: A,
      generatorId: "g-evil",
      generatorTenantId: B,
      siteTenantId: B,
      action: "START",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.code).toBe("ASSET_TENANT_MISMATCH");
  });

  test("generator and site DISAGREE -> refused rather than resolved", () => {
    // Inconsistent data must not be resolved by picking a winner: picking one
    // could resolve to the wrong tenant and command another operator's asset.
    //
    // Both sides match the CALLER here, so the site-vs-caller check passes and
    // the generator-vs-site consistency check is what must fire. Using a site
    // belonging to another tenant would be caught by the earlier comparison and
    // would never reach this branch.
    const v = assertGeneratorControlScope({
      expectedTenantId: A,
      generatorId: "g1",
      generatorTenantId: B,
      siteTenantId: A,
      action: "START",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.code).toBe("ASSET_TENANT_MISMATCH");
      expect(v.message).toContain("disagree");
    }
  });

  test("a generator with no denormalised tenantId still passes on the site", () => {
    // GenState carries no tenantId; the site is authoritative. Undefined must
    // be treated as "no disagreement", not as a failure.
    const v = assertGeneratorControlScope({
      expectedTenantId: A,
      generatorId: "g1",
      generatorTenantId: undefined,
      siteTenantId: A,
      action: "START",
    });
    expect(v.allowed).toBe(true);
  });
});

describe("the assertion is not vacuous", () => {
  test("every action is refused identically for a cross-tenant asset", () => {
    const actions = [
      "START", "STOP", "EMERGENCY_STOP", "RESET", "AUTHORIZE",
      "LOCK", "UNLOCK", "ESP_REBOOT", "FIRMWARE_DEPLOY", "GATEWAY_REBOOT",
    ] as const;
    for (const action of actions) {
      const v = assertControlScope({
        expectedTenantId: A,
        assetTenantId: B,
        assetLabel: "asset",
        action,
      });
      expect(v.allowed).toBe(false);
    }
  });

  test("the same call with matching tenants is allowed for every action", () => {
    const actions = [
      "START", "STOP", "EMERGENCY_STOP", "RESET", "AUTHORIZE",
      "LOCK", "UNLOCK", "ESP_REBOOT", "FIRMWARE_DEPLOY", "GATEWAY_REBOOT",
    ] as const;
    for (const action of actions) {
      const v = assertControlScope({
        expectedTenantId: A,
        assetTenantId: A,
        assetLabel: "asset",
        action,
      });
      expect(v.allowed).toBe(true);
    }
  });
});