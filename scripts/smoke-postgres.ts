/**
 * Phase 1 step 1 — PostgreSQL runtime smoke test.
 *
 * Verifies the migrated schema actually works against a live PostgreSQL
 * instance: creates the full geography hierarchy, a tenant, a user, a site,
 * an asset and a telemetry reading, then reads them back with relations.
 *
 * Run as fgmp_app (the RLS-enforced, non-owner role) so this also proves the
 * application's runtime role has the privileges it needs — SELECT/INSERT on
 * tables, but not DDL.
 *
 *   DATABASE_URL=postgresql://fgmp_app:... bun scripts/smoke-postgres.ts
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function ok(label: string, detail: string) {
  console.log(`  ok  ${label.padEnd(12)} ${detail}`);
}

async function main() {
  // Children first: the hierarchy cascades, but explicit order keeps the
  // teardown honest if a previous run aborted mid-way.
  await db.sensorReading.deleteMany();
  await db.fuelTank.deleteMany();
  await db.site.deleteMany();
  await db.district.deleteMany();
  await db.governorate.deleteMany();
  await db.region.deleteMany();
  await db.user.deleteMany();
  await db.tenant.deleteMany();

  const tenant = await db.tenant.create({
    data: {
      id: "t-default",
      name: "National Telecom",
      code: "NAT-TELCO",
      country: "Yemen",
    },
  });
  ok("tenant", tenant.code);

  const user = await db.user.create({
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

  const region = await db.region.create({
    data: { id: "r-1", tenantId: tenant.id, name: "Central Highlands" },
  });
  const governorate = await db.governorate.create({
    data: { id: "g-1", regionId: region.id, name: "Sanaa" },
  });
  const district = await db.district.create({
    data: { id: "d-1", governorateId: governorate.id, name: "Az zal" },
  });
  ok("geography", `${region.name} > ${governorate.name} > ${district.name}`);

  const site = await db.site.create({
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

  const tank = await db.fuelTank.create({
    data: {
      siteId: site.id,
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

  const reading = await db.sensorReading.create({
    data: {
      siteId: site.id,
      entityKind: "TANK",
      entityId: tank.id,
      metric: "level",
      value: 3000,
    },
  });
  ok("reading", `${reading.metric}=${reading.value}`);

  const withRelations = await db.site.findFirst({
    include: { tenant: true, region: true, tanks: true },
  });
  if (!withRelations) throw new Error("relation read returned no row");
  ok(
    "relations",
    `${withRelations.code} | tenant=${withRelations.tenant.code} | region=${withRelations.region.name} | tanks=${withRelations.tanks.length}`,
  );

  console.log(
    `\n  counts: tenants=${await db.tenant.count()} users=${await db.user.count()} ` +
      `sites=${await db.site.count()} tanks=${await db.fuelTank.count()} readings=${await db.sensorReading.count()}`,
  );
  console.log("\nPASS — schema works on PostgreSQL as the non-owner app role.\n");
}

main()
  .catch((err) => {
    console.error("\nFAIL:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
