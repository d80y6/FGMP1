/**
 * Regression guards for the platform/tenant boundary fixes.
 *
 * These checks deliberately complement (not replace) database-backed RLS
 * tests: they protect the route-level policy choices that a Prisma typecheck
 * cannot prove, especially a SUPERADMIN branch that widens an in-memory
 * response or an HTTP handler that resumes global ticking.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { DICTIONARY } from "@/lib/fgmp/i18n";
import { asTenantForAnotherTenant, resolveTenantScope } from "@/lib/fgmp/route-tenant";

const source = (path: string) => readFileSync(path, "utf8");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

const ordinaryTenantRoutes = [
  "src/app/api/fgmp/state/route.ts",
  "src/app/api/fgmp/export/route.ts",
  "src/app/api/fgmp/history/[entityId]/route.ts",
  "src/app/api/fgmp/analytics/route.ts",
  "src/app/api/fgmp/forecast/route.ts",
  "src/app/api/fgmp/fuel/runout-eta/route.ts",
  "src/app/api/fgmp/patterns/route.ts",
  "src/app/api/fgmp/reports/route.ts",
  "src/app/api/fgmp/sites/route.ts",
  "src/app/api/fgmp/sites/[id]/route.ts",
  "src/app/api/fgmp/geography/regions/[id]/route.ts",
  "src/app/api/fgmp/geography/governorates/route.ts",
  "src/app/api/fgmp/geography/governorates/[id]/route.ts",
  "src/app/api/fgmp/geography/districts/route.ts",
  "src/app/api/fgmp/geography/districts/[id]/route.ts",
  "src/app/api/fgmp/edge/firmware/deployments/route.ts",
];

describe("client/server and deployment build boundaries", () => {
  test("client capability consumers do not import server identity or Prisma code", () => {
    const clientModules = [
      "src/components/fgmp/app-shell.tsx",
      "src/components/fgmp/command-palette.tsx",
      "src/components/fgmp/views/users-view.tsx",
      "src/components/fgmp/views/roles-view.tsx",
      "src/components/fgmp/views/asset-registry-view.tsx",
    ];
    for (const path of clientModules) {
      const code = source(path);
      expect(code).toContain("@/lib/fgmp/rbac-core");
      expect(code).not.toContain('@/lib/fgmp/rbac"');
    }

    expect(source("src/lib/fgmp/rbac.ts")).toContain('import "server-only"');
    expect(source("src/lib/fgmp/rbac.ts")).toContain("@/lib/fgmp/owner-db");
    expect(source("src/lib/fgmp/rbac-core.ts")).not.toContain("@/lib/fgmp/owner-db");
    expect(source("src/lib/fgmp/rbac-core.ts")).not.toContain("@/lib/db");
  });

  test("production builds generate Prisma Client and instrumentation targets Node", () => {
    expect(source("package.json")).toContain("prisma generate && next build");
    const instrumentation = source("src/instrumentation.ts");
    expect(instrumentation).toContain('export const runtime = "nodejs"');
    expect(instrumentation).not.toContain("process.exit(");
    expect(instrumentation).not.toContain("process.once(");
  });

  test("OpenNext self-reference matches the deployed Worker and preserves dashboard vars", () => {
    const wrangler = JSON.parse(source("wrangler.jsonc"));
    expect(wrangler.name).toBe("fgmp1");
    expect(wrangler.services).toContainEqual({
      binding: "WORKER_SELF_REFERENCE",
      service: "fgmp1",
    });
    expect(wrangler.keep_vars).toBe(true);
    expect(wrangler.vars).toBeUndefined();
    expect(source("open-next.config.ts")).toContain('buildCommand: "bun run build:standalone"');
    expect(JSON.parse(source("package.json")).scripts.build).toBe("opennextjs-cloudflare build");
  });
});

describe("ordinary browser data endpoints are tenant-bound", () => {
  for (const path of ordinaryTenantRoutes) {
    test(`${path} does not widen customer data for SUPERADMIN`, () => {
      const code = source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code).toContain("tenantIdOrThrow");
      expect(code).not.toContain("isSuperAdminUser");
    });
  }
});

describe("global state and service credentials", () => {
  test("legacy list-filter helpers no longer expand platform sessions to all tenants", () => {
    const helpers = source("src/lib/fgmp/auth-helpers.ts");
    expect(helpers).toContain("export function tenantWhereOrAll(me: SessionUser): { tenantId: string }");
    expect(helpers).toContain("export function siteTenantWhereOrAll(me: SessionUser): { site: { tenantId: string } }");
    expect(helpers).not.toContain("if (isSuperAdminUser(me)) return {};");
  });

  test("request-driven tick endpoint cannot advance the engine", () => {
    const route = source("src/app/api/fgmp/tick/route.ts");
    expect(route).toContain("TICK_ENDPOINT_DISABLED");
    expect(route).not.toMatch(/engine\.tick\s*\(/);
    expect(source("src/lib/fgmp/store.ts")).not.toContain("/api/fgmp/tick");
  });

  test("IoT credentials are looked up in the submitted site's tenant", () => {
    const route = source("src/app/api/fgmp/iot/ingest/route.ts");
    expect(route).toContain("withTenant(tenantId");
    expect(route).toContain("keyHash: hashApiKey(apiKey)");
    expect(route).toContain('scopes.includes("write")');
    expect(route).toContain("METHOD_NOT_ALLOWED");
    expect(route).not.toContain("process.env.IOT_API_KEY");
  });

  test("tenant snapshots exclude events whose ownership cannot be proven", () => {
    const engine = source("src/lib/fgmp/services/core.ts");
    expect(engine).toContain("return typeof sid === \"string\" && siteIds.has(sid)");
  });

  test("platform tenant detail counts use the explicitly named tenant scope", () => {
    const route = source("src/app/api/fgmp/tenants/[id]/route.ts");
    expect(route).toContain("getTenantMeta(id)");
    expect(route).toContain("tenantCounts(id)");
  });

  test("cross-tenant request-scoped database contexts are limited to named user administration", () => {
    const userAdmin = source("src/app/api/fgmp/users/route.ts");
    // The import used to be asserted as one exact line; the names are what
    // matter, so it is matched as a set. (It moved to a multi-line import when
    // the route started type-checking its transaction callback.)
    for (const name of ["asTenant", "asTenantForAnotherTenant", "resolveTenantScope"]) {
      expect({ name, imported: new RegExp(`\\b${name}\\b[^;]*\\} from \"@/lib/fgmp/route-tenant\"`, "s").test(userAdmin) }).toEqual({ name, imported: true });
    }
    expect(userAdmin).toContain("resolveTenantScope(me, searchParams.get(\"tenant\"))");
    expect(userAdmin).toContain("asTenantForAnotherTenant(me, tenantId");
    // ── The privileged helper is for SUPERADMIN, and only for it ────────────
    // POST /api/fgmp/users called it for EVERY caller, so a tenant ADMIN adding
    // a colleague in their own tenant hit the helper's SUPERADMIN assertion and
    // got a 500. Both branches must exist: the privileged one for a
    // super-admin's cross-tenant target, and the ordinary one for everybody
    // else, whose tenant is already forced to their own three lines above.
    expect(userAdmin).toContain("? await asTenantForAnotherTenant(me, tenantId, create)");
    expect(userAdmin).toContain(": await asTenant(me, create)");

    for (const path of ["src/app/api/fgmp/sites/route.ts", "src/app/api/fgmp/geography/regions/route.ts"]) {
      expect(source(path)).not.toContain("asTenantForAnotherTenant");
    }
    expect(source("src/app/api/fgmp/geography/regions/route.ts")).toContain("parsed.data.tenantId !== tenantId");

    const privilegedRoutes = routeFiles("src/app/api/fgmp").filter((path) =>
      source(path).includes("asTenantForAnotherTenant("),
    );
    expect(privilegedRoutes).toEqual(["src/app/api/fgmp/users/route.ts"]);
  });

  test("missing diagnostic samples stay unmeasured in the UI", () => {
    const api = source("src/app/api/fgmp/admin/tenant-isolation-test/route.ts");
    const view = source("src/components/fgmp/views/tenant-isolation-view.tsx");
    expect(api).toContain("unmeasured");
    expect(api).toContain("recordFound");
    // The label moved into the dictionary when the view was translated. Assert
    // the KEY is wired into the view (not the literal), and that the key still
    // carries the operator-facing wording in both languages — the point of the
    // guard is that an unmeasured sample is never silently shown as measured.
    expect(view).toContain('t("isolation.notMeasured")');
    expect(DICTIONARY["isolation.notMeasured"]?.en).toBe("Not measured — no sample row");
    expect(DICTIONARY["isolation.notMeasured"]?.ar).toBeTruthy();
    expect(view).toContain("Sampled Helper Check Incomplete");
  });
});

describe("the ?tenant= exception is SUPERADMIN-only and cannot be enumerated", () => {
  // B9: `users/route.ts` and `users/[id]/route.ts` resolve an explicit tenant
  // instead of the session's. SECURITY.md names this as the one exception to
  // "the tenant comes from the session"; these assertions pin the two
  // properties that make the exception safe. `run` is never invoked here, so no
  // database is touched: the decision is made before the transaction opens.
  const ADMIN = { tenantId: "t-admin", role: "ADMIN" as const };
  const SUPER = { tenantId: "t-platform", role: "SUPERADMIN" as const };

  test("a tenant administrator's ?tenant= is ignored, not refused", () => {
    for (const requested of ["t-other", "t-admin", "", "   ", null, undefined]) {
      const scope = resolveTenantScope(ADMIN, requested);
      expect(scope.tenantId).toBe("t-admin");
      expect(scope.crossTenant).toBe(false);
    }
  });

  test("ignoring is not an oracle: every non-superadmin answer is identical", () => {
    // The response must not vary with whether the named tenant exists, or the
    // 404-vs-200 difference becomes an enumeration channel.
    const a = resolveTenantScope(ADMIN, "t-exists");
    const b = resolveTenantScope(ADMIN, "t-does-not-exist");
    expect(a.crossTenant).toBe(b.crossTenant);
    expect(a.tenantId).toBe(b.tenantId);
  });

  test("only a superadmin naming a different tenant gets a cross-tenant scope", () => {
    const named = resolveTenantScope(SUPER, "t-other");
    expect(named.tenantId).toBe("t-other");
    expect(named.crossTenant).toBe(true);
    // Naming its own tenant is not cross-tenant, and neither is naming none.
    expect(resolveTenantScope(SUPER, "t-platform").crossTenant).toBe(false);
    expect(resolveTenantScope(SUPER, null).crossTenant).toBe(false);
  });

  test("the underlying helper re-checks SUPERADMIN and throws synchronously", () => {
    expect(() => asTenantForAnotherTenant(ADMIN, "t-other", async () => 1)).toThrow(/SUPERADMIN/);
  });

  test("other roles cannot reach either path", () => {
    for (const role of ["NOC_OPERATOR", "REGIONAL_MANAGER", "FIELD_ENGINEER", "EXECUTIVE", "READONLY", "TECHNICIAN"]) {
      const scope = resolveTenantScope({ tenantId: "t-own", role: role as never }, "t-other");
      expect(scope.crossTenant).toBe(false);
      expect(scope.tenantId).toBe("t-own");
    }
  });
});
