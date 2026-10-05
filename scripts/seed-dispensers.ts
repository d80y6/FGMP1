// Standalone script to seed fuel dispensers + historical transactions into an
// already-seeded FGMP database. Run with: bun run scripts/seed-dispensers.ts
//
// This is idempotent: if dispensers already exist, it exits without changes.
import { PrismaClient } from "@prisma/client";

/**
 * Owner-role client for system-level seeding (Phase 1 step 6).
 *
 * RLS is FORCE-enabled on every tenant-carrying table, so a write with no
 * `app.tenant_id` in scope fails its WITH CHECK:
 *
 *   ERROR: new row violates row-level security policy for table "User"
 *
 * These scripts seed across tenants (and seed the tenants themselves), so a
 * single per-tenant context cannot cover the work. They run on the owner role
 * instead — the same pattern as src/lib/fgmp/seed.ts. This is a ROLE SPLIT,
 * not a bypass of a tenant boundary: the script picks which tenant each row
 * belongs to.
 */
function systemDb(): PrismaClient {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error(
      "FGMP_MIGRATE_DATABASE_URL is required: RLS blocks writes on the app role.",
    );
  }
  return new PrismaClient({
    datasources: { db: { url } },
    log: [
      { level: "warn", emit: "stdout" as const },
      { level: "error", emit: "stdout" as const },
    ],
  });
}

const db = systemDb();

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20240617);
function pick<T>(arr: T[]): T { return arr[Math.floor(rnd() * arr.length)]; }
function range(min: number, max: number) { return min + rnd() * (max - min); }
function intRange(min: number, max: number) { return Math.floor(range(min, max + 1)); }

const DISPENSER_MAKERS = [
  { m: "Wayne", models: ["iX 700", "Helix 1000", "Quantum 5"] },
  { m: "Gilbarco", models: ["Encore 500", "Encore 700 S", "Legacy 200"] },
  { m: "Tatsuno", models: ["M-15", "M-50", "T-8"] },
  { m: "Dresser", models: ["Clearance 100", "Atlas 200"] },
];
// `vid` / `km` are carried for readability of the fixture, but
// FuelTransaction has no vehicleId / odometerKm column, so only `plate` is
// persisted (see the create() below).
const VEHICLES = [
  { plate: "ADA-1023", vid: "TRK-001", km: 142000 },
  { plate: "ADA-1108", vid: "TRK-002", km: 88500 },
  { plate: "HDM-4521", vid: "GEN-TRAILER-1", km: 31200 },
  { plate: "SBN-3301", vid: "TRK-003", km: 256000 },
  { plate: "ADN-7788", vid: "VAN-001", km: 67800 },
  { plate: "TIZ-9900", vid: "TRK-004", km: 192000 },
  { plate: "HDM-7781", vid: "TRK-005", km: 145000 },
  { plate: "ADA-5634", vid: "GEN-TRAILER-2", km: 25400 },
];
const DISPENSER_FW = ["v1.0.0", "v1.2.0", "v1.2.4", "v2.0.1", "v2.1.0"];
const OP_NAMES = ["Hassan A.", "Ali M.", "Mohammed S.", "Fares K.", "Yousef R.", "Ibrahim N."];

async function main() {
  const existing = await db.fuelDispenser.count();
  if (existing > 0) {
    console.log(`Dispensers already seeded (${existing}). Skipping.`);
    return;
  }

  const allSites = await db.site.findMany({
    include: { tanks: { take: 1, orderBy: { label: "asc" } } },
  });
  console.log(`Found ${allSites.length} sites. Seeding dispensers…`);

  const now = Date.now();
  const createdDispensers: { id: string; siteId: string; tenantId: string; site: { name: string; code: string }; label: string; pumpNumber: number; totalizerStart: number }[] = [];
  let dispenserCounter = 0;

  for (const site of allSites) {
    const tank = site.tanks[0];
    if (!tank) continue;
    const isHub = /Data Center|Hub|MSC/.test(site.name);
    const hasDispenser = isHub ? rnd() < 0.85 : rnd() < 0.18;
    if (!hasDispenser) continue;
    const nDisp = isHub ? intRange(1, 2) : 1;
    for (let d = 0; d < nDisp; d++) {
      dispenserCounter++;
      const maker = pick(DISPENSER_MAKERS);
      const totalizerStart = Math.round(range(5000, 250000) * 10) / 10;
      const mode = pick(["AUTO", "AUTO", "MANUAL", "LOCKED"]) as "AUTO" | "MANUAL" | "LOCKED";
      const status = mode === "LOCKED" ? "STOPPED" : pick(["IDLE", "IDLE", "IDLE", "AUTHORIZED", "DISPENSING"]) as "IDLE" | "AUTHORIZED" | "DISPENSING";
      const fw = pick(DISPENSER_FW);
      const mac = `ESP32-${site.code.replace("SITE-", "")}-${d + 1}-${pick(["A", "B", "C", "D"])}${intRange(1000, 9999)}`;
      const ip = `10.${intRange(20, 80)}.${intRange(0, 255)}.${intRange(2, 254)}`;
      const dispenser = await db.fuelDispenser.create({
        data: {
          siteId: site.id,
          tenantId: site.tenantId,
          label: `Dispenser ${String.fromCharCode(65 + d)}`,
          pumpNumber: d + 1,
          nozzleCount: pick([1, 1, 2]),
          manufacturer: maker.m,
          model: pick(maker.models),
          espDeviceId: mac,
          espFirmware: fw,
          ipAddress: ip,
          // rs485Address IS the Modbus unit address (see prisma/schema.prisma).
          rs485Address: intRange(1, 247),
          rs485Baudrate: pick([9600, 19200]),
          status,
          mode,
          presetVolumeLitres: pick([0, 0, 50, 100, 200]),
          totalizerLitres: totalizerStart,
          flowRateLpm: status === "DISPENSING" ? Math.round(range(20, 65) * 10) / 10 : 0,
          lastCommAt: new Date(),
          lastTransactionAt: new Date(now - intRange(1, 240) * 60000),
        },
      });
      createdDispensers.push({
        id: dispenser.id,
        siteId: site.id,
        tenantId: site.tenantId,
        site: { name: site.name, code: site.code },
        label: dispenser.label,
        pumpNumber: dispenser.pumpNumber,
        totalizerStart,
      });
    }
  }
  console.log(`Created ${dispenserCounter} dispensers.`);

  // Historical transactions
  const unitPriceYer = 530;
  let totalTxns = 0;
  for (const disp of createdDispensers) {
    const nTxn = intRange(5, 15);
    let runningTotalizer = disp.totalizerStart;
    let cursor = now - intRange(10, 90) * 60000;
    for (let i = 0; i < nTxn; i++) {
      const volume = Math.round(range(15, 180) * 10) / 10;
      const durationSec = intRange(45, 480);
      const startedAt = cursor - durationSec * 1000;
      const endedAt = cursor;
      const totalizerEnd = Math.round((runningTotalizer + volume) * 10) / 10;
      runningTotalizer = totalizerEnd;
      const veh = pick(VEHICLES);
      // FuelTransaction.status is IN_PROGRESS | COMPLETED | CANCELLED | FAILED;
      // the fixture's "INTERRUPTED" is mapped onto FAILED (closest match).
      const status = pick(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "FAILED", "CANCELLED"]) as
        | "COMPLETED" | "FAILED" | "CANCELLED";
      await db.fuelTransaction.create({
        data: {
          dispenserId: disp.id,
          siteId: disp.siteId,
          tenantId: disp.tenantId,
          nozzle: 1,
          startedAt: new Date(startedAt),
          completedAt: new Date(endedAt),
          durationSec,
          volumeLitres: volume,
          unitPriceYer: unitPriceYer,
          amountYer: Math.round(volume * unitPriceYer),
          operatorName: pick(OP_NAMES),
          vehiclePlate: veh.plate,
          status,
        },
      });
      totalTxns++;
      cursor = startedAt - intRange(15, 180) * 60000;
      if (cursor < now - 72 * 3600 * 1000) break;
    }
    await db.fuelDispenser.update({
      where: { id: disp.id },
      data: { totalizerLitres: runningTotalizer },
    });
  }
  console.log(`Created ${totalTxns} historical transactions.`);
}

main()
  .then(() => db.$disconnect())
  .catch((e) => { console.error(e); process.exit(1); });
