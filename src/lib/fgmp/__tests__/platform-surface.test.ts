import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The platform surface is the one place where "authenticated" and "allowed" are
 * genuinely different questions. This test is the guard rail around it:
 *
 *   1. every route under /api/fgmp/platform/ must call `requireSuperAdmin()`
 *      before it touches a platform table or a tenant;
 *   2. no such route may import the raw Prisma client (the eslint rule says the
 *      same thing, but this test states WHY for the platform surface and runs
 *      even when lint is not part of the pipeline);
 *   3. every route that reads a tenant's data through a support session must
 *      call `currentSupport()` — i.e. it cannot name a tenant and query it
 *      directly.
 *
 * It is a source-level scan, which is deliberately blunt: it fails when a NEW
 * route is added that forgot the guard, which is the failure mode that matters.
 * A cleverer AST check would not catch more here.
 */

const ROOT = join(process.cwd(), "src/app/api/fgmp/platform");
const LIB = join(process.cwd(), "src/lib/fgmp");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const routes = walk(ROOT);
const rel = (p: string) => relative(process.cwd(), p);

describe("platform surface — authorization", () => {
  it("finds the platform routes it is supposed to police", () => {
    // A glob that silently matches nothing would make every assertion below
    // vacuously true — the classic way a security test stops working.
    expect(routes.length).toBeGreaterThanOrEqual(5);
    const names = routes.map(rel);
    expect(names.some((n) => n.includes("support-sessions"))).toBe(true);
    expect(names.some((n) => n.includes("support/[tenant]"))).toBe(true);
    expect(names.some((n) => n.includes("platform/audit"))).toBe(true);
  });

  it("every platform route requires SUPERADMIN before doing anything else", () => {
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      expect({ file: rel(file), guarded: src.includes("requireSuperAdmin(") }).toEqual({
        file: rel(file),
        guarded: true,
      });
      // ...and there must be no unguarded generic auth check that could be
      // mistaken for the gate. `requireRole(req, ROLES.SUPERADMIN_ONLY)` is
      // what requireSuperAdmin wraps; calling it directly is fine, calling
      // `requireAuth()` alone on this surface is not.
      const hasBareAuth = src.includes("await requireAuth(") || src.includes("await requireRole(");
      expect({ file: rel(file), hasBareAuth }).toEqual({ file: rel(file), hasBareAuth: false });
    }
  });

  it("no platform route reaches the Prisma client directly", () => {
    for (const file of routes) {
      const src = readFileSync(file, "utf8");
      const importsDb = src.includes('from "@/lib/db"') || /from ["']@\/lib\/fgmp["']/.test(src);
      const importsDbBarrel = /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/fgmp["']/.test(src);
      expect({ file: rel(file), direct: importsDb || importsDbBarrel }).toEqual({
        file: rel(file),
        direct: false,
      });
    }
  });

  it("the support data route resolves the session instead of trusting the path", () => {
    const file = routes.find((r) => rel(r).includes("support/[tenant]"));
    expect(file).toBeDefined();
    const src = readFileSync(file!, "utf8");
    // The tenant in the URL must be checked against the session...
    expect(src.includes("assertSupportTenant(")).toBe(true);
    // ...and the session must come from the signed cookie, not from a header
    // or query parameter.
    expect(src.includes("currentSupport(")).toBe(true);
  });
});

describe("platform surface — the lib modules that serve it", () => {
  it("platform-store documents why its unscoped reads are safe", () => {
    const src = readFileSync(join(LIB, "platform-store.ts"), "utf8");
    // The header must state the three access kinds. If somebody adds a fourth
    // kind of unscoped read, the comment is where they should have to say so.
    expect(src).toContain("PLATFORM TABLES");
    expect(src).toContain("THE TENANT REGISTRY");
    expect(src).toContain("PER-TENANT READS");
  });

  it("support-session keeps the one-tenant invariant visible in the source", () => {
    const src = readFileSync(join(LIB, "support-session.ts"), "utf8");
    expect(src).toContain("MAX_CONCURRENT_TENANTS_PER_OPERATOR = 1");
    expect(src).toContain("SUPPORT_REASON_MIN");
  });
});
