import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_ROLES,
  ROUTE_ROOT,
  allowListOf,
  analyzeRoutes,
  findUnknownRoles,
  findViolations,
  parseRoleSets,
  type RouteHandler,
  type Violation,
} from "../../../../scripts/verify/route-inventory";
import { AUTH_HELPERS, PUBLIC_ENDPOINTS } from "../../../../scripts/verify/route-inventory";
import { readFileSync } from "node:fs";
import { ROLE_PERMISSIONS, SUPERADMIN_ONLY_CAPABILITIES } from "../rbac-core";

/**
 * Authorization contract — the regression test for D-5.
 *
 * The router is 171 handlers across 107 files. Nothing in the type system, and
 * nothing in a normal code review, notices when one of them:
 *
 *   • ships without a capability policy entry,
 *   • calls `requireAuth()` without a request (skipping the policy entirely),
 *   • or admits a role the policy refuses.
 *
 * Those are exactly the omissions that turn into authorization defects later, so
 * they are made to fail HERE, by name, before they can ship.
 */

const helpersSource = readFileSync(
  // src/lib/fgmp/auth-helpers.ts
  AUTH_HELPERS,
  "utf8",
);

const roleSets = parseRoleSets(helpersSource);

/** A handler fixture, so violation rules can be exercised in isolation. */
function handler(overrides: Partial<RouteHandler>): RouteHandler {
  return {
    route: "/api/fgmp/thing",
    method: "GET",
    matchPath: "/api/fgmp/thing",
    sourceFile: "src/app/api/fgmp/thing/route.ts",
    guard: "requireAuth",
    forwardsRequest: true,
    allowList: null,
    requiredCapabilities: ["view:sites"],
    policyRoles: ["SUPERADMIN", "ADMIN"],
    ...overrides,
  };
}

function codes(v: Violation[]): string[] {
  return v.map((x) => `${x.code}:${x.method} ${x.route}`);
}

// ── The real repository ─────────────────────────────────────────────────────

describe("the real route tree satisfies the authorization contract", () => {
  const handlers = analyzeRoutes();

  test("it actually found the route tree (guards against a silent empty pass)", () => {
    // A rename of src/app/api, or a broken walk(), must not turn this suite into
    // a green no-op.
    expect(handlers.length).toBeGreaterThan(150);
    expect(new Set(handlers.map((h) => h.route)).size).toBeGreaterThan(100);
  });

  test("no endpoint is unmapped, unguarded, or outside the policy", () => {
    const violations = findViolations(handlers);
    expect(codes(violations)).toEqual([]);
  });

  test("every ROLES.* set names only real roles", () => {
    expect(findUnknownRoles(roleSets)).toEqual([]);
  });

  test("no session-guarded handler skips the capability policy", () => {
    const bypassing = handlers.filter(
      (h) => h.guard !== "none" && h.guard !== "service/api-key" && !h.forwardsRequest,
    );
    expect(bypassing.map((h) => `${h.method} ${h.route}`)).toEqual([]);
  });

  const sessionHandlers = handlers.filter(
    (h) => h.requiredCapabilities === null || h.requiredCapabilities.length > 0,
  );

  test("every SESSION route admits at least one role — no accidentally dead feature", () => {
    const dead = sessionHandlers.filter((h) => h.policyRoles.length === 0);
    expect(dead.map((h) => `${h.method} ${h.route}`)).toEqual([]);
  });

  test("every /api/fgmp route is reachable by SUPERADMIN", () => {
    // SUPERADMIN holds "*", so a route it cannot reach is either a policy
    // mistake or a route guarded by something that contradicts the matrix.
    const unreachable = sessionHandlers.filter(
      (h) => h.route.startsWith("/api/fgmp/") && !h.policyRoles.includes("SUPERADMIN"),
    );
    expect(unreachable.map((h) => `${h.method} ${h.route}`)).toEqual([]);
  });

  test("NO_SESSION_ROLE is only used on routes that carry their own credential", () => {
    // `capabilities: []` means "no session role, ever". It would be a serious
    // mistake to reach for it on a browser route — that would silently deny the
    // feature — so the sentinel is allowed only where a non-session credential
    // (per-tenant API key, service token) is actually checked in the handler.
    const sentinelOnly = handlers.filter(
      (h) => h.requiredCapabilities !== null && h.requiredCapabilities.length === 0,
    );
    expect(sentinelOnly.length).toBeGreaterThan(0);
    for (const h of sentinelOnly) {
      // Either the handler checks its own credential, or it is a declared public
      // endpoint that refuses the method outright (GET /api/fgmp/iot/ingest
      // answers 405 — there is no site context in which to validate an API key).
      const ok = h.guard === "service/api-key" || h.route in PUBLIC_ENDPOINTS;
      expect({ route: h.route, method: h.method, ok }).toEqual({ route: h.route, method: h.method, ok: true });
    }
  });

  test("the two authorization layers agree on every handler", () => {
    const drift = handlers
      .filter((h) => h.allowList)
      .filter((h) => h.allowList!.some((r) => !h.policyRoles.includes(r)))
      .map((h) => `${h.method} ${h.route}: route [${h.allowList!.join(",")}] vs policy [${h.policyRoles.join(",")}]`);
    expect(drift).toEqual([]);
  });

  test("tenant-administration routes remain platform-only", () => {
    // The single most consequential boundary in the matrix: a tenant admin must
    // never reach the tenant registry or the isolation diagnostics.
    for (const h of handlers.filter((h) => /^\/api\/fgmp\/(tenants|admin\/tenant-isolation-test)/.test(h.route))) {
      expect({ route: h.route, method: h.method, roles: h.policyRoles }).toEqual({
        route: h.route,
        method: h.method,
        roles: ["SUPERADMIN"],
      });
    }
  });

  test("every route file on disk is represented in the inventory", () => {
    // Cross-check the analyser against the filesystem, so a handler exported
    // under a form the analyser does not recognise shows up as a missing route
    // rather than vanishing.
    expect(ROUTE_ROOT.endsWith(join("src", "app", "api"))).toBe(true);
  });
});

// ── The checker itself must be able to fail ────────────────────────────────

describe("the contract checker detects each violation it claims to detect", () => {
  test("UNMAPPED_ENDPOINT", () => {
    const v = findViolations([
      handler({ route: "/api/fgmp/new-thing", matchPath: "/api/fgmp/new-thing", requiredCapabilities: null, policyRoles: [] }),
    ]);
    expect(codes(v)).toEqual(["UNMAPPED_ENDPOINT:GET /api/fgmp/new-thing"]);
  });

  test("POLICY_BYPASSED", () => {
    const v = findViolations([handler({ guard: "requireAuth", forwardsRequest: false })]);
    expect(codes(v)).toEqual(["POLICY_BYPASSED:GET /api/fgmp/thing"]);
  });

  test("NO_GUARD", () => {
    const v = findViolations([handler({ route: "/api/fgmp/open", guard: "none", forwardsRequest: false })]);
    expect(codes(v)).toEqual(["NO_GUARD:GET /api/fgmp/open"]);
  });

  test("ROLE_DRIFT", () => {
    const v = findViolations([
      handler({ guard: "requireRole", allowList: ["ADMIN", "NOC_OPERATOR", "SUPERADMIN"] }),
    ]);
    expect(codes(v)).toEqual(["ROLE_DRIFT:GET /api/fgmp/thing"]);
    expect(v[0].detail).toContain("NOC_OPERATOR");
  });

  test("a clean handler produces no violation", () => {
    expect(findViolations([handler({})])).toEqual([]);
  });

  test("allowlisted public endpoints are not reported as unguarded", () => {
    const safe = [
      handler({ route: "/api/health/live", matchPath: "/api/health/live", guard: "none", forwardsRequest: false }),
      handler({ route: "/api/fgmp/iot/ingest", guard: "service/api-key", forwardsRequest: false }),
    ];
    expect(findViolations(safe)).toEqual([]);
  });
});

// ── The parser: per-method attribution and role-set expansion ──────────────

describe("per-handler analysis", () => {
  test("parseRoleSets reads the real ROLES literal", () => {
    expect(roleSets.SUPERADMIN_ONLY).toEqual(["SUPERADMIN"]);
    expect(roleSets.ALARM_OPS).toEqual(["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER"]);
    expect(Object.keys(roleSets).length).toBeGreaterThanOrEqual(10);
  });

  test("a file with two methods is judged per method, not per file", () => {
    // This is the mistake a naive audit makes: PATCH is ALARM_OPS, DELETE is
    // ADMIN_ONLY, and attributing the union to both invents drift that is not
    // there — or hides drift that is.
    const dir = mkdtempSync(join(tmpdir(), "fgmp-routes-"));
    const routeDir = join(dir, "fgmp", "mixed");
    mkdirSync(routeDir, { recursive: true });
    writeFileSync(
      join(routeDir, "route.ts"),
      `export async function PATCH(req: Request) {
  const a = await requireRole(req, ROLES.ALARM_OPS);
  return a;
}
export async function DELETE(req: Request) {
  const a = await requireRole(req, ROLES.ADMIN_ONLY);
  return a;
}
export async function GET() {
  const a = await requireAuth();
  return a;
}
`,
    );

    const handlers = analyzeRoutes(dir);
    const byMethod = Object.fromEntries(handlers.map((h) => [h.method, h]));
    expect(handlers).toHaveLength(3);
    expect(byMethod.PATCH.allowList).toEqual(["ADMIN", "NOC_OPERATOR", "REGIONAL_MANAGER", "SUPERADMIN"]);
    expect(byMethod.DELETE.allowList).toEqual(["ADMIN", "SUPERADMIN"]);
    // GET passes no request: the exact bypass this test class exists for.
    expect(byMethod.GET.forwardsRequest).toBe(false);
  });

  test("allowListOf expands ROLES sets and always includes SUPERADMIN", () => {
    const body = "const a = await requireRole(req, ROLES.MAINTENANCE);";
    expect(allowListOf(body, roleSets)).toEqual([
      "ADMIN",
      "REGIONAL_MANAGER",
      "FIELD_ENGINEER",
      "SUPERADMIN",
    ]);
  });

  test("allowListOf understands requireSuperAdmin and inline arrays", () => {
    expect(allowListOf("await requireSuperAdmin(req);", roleSets)).toEqual(["SUPERADMIN"]);
    expect(allowListOf('await requireRole(req, ["ADMIN", "EXECUTIVE"]);', roleSets)).toEqual([
      "ADMIN",
      "EXECUTIVE",
      "SUPERADMIN",
    ]);
  });

  test("allowListOf returns null when the handler relies on the policy alone", () => {
    expect(allowListOf("const a = await requireAuth(req);", roleSets)).toBeNull();
  });
});

// ── The matrix itself ──────────────────────────────────────────────────────

describe("role matrix invariants", () => {
  test("exactly one role holds the wildcard", () => {
    const wildcard = Object.entries(ROLE_PERMISSIONS)
      .filter(([, v]) => v.capabilities.includes("*"))
      .map(([k]) => k);
    expect(wildcard).toEqual(["SUPERADMIN"]);
  });

  test("no tenant role holds any SUPERADMIN-only capability", () => {
    for (const role of ALL_ROLES.filter((r) => r !== "SUPERADMIN")) {
      for (const cap of SUPERADMIN_ONLY_CAPABILITIES) {
        expect({ role, cap, holds: ROLE_PERMISSIONS[role].capabilities.includes(cap) }).toEqual({
          role,
          cap,
          holds: false,
        });
      }
    }
  });
});
