/**
 * The platform tier: capability, endpoint policy and handler guard must be one
 * fact.
 * ─────────────────────────────────────────────────────────────────────────────
 * FGMP1 is a multi-tenant SaaS with TWO role families, and every earlier guard
 * in this suite was written about the first one:
 *
 *   tenant roles   ADMIN, NOC_OPERATOR, REGIONAL_MANAGER, FIELD_ENGINEER,
 *                  EXECUTIVE, READONLY — scoped to one tenant by RLS.
 *   platform role  SUPERADMIN — owns the tenant registry, the platform audit
 *                  trail, the grant inventory, the global firmware catalogue
 *                  and the support-session control plane.
 *
 * A platform surface is described in three places at once:
 *
 *   1. the MATRIX   `SUPERADMIN_ONLY_CAPABILITIES` in rbac-core.ts (what the
 *                   client asks: nav entries, view gates, `useApi`).
 *   2. the POLICY   `API_READ_RULES` / `API_WRITE_RULES` (what `canAccessApi`
 *                   answers — the same function the browser uses).
 *   3. the HANDLER  `ROLES.SUPERADMIN_ONLY` via `requireSuperAdmin()` or
 *                   `requireRole()` (what the server actually enforces).
 *
 * Each of the three is individually reasonable, which is exactly why they
 * drifted in the tenant tier for months: a route gated on a role set that
 * admitted a different population than the capability its path maps to, and a
 * view whose button was rendered for a role the endpoint refused. Both of those
 * are RBAC defects even though the server wins, because the product then tells
 * an operator they may do something it will refuse.
 *
 * ── WHY THIS FILE IS DERIVED RATHER THAN HAND-WRITTEN ──────────────────────
 * `rbac-ui-gates.test.ts` lists its gates by hand on purpose: somebody must
 * decide which capability a screen needs, and a derived list would be satisfied
 * by the same mistake twice. This file is the opposite case. The route tree is
 * the ground truth for "which paths exist", so it is walked from disk on every
 * run; a route added tomorrow is policed without anyone remembering to add it
 * to a table here. The failure this catches — a new platform route that forgets
 * `ROLES.SUPERADMIN_ONLY`, or that is left out of the policy and so becomes
 * silently un-callable from the client — is precisely the one a hand-written
 * list stops catching the day it is written.
 *
 * ── THE PROPERTY THAT MATTERS MOST ─────────────────────────────────────────
 * `canAccessApi` is ANY-OF over a rule's capability list. Appending one
 * ordinary capability to a platform rule (say `["view:tenants", "view:dashboard"]`)
 * would hand the tenant registry, the audit trail and the support-session
 * control plane to every role holding the appended capability — a fail-OPEN
 * edit in a table of fail-CLOSED-looking entries. No mixed rule exists today,
 * and the check below keeps it that way.
 *
 * Run: bun test src/lib/fgmp/__tests__/platform-tier-parity.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ALL_ROLES,
  SUPERADMIN_ONLY_CAPABILITIES,
  apiRequestCapabilities,
  canAccessApi,
  hasCapability,
  ROLE_PERMISSIONS,
} from "../rbac-core";
import { NAV_ENTRIES } from "../navigation";
import {
  PLATFORM_TENANT_ID,
  platformTenantIdFor,
  superAdminPlacement,
  superAdminPromotionRefusal,
} from "../platform-identity";

const ROOT = process.cwd();
const API_ROOT = join(ROOT, "src", "app", "api", "fgmp");
const VIEWS = join(ROOT, "src", "components", "fgmp", "views");

/** Every `route.ts` under the FGMP API tree. */
function routeFiles(dir: string = API_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === "route.ts") out.push(path);
  }
  return out;
}

/**
 * The URL a route file serves, with every dynamic segment standing in as `seg`.
 *
 * Policy rules are prefix matches on the pathname, so a placeholder is enough
 * to answer "which capability does this route require" — and it is the only
 * answer that does not depend on a database.
 */
function urlOf(file: string): string {
  const suffix = relative(API_ROOT, file)
    .replace(/\/route\.ts$/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => (segment.startsWith("[") ? "seg" : segment))
    .join("/");
  return `/api/fgmp/${suffix}`;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The methods a route file actually exports.
 *
 * Handlers are written as `export async function GET(…)` in this tree; the
 * `export const GET =` form is accepted too so the scan cannot silently return
 * an empty list for a route that switched style (an empty list would make every
 * assertion about that route vacuously true).
 */
function methodsOf(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((method) =>
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`).test(source),
  );
}

/**
 * The source of ONE exported handler, with the rest of the file removed.
 *
 * A file-level scan is not good enough here, and the difference is not
 * theoretical: `tenants/route.ts` guards `POST` on `ROLES.SUPERADMIN_ONLY` and
 * its `GET` on `isSuperAdminUser`. Replacing the POST guard with `requireAuth`
 * left the file still containing a superadmin check — in its sibling handler —
 * so a file-level assertion passed while the mutation was live. The unit that
 * must be guarded is the HANDLER, so the slice runs from this method's
 * declaration to the next top-level `export`.
 */
function handlerSource(source: string, method: HttpMethod): string {
  const declaration = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`, "m");
  const start = source.search(declaration);
  if (start === -1) return "";
  const rest = source.slice(start);
  // The next top-level export ends this handler. `const`/`function` are NOT
  // delimiters: they appear inside every handler body.
  const nextExport = rest.slice(1).search(/\nexport\s/);
  let body = nextExport === -1 ? rest : rest.slice(0, nextExport + 1);
  // A docblock that introduces the NEXT handler is not part of this one; cut it
  // so a comment cannot satisfy the guard.
  const docblock = body.lastIndexOf("\n/**");
  if (docblock > 0) body = body.slice(0, docblock);
  return body;
}

// Widened to `string[]` on purpose: the checks below compare it against
// capability strings that came out of the policy map, whose type is whatever
// `apiRequestCapabilities` returns rather than this literal union.
const SUPER: readonly string[] = [...SUPERADMIN_ONLY_CAPABILITIES];
const isPlatformCapability = (cap: string) => SUPER.includes(cap);
const TENANT_ROLES = ALL_ROLES.filter((role) => role !== "SUPERADMIN");

const ROUTES = routeFiles().map((file) => {
  const source = readFileSync(file, "utf8");
  const url = urlOf(file);
  const methods = methodsOf(source);
  return {
    file: relative(ROOT, file),
    source,
    url,
    methods,
    /** Capability list per method; `null` means "no policy row". */
    policy: methods.map((method) => ({ method, caps: apiRequestCapabilities(method, url) })),
    /** Canonical URL, for the assertion messages. */
  };
});

/** Routes whose policy is a platform capability the tenant roles cannot hold. */
const PLATFORM_ROUTES = ROUTES.flatMap((route) =>
  route.policy
    .filter(({ caps }) => caps !== null && caps.some(isPlatformCapability))
    .map(({ method, caps }) => ({ ...route, method, caps: caps as readonly string[] })),
);

describe("platform tier — the scan sees the real surface", () => {
  test("it finds the platform routes it is supposed to police", () => {
    // A glob that matches nothing makes every check below vacuously true, which
    // is the standard way a security test stops working without failing.
    expect(ROUTES.length).toBeGreaterThanOrEqual(100);
    const urls = PLATFORM_ROUTES.map((r) => `${r.method} ${r.url}`);
    for (const expected of [
      "GET /api/fgmp/tenants",
      "POST /api/fgmp/tenants",
      "GET /api/fgmp/platform/audit",
      "GET /api/fgmp/platform/grants",
      "GET /api/fgmp/platform/support-sessions",
      "GET /api/fgmp/platform/support/seg/summary",
      "POST /api/fgmp/platform/support/seg/summary",
      "GET /api/fgmp/admin/tenant-isolation-test",
      "POST /api/fgmp/edge/firmware",
      "DELETE /api/fgmp/edge/firmware/seg",
    ]) {
      expect(urls).toContain(expected);
    }
  });

  test("every route's exported methods are read from its source", () => {
    const empty = ROUTES.filter((r) => r.methods.length === 0).map((r) => r.file);
    expect(empty).toEqual([]);
  });
});

describe("platform tier — the capability matrix has exactly one holder", () => {
  // These five keys are how the client decides whether a platform surface
  // exists for a role. They are held through SUPERADMIN's `*`, and only there.
  // If one is ever added to a tenant role's explicit list, the sidebar and the
  // command palette would offer a screen whose own route is gated on
  // `ROLES.SUPERADMIN_ONLY` — a link to content the role cannot load, which is
  // the exact failure the RBAC review exists to prevent.
  for (const capability of SUPER) {
    test(`${capability} is held by SUPERADMIN alone`, () => {
      const holders = ALL_ROLES.filter((role) => hasCapability(role, capability));
      expect(holders).toEqual(["SUPERADMIN"]);
    });
  }

  test("SUPERADMIN is the only role declaring the wildcard; wildcard is not a capability", () => {
    const wildcard = ALL_ROLES.filter((role) => ROLE_PERMISSIONS[role].capabilities.includes("*"));
    expect(wildcard).toEqual(["SUPERADMIN"]);
    for (const role of ALL_ROLES) expect(hasCapability(role, "*")).toBe(false);
  });
});

describe("platform tier — the handler enforces what the policy advertises", () => {
  test("every platform route guards its handler on the platform role", () => {
    // `requireSuperAdmin()` is the /platform/ helper; the two global-firmware
    // routes and the tenant registry call `requireRole(…, ROLES.SUPERADMIN_ONLY)`
    // directly. Any of the three is the same decision; a fourth answer is not.
    const GUARD = /requireSuperAdmin\(|isSuperAdminUser\(|ROLES\.SUPERADMIN_ONLY/;
    const unguarded = PLATFORM_ROUTES.filter(
      (route) => !GUARD.test(handlerSource(route.source, route.method)),
    ).map((route) => `${route.method} ${route.url} (${route.file})`);
    // The policy would have refused the request anyway if `canAccessApi` were
    // the only layer. It is not: the server repeats the decision, and a handler
    // that answers "authenticated" instead of "platform role" is one refactor
    // away from being reachable.
    expect(unguarded).toEqual([]);
  });

  test("no platform route is reachable by a tenant role", () => {
    // The client policy is the browser's question; the handler is the server's.
    // Both must answer NO for every non-platform role, independently.
    const leaks: string[] = [];
    for (const route of PLATFORM_ROUTES) {
      for (const role of TENANT_ROLES) {
        if (canAccessApi(role, route.url, route.method)) {
          leaks.push(`${route.method} ${route.url} admits ${role} at the client policy`);
        }
      }
      if (!canAccessApi("SUPERADMIN", route.url, route.method)) {
        leaks.push(`${route.method} ${route.url} refuses SUPERADMIN at the client policy`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("no route mixes a platform capability with a tenant one", () => {
    // `canAccessApi` is ANY-OF. A rule such as
    // `["view:tenants", "view:dashboard"]` would look like a policy and behave
    // like a key to every dashboard reader. Platform capabilities must appear
    // in rules that contain nothing else.
    const mixed: string[] = [];
    for (const route of ROUTES) {
      for (const { method, caps } of route.policy) {
        if (!caps) continue;
        const platform = caps.filter(isPlatformCapability);
        const ordinary = caps.filter((cap) => !isPlatformCapability(cap));
        if (platform.length > 0 && ordinary.length > 0) {
          mixed.push(`${method} ${route.url} → ${caps.join(", ")}`);
        }
      }
    }
    expect(mixed).toEqual([]);
  });

  test("every platform route has a policy row at all", () => {
    // An unmapped path is denied by `canAccessApi` for EVERY role including
    // SUPERADMIN, so the surface would exist on the server and be unreachable
    // from the browser. That is a bug with no error message, so it is asserted
    // here rather than discovered by a user.
    const unmapped: string[] = [];
    for (const route of ROUTES) {
      for (const { method, caps } of route.policy) {
        if (caps === null || caps.length === 0) {
          // AUTH_ONLY routes are the documented exception: they are reachable
          // by any authenticated session by design.
          const guard = /requireSuperAdmin\(|ROLES\.SUPERADMIN_ONLY/.test(
            handlerSource(route.source, method),
          );
          if (guard) unmapped.push(`${method} ${route.url} (${route.file})`);
        }
      }
    }
    expect(unmapped).toEqual([]);
  });
});

describe("platform tier — the view behind the nav entry gates itself", () => {
  // The nav filter is a filter, not the enforcement: a typed URL, a stale store
  // entry or a deep link can still name the view. `store.setView` refuses it and
  // `app-shell` falls back to the dashboard, and the view itself carries a third
  // guard. This asserts that third guard exists for every nav entry whose
  // capability is platform-only — derived from `NAV_ENTRIES`, so a new platform
  // screen cannot be added without one.
  const platformEntries = NAV_ENTRIES.filter((entry) => isPlatformCapability(entry.cap));

  test("the platform nav entries are the two reviewed here", () => {
    expect(platformEntries.map((e) => `${e.key}:${e.cap}`).sort()).toEqual([
      "tenant-isolation:view:tenant-isolation",
      "tenants:view:tenants",
    ]);
  });

  for (const entry of platformEntries) {
    test(`${entry.key} refuses to render without ${entry.cap}`, () => {
      const file = join(VIEWS, `${entry.key}-view.tsx`);
      expect(existsSync(file)).toBe(true);
      const source = readFileSync(file, "utf8");
      // The capability must be the ARGUMENT of a capability call, not a string
      // that happens to appear in the file (a comment would satisfy that).
      const gates = new RegExp(
        `(?:hasCapability|canAccessApi)\\([^)]*"${entry.cap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
      ).test(source);
      expect({ view: entry.key, gates }).toEqual({ view: entry.key, gates: true });
    });
  }
});

describe("platform tier — a super-admin account lives in the platform tenant", () => {
  // The whole support-session design rests on one structural assumption:
  // a super-admin's session is scoped to the platform tenant, so it never
  // points at a customer's data. Nothing in the schema enforces that — only the
  // tenant on the SUPERADMIN `User` row — so these are the rules that keep the
  // assumption true. The defect they close existed in the shipped UI: promoting
  // a customer-tenant user to SUPERADMIN in place gave that account a permanent,
  // unaudited read of that customer, with no support session and no expiry.

  test("a new super-admin is placed in the platform tenant by default", () => {
    expect(superAdminPlacement()).toEqual({ ok: true, tenantId: PLATFORM_TENANT_ID });
    expect(superAdminPlacement(null)).toEqual({ ok: true, tenantId: PLATFORM_TENANT_ID });
    expect(superAdminPlacement("  ")).toEqual({ ok: true, tenantId: PLATFORM_TENANT_ID });
  });

  test("naming the platform tenant explicitly is accepted", () => {
    expect(superAdminPlacement(PLATFORM_TENANT_ID)).toEqual({
      ok: true,
      tenantId: PLATFORM_TENANT_ID,
    });
  });

  test("a super-admin cannot be created in a customer tenant", () => {
    const placement = superAdminPlacement("t-default");
    // Refused, not silently relocated: a caller who asked for t-default must
    // learn that the account is not going to be there.
    expect(placement.ok).toBe(false);
    if (!placement.ok) {
      expect(placement.code).toBe("SUPERADMIN_TENANT_FIXED");
      expect(placement.status).toBe(400);
      expect(placement.error).toContain(PLATFORM_TENANT_ID);
    }
  });

  test("promotion is allowed only for an account already in the platform tenant", () => {
    expect(superAdminPromotionRefusal(PLATFORM_TENANT_ID)).toBeNull();
  });

  test("promotion in a customer tenant is refused", () => {
    const refusal = superAdminPromotionRefusal("t-default");
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("SUPERADMIN_TENANT_FIXED");
    expect(refusal?.status).toBe(400);
  });

  test("the placement rule is not exposed to a caller who cannot act on it", () => {
    expect(platformTenantIdFor(false)).toBeNull();
    expect(platformTenantIdFor(true)).toBe(PLATFORM_TENANT_ID);
  });

  test("both user routes enforce the rule through this module", () => {
    // A test of a pure function proves the RULE; it does not prove the rule has
    // a caller. `mfa/guard.ts` was complete, documented and tested while no
    // route called it, so the call sites are asserted too.
    const create = readFileSync(join(ROOT, "src/app/api/fgmp/users/route.ts"), "utf8");
    const update = readFileSync(join(ROOT, "src/app/api/fgmp/users/[id]/route.ts"), "utf8");
    expect(create).toContain("superAdminPlacement(");
    expect(update).toContain("superAdminPromotionRefusal(");
    // Neither may keep a private copy of the constant: two definitions of "the
    // platform tenant" is how the placement rule drifts.
    expect(create.includes('const PLATFORM_TENANT_ID = "')).toBe(false);
    expect(update.includes('const PLATFORM_TENANT_ID = "')).toBe(false);
  });

  test("the client hides the option the server would refuse", () => {
    const source = readFileSync(join(ROOT, "src/components/fgmp/views/users-view.tsx"), "utf8");
    // The edit dialog must compare the TARGET's tenant against the platform
    // tenant before offering the role. `me.tenantId` is not that comparison: a
    // super-admin's own tenant is the platform tenant only by convention, which
    // is the convention this whole module exists to enforce.
    expect(source).toContain("platformTenantId");
    expect(source).toContain("target?.tenantId === platformTenantId");
  });
});
