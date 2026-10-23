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

  test("platform tenant detail counts use the explicitly named tenant scope", () => {
    const route = source("src/app/api/fgmp/tenants/[id]/route.ts");
    expect(route).toContain("getTenantMeta(id)");
    expect(route).toContain("tenantCounts(id)");
  });

  test("cross-tenant request-scoped database contexts are limited to named user administration", () => {
    const userAdmin = source("src/app/api/fgmp/users/route.ts");
    expect(userAdmin).toContain("import { asTenant, asTenantForAnotherTenant, resolveTenantScope }");
    expect(userAdmin).toContain("resolveTenantScope(me, searchParams.get(\"tenant\"))");
    expect(userAdmin).toContain("asTenantForAnotherTenant(me, tenantId");

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
    expect(view).toContain("Not measured — no sample row");
    expect(view).toContain("Sampled Helper Check Incomplete");
  });
});
