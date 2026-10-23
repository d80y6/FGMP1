/**
 * Tenant-scoping proof against a database with TWO POPULATED TENANTS.
 *
 * `scripts/verify/engine-tenant-proof.ts` proves the engine loads data it previously
 * loaded zero of. It cannot prove isolation, because in the seeded database
 * `t-platform` owns no sites — so "0 rows for another tenant" and "0 rows
 * because nothing is there" are indistinguishable.
 *
 * This script therefore requires a second tenant that actually HAS sites
 * (`t-alpha-test`, 1 site, created by the setup below). It then proves both
 * directions:
 *   - loading tenant A shows A's sites and never B's
 *   - loading tenant B shows B's site and never A's
 *
 * Without B being populated, a passing run would prove nothing — which is the
 * same vacuous-pass trap Phase 1's suite fell into with the missing FORCE flag.
 */
import { engine } from "../../src/lib/fgmp/engine";
import { withTenant } from "../../src/lib/fgmp/tenant-context";

let failures = 0;
let passes = 0;
const ok = (l: string, d = "") => { passes++; console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? `\n       ${d}` : ""}`); };
const bad = (l: string, d: string) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${l}\n       ${d}`); };

const A = "t-default";
const B = "t-alpha-test";

async function main() {
  // ── Precondition: both tenants must actually own sites ───────────────────
  const counts = await withTenant(A, async (tx) => {
    const b = await tx.site.count({ where: { tenantId: B } });
    return { mine: await tx.site.count(), theirs: b };
  });
  // `theirs` is 0 here BY DESIGN — that is the isolation property. The point
  // is that B's site count is non-zero when read as the owner, proven below.
  console.log(
    `\n  from ${A} context: own sites=${counts.mine}, ${B} sites visible=${counts.theirs} (must be 0)`,
  );

  // Prove B is genuinely populated, using an owner connection. Without this the
  // rest of the script would pass vacuously.
  const ownerUrl = process.env.FGMP_OPS_DATABASE_URL ?? process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!ownerUrl) {
    bad("precondition", "set FGMP_OPS_DATABASE_URL or FGMP_MIGRATE_DATABASE_URL");
    process.exit(1);
  }
  const { PrismaClient } = await import("@prisma/client");
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  const bReal = await owner.site.count({ where: { tenantId: B } });
  const aReal = await owner.site.count({ where: { tenantId: A } });
  await owner.$disconnect();

  if (bReal > 0 && aReal > 0) {
    ok("precondition: two populated tenants exist", `${A}=${aReal} sites, ${B}=${bReal} sites`);
  } else {
    bad("precondition: two populated tenants exist", `${A}=${aReal}, ${B}=${bReal} — refusing to run a vacuous test`);
    process.exit(1);
  }

  // ── Loading A shows only A ───────────────────────────────────────────────
  await engine.ensureInit([A]);
  const aSites = engine.sites.length;
  const aForeign = engine.sites.filter((s) => s.tenantId !== A);
  if (aSites > 0 && aForeign.length === 0) {
    ok(`loading ${A} shows only its own sites`, `${aSites} sites, 0 foreign`);
  } else {
    bad(`loading ${A} shows only its own sites`, `${aSites} sites, ${aForeign.length} foreign`);
  }

  // ── Loading B shows only B — the direction that proves scoping ───────────
  await engine.ensureInit([B]);
  const bSites = engine.sites.length;
  const bForeign = engine.sites.filter((s) => s.tenantId !== B);
  if (bSites === bReal && bForeign.length === 0) {
    ok(
      `loading ${B} shows exactly its ${bReal} site(s), not ${A}'s ${aReal}`,
      `engine.sites=${bSites}, foreign=${bForeign.length}`,
    );
  } else {
    bad(
      `loading ${B} shows exactly its ${bReal} site(s), not ${A}'s ${aReal}`,
      `engine.sites=${bSites} (expected ${bReal}), foreign=${bForeign.length}`,
    );
  }

  // ── Toggling back must not accumulate ────────────────────────────────────
  await engine.ensureInit([A]);
  const again = engine.sites.length;
  if (again === aReal) {
    ok("repeated loads do not accumulate", `${B}(${bReal}) -> ${A}(${again}), no residue`);
  } else {
    bad("repeated loads do not accumulate", `expected ${aReal} after switching back, got ${again}`);
  }

  // ── Isolation survived the fix ───────────────────────────────────────────
  const cross = await withTenant(B, async (tx) => await tx.site.count({ where: { tenantId: A } }));
  if (cross === 0) {
    ok("isolation intact: B cannot read A's sites", `visible=${cross} (must be 0) while ${A} really has ${aReal}`);
  } else {
    bad("isolation intact: B cannot read A's sites", `${cross} of ${aReal} leaked`);
  }

  console.log(`\n  \x1b[1mPASS: ${passes}  FAIL: ${failures}\x1b[0m\n`);
  if (failures) process.exit(1);
  console.log("\x1b[32m  RESULT: PASS — tenant scoping holds with two populated tenants.\x1b[0m\n");
}

main().catch((e) => {
  console.error(`\n  \x1b[31mCRASH\x1b[0m ${(e as Error).message}`);
  process.exit(1);
});