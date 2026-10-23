/**
 * Phase 1 step 1 — PostgreSQL runtime smoke test.
 *
 * Verifies the migrated schema actually works against a live PostgreSQL
 * instance: creates the full geography hierarchy, a tenant, a user, a site,
 * an asset and a telemetry reading, then reads them back with relations.
 *
 * ── Why two clients ────────────────────────────────────────────────────────
 * RLS is FORCE-enabled on every tenant-carrying table (step 6), so an INSERT
 * with no `app.tenant_id` in scope fails its WITH CHECK:
 *
 *   ERROR: new row violates row-level security policy for table "User"
 *
 * This script therefore uses TWO connections, and the split is the point of the
 * test rather than a workaround:
 *
 *   systemDb() — the OWNER role (FGMP_MIGRATE_DATABASE_URL). Fixture setup
 *     only. It seeds its OWN tenant (t-smoke), so this is not a bypass of a
 *     tenant boundary: it is system-level setup for a tenant that did not
 *     exist before the run.
 *
 *   db — the APP role (DATABASE_URL, non-owner, RLS enforced). All verification
 *     reads go through this one, inside withTenant(), which proves the runtime
 *     role still has the privileges it needs AND that the policies are live:
 *     a read with no tenant context must return zero rows.
 *
 * Run:
 *   DATABASE_URL=postgresql://fgmp_app:… \
 *   FGMP_MIGRATE_DATABASE_URL=postgresql://fgmp_migrate:… \
 *   bun scripts/verify/smoke-postgres.ts
 */

import { PrismaClient } from "@prisma/client";
import { withTenant, TenantContextError } from "@/lib/fgmp/tenant-context";

/** Tenant-scoped to this script. Never touches the seeded fleet. */
const TENANT_ID = "t-smoke";

/**
 * Owner-role client for fixture setup. Mirrors systemDb() in
 * src/lib/fgmp/seed.ts — same env var, same rationale.
 */
let ownerClient: PrismaClient | null = null;

function systemDb(): PrismaClient {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FGMP_MIGRATE_DATABASE_URL is required: RLS blocks fixture writes on the " +
        "app role. Provide the owner/migration connection URL.",
    );
  }
  if (!ownerClient) {
    ownerClient = new PrismaClient({
      datasources: { db: { url } },
      log: [
        { level: "warn", emit: "stdout" as const },
        { level: "error", emit: "stdout" as const },
      ],
    });
  }
  return ownerClient;
}

/** The RLS-enforced app role. Every read below runs on this connection. */
const db = new PrismaClient();

function ok(label: string, detail: string) {
  console.log(`  ok  ${label.padEnd(16)} ${detail}`);
}

/**
 * Remove this script's fixture, children first.
 *
 * Every delete is filtered to the smoke tenant's OWN ids, so the seeded fleet
 * (t-default) is never touched. Tolerates a partial fixture from a previous
 * failed run.
 */
async function cleanup(owner: PrismaClient) {
  const site = await owner.site.findFirst({ where: { id: "s-1" }, select: { id: true } });
  await owner.sensorReading.deleteMany({ where: { siteId: "s-1" } });
  await owner.fuelTank.deleteMany({ where: { siteId: "s-1" } });
  await owner.siteEvent.deleteMany({ where: { siteId: "s-1" } });
  await owner.site.deleteMany({ where: { id: "s-1" } });
  await owner.district.deleteMany({ where: { id: "d-1" } });
  await owner.governorate.deleteMany({ where: { id: "g-1" } });
  await owner.region.deleteMany({ where: { id: "r-1" } });
  await owner.user.deleteMany({ where: { id: "u-1" } });
  await owner.tenant.deleteMany({ where: { id: TENANT_ID } });
  void site;
}

async function setupFixtures() {
  const owner = systemDb();

  // Scope the fixture to its own tenant and delete only that. An earlier
  // revision wiped the whole database, which made the test destructive: run
  // it after seedIfNeeded() and it would delete the seeded fleet.
  //
  // The teardown must be explicit and ordered. The foreign keys from User,
  // Region, Site and AlarmSuppression to Tenant are ON DELETE RESTRICT, not
  // CASCADE (deliberate — a tenant that owns assets must not be deletable), so
  // "delete the tenant and let it cascade" does not work. Children go first,
  // then the tenant.
  await cleanup(owner);

  const tenant = await owner.tenant.create({
    data: {
      id: TENANT_ID,
      name: "Smoke Test Tenant",
      code: "SMOKE-TEST",
      country: "Yemen",
    },
  });
  ok("tenant", tenant.code);

  const user = await owner.user.create({
    data: {
      id: "u-1",
      tenantId: tenant.id,
      email: "smoke@example.com",
      name: "Smoke Test",
      role: "ADMIN",
      passwordHash: "x",
    },
  });
  ok("user", user.email);

  const region = await owner.region.create({
    data: { id: "r-1", tenantId: tenant.id, name: "Central Highlands" },
  });
  const governorate = await owner.governorate.create({
    data: { id: "g-1", regionId: region.id, name: "Sanaa" },
  });
  const district = await owner.district.create({
    data: { id: "d-1", governorateId: governorate.id, name: "Az zal" },
  });
  ok("geography", `${region.name} > ${governorate.name} > ${district.name}`);

  const site = await owner.site.create({
    data: {
      id: "s-1",
      tenantId: tenant.id,
      regionId: region.id,
      governorateId: governorate.id,
      districtId: district.id,
      code: "S1",
      name: "Smoke Site",
      address: "addr",
      latitude: 15.3,
      longitude: 44.2,
    },
  });
  ok("site", `${site.code} @ ${site.latitude},${site.longitude}`);

  const tank = await owner.fuelTank.create({
    data: {
      siteId: site.id,
      tenantId: tenant.id,
      label: "T1",
      capacityLitres: 5000,
      currentLitres: 3000,
      // Required strapping points: [{litres, percent}]
      calibration: JSON.stringify([
        { litres: 0, percent: 0 },
        { litres: 5000, percent: 100 },
      ]),
      lowThreshold: 1000,
      criticalThreshold: 500,
    },
  });
  ok("tank", `${tank.label} ${tank.currentLitres} L`);

  const reading = await owner.sensorReading.create({
    data: {
      siteId: site.id,
      tenantId: tenant.id,
      entityKind: "TANK",
      entityId: tank.id,
      metric: "level",
      value: 3000,
    },
  });
  ok("reading", `${reading.metric}=${reading.value}`);
}

async function verifyAsAppRole() {
  // 1. The policies are actually live: with no tenant context the app role
  //    must see nothing at all. If this returned rows, RLS is not enforcing.
  const unscoped = await db.site.count();
  if (unscoped !== 0) {
    throw new Error(
      `RLS is not enforcing: an unscoped read as the app role returned ` +
        `${unscoped} row(s). Expected 0 (fail closed).`,
    );
  }
  ok("rls fails closed", "unscoped app-role read returned 0 rows");

  // 2. With tenant context the same role reads its own rows, relations intact.
  await withTenant(TENANT_ID, async (tx) => {
    const withRelations = await tx.site.findFirst({
      where: { id: "s-1" },
      include: { tenant: true, region: true, tanks: true },
    });
    if (!withRelations) throw new Error("relation read returned no row");
    ok(
      "relations",
      `${withRelations.code} | tenant=${withRelations.tenant.code} | ` +
        `region=${withRelations.region.name} | tanks=${withRelations.tanks.length}`,
    );

    // Unscoped read INSIDE the context still only sees this tenant.
    const mine = await tx.site.count();
    if (mine !== 1) {
      throw new Error(`expected exactly 1 site in tenant context, saw ${mine}`);
    }
    ok("tenant scoped", `unscoped read inside withTenant() returned ${mine} row(s)`);
  });

  // 3. Cross-tenant write is refused by the database, as the app role.
  let blocked = false;
  try {
    await withTenant("t-default", async (tx) => {
      await tx.siteEvent.create({
        data: {
          id: "smoke-cross-tenant",
          siteId: "s-1",
          tenantId: "t-platform",
          kind: "INFO",
          message: "must be rejected",
        },
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/row-level security/i.test(msg)) blocked = true;
    else throw err;
  }
  if (!blocked) {
    throw new Error("cross-tenant INSERT was not rejected by RLS");
  }
  ok("rls blocks write", "cross-tenant INSERT rejected by WITH CHECK");
}

async function main() {
  const seededSitesBefore = await systemDb().site.count({
    where: { code: { not: "S1" } },
  });
  console.log(`\n  seeded sites before: ${seededSitesBefore}`);

  await setupFixtures();
  await verifyAsAppRole();

  const seededSitesAfter = await systemDb().site.count({
    where: { code: { not: "S1" } },
  });
  if (seededSitesAfter !== seededSitesBefore) {
    throw new Error(
      `smoke test was destructive: seeded sites went from ` +
        `${seededSitesBefore} to ${seededSitesAfter}`,
    );
  }
  ok("non-destructive", `seeded sites unchanged (${seededSitesAfter})`);

  // Leave no residue: the fixture is deleted so the site count returns to its
  // pre-run value. Without this the S1 site accumulated on every run.
  await cleanup(systemDb());
  const sitesAfterCleanup = await systemDb().site.count({
    where: { code: { not: "S1" } },
  });
  ok("cleanup", `fixture removed; seeded sites still ${sitesAfterCleanup}`);

  console.log("\nPASS — schema works on PostgreSQL; RLS enforces as the app role.\n");
}

main()
  .catch((err) => {
    console.error("\nFAIL:", err instanceof TenantContextError ? err.message : err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await ownerClient?.$disconnect();
  });