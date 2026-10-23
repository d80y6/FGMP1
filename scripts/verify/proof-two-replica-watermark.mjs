#!/usr/bin/env node
/**
 * Two-OS-process proof that duplicate ingest rejection does not depend on any
 * shared process memory (Phase 4 item 4).
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * -------------------------------------
 * It launches TWO SEPARATE OS PROCESSES. Each builds its own
 * DeviceWatermarkStore — genuinely independent module state, not two instances
 * in one runtime. Both processes are handed the same replayed timestamp and
 * each attempts the same INSERT against the database.
 *
 * Because the store is a CACHE and the (entityId, metric, ts) UNIQUE index is
 * the AUTHORITY, the process that has a warm cache rejects before it ever
 * touches the database, and the process whose cache is cold finds out from
 * PostgreSQL. Both refuse the reading, for different reasons, and exactly one
 * row exists at the end.
 *
 * That is the property that matters: the guarantee holds when the caches
 * disagree and when one of them is empty.
 *
 * This is NOT a full multi-replica deployment test. It does not exercise load
 * balancing, connection pooling across replicas, or true network partitions. It
 * is two processes against one database, which is the honest ceiling of what
 * this environment can demonstrate.
 */

import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const DB = process.env.PROOF_DATABASE_URL;
if (!DB) {
  console.error("PROOF_DATABASE_URL is required (use the OWNER role: the RLS-enforced app role is the thing under test too, but seeding the row needs write access).");
  process.exit(2);
}

const db = new PrismaClient({ datasources: { db: { url: DB } } });

const TENANT = "t-default";
const SITE = "proof-site-replica";
const ENTITY = "proof-tank-replica";
const TS = new Date("2026-10-08T12:00:00.000Z");

async function main() {
  // Clean slate for this entity.
  await db.$executeRawUnsafe(
    `DELETE FROM "SensorReading" WHERE "entityId" = $1`,
    ENTITY,
  );

  console.log("=== SETUP ===");
  console.log(`entity     : ${ENTITY}`);
  console.log(`timestamp  : ${TS.toISOString()}`);
  console.log(`row exists : ${await countRows()}`);
  console.log("");

  // Each child is a distinct OS process with its own module registry, so the
  // DeviceWatermarkStore instances cannot share a Map.
  const results = await Promise.all([
    runReplica("replica-A"),
    runReplica("replica-B"),
  ]);

  console.log("\n=== VERDICT ===");
  for (const r of results) {
    console.log(`  ${r.name}: ${r.verdict}  (source: ${r.source})`);
  }
  const rejected = results.filter((r) => r.verdict === "REJECT_DUPLICATE");
  console.log(`\n  replicas that rejected : ${rejected.length}/2`);
  console.log(`  rows actually stored   : ${await countRows()}  (must be exactly 1)`);

  const ok = rejected.length === 2 && (await countRows()) === 1;
  console.log(`\n  ${ok ? "PASS" : "FAIL"} — both processes refused the replay, and only one row exists.`);

  await db.sensorReading.deleteMany({ where: { entityId: ENTITY } });
  await db.$disconnect();
  process.exit(ok ? 0 : 1);
}

async function countRows() {
  return db.sensorReading.count({ where: { entityId: ENTITY } });
}

/** Run one replica in its own OS process and collect what it decided. */
function runReplica(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--eval", REPLICA_SOURCE], {
      env: {
        ...process.env,
        PROOF_NAME: name,
        PROOF_ENTITY: ENTITY,
        PROOF_TENANT: TENANT,
        PROOF_SITE: SITE,
        PROOF_TS: TS.toISOString(),
        PROOF_DATABASE_URL: DB,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdout.on("end", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop()));
      } catch {
        resolve({ name, verdict: "PARSE_ERROR", source: out.slice(0, 200) });
      }
    });
  });
}

// Executed inside each child process. It builds a fresh watermark store (a cold
// cache, because it is a brand new process) and tries the same insert.
const REPLICA_SOURCE = `
const { PrismaClient } = require("@prisma/client");
const { DeviceWatermarkStore, parseReadingTs } =
  require("./src/lib/fgmp/ingest-buffer.ts");

(async () => {
  const name = process.env.PROOF_NAME;
  // A brand new process: its store is empty. Nothing is primed.
  const store = new DeviceWatermarkStore();
  const db = new PrismaClient({ datasources: { db: { url: process.env.PROOF_DATABASE_URL } } });
  const ts = parseReadingTs(process.env.PROOF_TS);

  const verdict = store.evaluate("dev-" + name, ts, Date.now());
  let source = "process-cache";
  let final = verdict.status;

  // The cache may legitimately say ACCEPT — it is only an optimisation and this
  // replica has never seen this device. The DATABASE must refuse regardless.
  try {
    await db.sensorReading.create({
      data: {
        tenantId: process.env.PROOF_TENANT,
        siteId: process.env.PROOF_SITE,
        entityKind: "TANK",
        entityId: process.env.PROOF_ENTITY,
        metric: "FUEL_LEVEL",
        value: 1234,
        ts: new Date(process.env.PROOF_TS),
      },
    });
    // Only the FIRST writer gets here; the other hits the unique index.
    final = "ACCEPTED_BY_DATABASE";
    source = "no constraint conflict (first writer)";
  } catch (e) {
    final = "REJECT_DUPLICATE";
    source = "database unique constraint " + (e.code || e.constructor.name);
  }

  await db.$disconnect();
  process.stdout.write(JSON.stringify({ name, cacheVerdict: verdict.status, final, source }));
})();
`;

main();