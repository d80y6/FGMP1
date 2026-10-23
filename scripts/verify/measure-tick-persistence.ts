/**
 * Phase 5 Step 2 — MEASUREMENT. Not production code.
 *
 * What does writing engine state back on every tick actually cost, at the real
 * asset count and the real cadence? Three variants, selectable so one failing
 * does not hide the others:
 *   A  row-at-a-time, autocommit per statement
 *   B  row-at-a-time inside ONE transaction holding the advisory lock
 *   C  set-based UPDATE ... FROM unnest — 4 statements per tick
 *
 * Run:  bun scripts/verify/measure-tick-persistence.ts [A|B|C]
 */
import { Prisma, PrismaClient } from "@prisma/client";

const MIGRATE_URL =
  process.env.MEASURE_URL ??
  "postgresql://fgmp_migrate:testmigrate123@127.0.0.1:5433/fgmp?schema=public";
const SCHEDULER_LOCK_KEY = 0x4647_4d50; // "FGMP" — matches scheduler.ts:74
const TICK_SECONDS = 5;
const TICKS = Number(process.env.MEASURE_TICKS ?? 10);

async function main() {
  const which = (process.argv[2] ?? "C").toUpperCase();
  const db = new PrismaClient({ datasourceUrl: MIGRATE_URL });

  const [sites, tanks, generators, batteries, dispensers] = await Promise.all([
    db.site.count(), db.fuelTank.count(), db.generator.count(),
    db.batteryBank.count(), db.fuelDispenser.count(),
  ]);
  const assets = tanks + generators + batteries + dispensers;
  console.log(`assets=${assets} (sites ${sites}, tanks ${tanks}, gens ${generators}, batteries ${batteries}, dispensers ${dispensers})`);
  console.log(`cadence=${TICK_SECONDS}s -> ${(assets / TICK_SECONDS).toFixed(1)} rows/sec, ${assets * 60} rows/min`);
  console.log(`variant=${which} ticks=${TICKS}\n`);

  const [tR, gR, bR, dR] = await Promise.all([
    db.fuelTank.findMany({ select: { id: true } }),
    db.generator.findMany({ select: { id: true } }),
    db.batteryBank.findMany({ select: { id: true } }),
    db.fuelDispenser.findMany({ select: { id: true } }),
  ]);
  const tankIds = tR.map((r) => r.id), genIds = gR.map((r) => r.id);
  const battIds = bR.map((r) => r.id), dispIds = dR.map((r) => r.id);

  const t0 = performance.now();
  let rows = 0, failed: string | null = null;

  try {
    if (which === "A") {
      for (let i = 0; i < TICKS; i++) {
        for (const id of tankIds) {
          await db.fuelTank.update({ where: { id }, data: { currentLitres: new Prisma.Decimal(1234.567), lastReadingAt: new Date() } }); rows++;
        }
        for (const id of genIds) {
          await db.generator.update({ where: { id }, data: { temperatureC: 78.5, loadKw: 12.5, lastReadingAt: new Date() } }); rows++;
        }
        for (const id of battIds) {
          await db.batteryBank.update({ where: { id }, data: { voltage: 48.2, stateOfCharge: 87.5, lastReadingAt: new Date() } }); rows++;
        }
        for (const id of dispIds) {
          await db.fuelDispenser.update({ where: { id }, data: { flowRateLpm: new Prisma.Decimal(37.5), lastCommAt: new Date() } }); rows++;
        }
      }
    } else if (which === "B") {
      for (let i = 0; i < TICKS; i++) {
        rows += await db.$transaction(async (tx) => {
          const [lk] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${Prisma.raw(String(SCHEDULER_LOCK_KEY))}::bigint) AS locked`;
          if (!lk?.locked) return 0;
          let n = 0;
          for (const id of tankIds) { await tx.fuelTank.update({ where: { id }, data: { currentLitres: new Prisma.Decimal(1234.567), lastReadingAt: new Date() } }); n++; }
          for (const id of genIds) { await tx.generator.update({ where: { id }, data: { temperatureC: 78.5, loadKw: 12.5, lastReadingAt: new Date() } }); n++; }
          for (const id of battIds) { await tx.batteryBank.update({ where: { id }, data: { voltage: 48.2, stateOfCharge: 87.5, lastReadingAt: new Date() } }); n++; }
          for (const id of dispIds) { await tx.fuelDispenser.update({ where: { id }, data: { flowRateLpm: new Prisma.Decimal(37.5), lastCommAt: new Date() } }); n++; }
          return n;
        }, { timeout: 120_000, maxWait: 10_000 });
      }
    } else {
      for (let i = 0; i < TICKS; i++) {
        const n = await db.$transaction(async (tx) => {
          const [lk] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${Prisma.raw(String(SCHEDULER_LOCK_KEY))}::bigint) AS locked`;
          if (!lk?.locked) { console.log('  [lock NOT acquired this tick]'); return 0; }
          const now = new Date();
          // NOTE: an earlier version of this prototype used
          // `unnest($1::text[], $2::numeric[], ...)` with $executeRawUnsafe.
          // That is silently invalid under Prisma: the driver passes the JS
          // array as a SINGLE parameter, so the query reports "incorrect number
          // of parameters. Expected: 3, actual: 1" — and the enclosing catch
          // turned that into a reported rows=0, which reads exactly like "the
          // lock was never acquired". Building an explicit VALUES list with
          // Prisma.join gives one bind parameter per element and works.
          const tankVals = Prisma.join(
            tankIds.map((id, k) => Prisma.sql`(${id}::text, ${1234.567 + k}::numeric, ${now}::timestamptz)`),
          );
          const genVals = Prisma.join(
            genIds.map((id, k) => Prisma.sql`(${id}::text, ${78.5 + k * 0.01}::double precision, ${12.5}::double precision, ${now}::timestamptz)`),
          );
          const battVals = Prisma.join(
            battIds.map((id, k) => Prisma.sql`(${id}::text, ${48.2 + k * 0.01}::double precision, ${87.5}::double precision, ${now}::timestamptz)`),
          );
          const dispVals = Prisma.join(
            dispIds.map((id, k) => Prisma.sql`(${id}::text, ${37.5 + k * 0.01}::numeric, ${now}::timestamptz)`),
          );
          const r1 = await tx.$executeRaw`UPDATE "FuelTank" t SET "currentLitres" = v.litres, "lastReadingAt" = v.ts
             FROM (VALUES ${tankVals}) AS v(id, litres, ts) WHERE t.id = v.id`;
          const r2 = await tx.$executeRaw`UPDATE "Generator" g SET "temperatureC" = v.temp, "loadKw" = v.load, "lastReadingAt" = v.ts
             FROM (VALUES ${genVals}) AS v(id, temp, load, ts) WHERE g.id = v.id`;
          const r3 = await tx.$executeRaw`UPDATE "BatteryBank" b SET "voltage" = v.vol, "stateOfCharge" = v.soc, "lastReadingAt" = v.ts
             FROM (VALUES ${battVals}) AS v(id, vol, soc, ts) WHERE b.id = v.id`;
          const r4 = await tx.$executeRaw`UPDATE "FuelDispenser" d SET "flowRateLpm" = v.flow, "lastCommAt" = v.ts
             FROM (VALUES ${dispVals}) AS v(id, flow, ts) WHERE d.id = v.id`;
          return r1 + r2 + r3 + r4;
        });
        rows += n;
      }
    }
  } catch (e) {
    failed = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }

  const ms = performance.now() - t0;
  const perTick = ms / TICKS, budget = TICK_SECONDS * 1000;
  const pct = (perTick / budget) * 100;
  console.log(`rows=${rows} elapsed=${(ms / 1000).toFixed(2)}s rows/sec=${(rows / (ms / 1000)).toFixed(0)}`);
  console.log(`ms/tick=${perTick.toFixed(1)} budget=${budget}ms -> ${pct.toFixed(1)}% of budget`);
  console.log(failed ? `FAILED: ${failed}` : `VERDICT: ${pct < 50 ? "OK" : pct < 100 ? "TIGHT" : "OVER BUDGET"}`);
  await db.$disconnect();
}

main().catch((e) => { console.error(String(e).split("\n")[0]); process.exit(1); });
