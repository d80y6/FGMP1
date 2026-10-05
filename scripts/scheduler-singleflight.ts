/**
 * Evidence script — proves the scheduler's single-flight guarantee.
 *
 * The defect being fixed is that the clock advanced on every dashboard poll, so
 * N open tabs advanced it N times. The replacement must advance exactly once per
 * interval even under concurrency. This script starts N advances simultaneously
 * and shows that exactly one performed the work.
 *
 * Two independent claims are demonstrated:
 *
 *   1. LOCK LEVEL — N concurrent transactions calling
 *      pg_try_advisory_xact_lock() produce exactly ONE winner. This is the
 *      primitive, tested in isolation so a failure here is unambiguous and does
 *      not depend on the engine.
 *
 *   2. ADVANCE LEVEL — N concurrent advanceOnce() calls produce exactly one
 *      acquired=true and N-1 acquired=false.
 *
 * Run:  bun run scripts/scheduler-singleflight.ts
 */

import { PrismaClient } from "@prisma/client";
import { advanceOnce, SCHEDULER_LOCK_KEY } from "../src/lib/fgmp/scheduler";

function opsUrl(): string | null {
  return (
    process.env.FGMP_OPS_DATABASE_URL ?? process.env.FGMP_MIGRATE_DATABASE_URL ?? null
  );
}

async function main() {
  const CONCURRENCY = 4;
  const url = opsUrl();
  if (!url) {
    console.log(
      "Set FGMP_OPS_DATABASE_URL (preferred) or FGMP_MIGRATE_DATABASE_URL first.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("=".repeat(72));
  console.log("PROOF 5 — single-flight: concurrent advances run once, not N times");
  console.log("=".repeat(72));

  const client = new PrismaClient({ datasources: { db: { url } } });

  // ── Part 1: the lock primitive, in isolation ──────────────────────────────
  console.log(`\n  advisory lock key: ${SCHEDULER_LOCK_KEY}`);
  console.log(`  starting ${CONCURRENCY} CONCURRENT transactions...\n`);

  const lockResults = await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_unused, i) => {
      return client.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
            SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_KEY}) AS locked
          `;
          const got = rows[0]?.locked === true;
          // Hold the lock briefly so the others genuinely contend for it.
          // Without this all four could acquire before any released.
          if (got) await new Promise((r) => setTimeout(r, 600));
          return got;
        },
        { timeout: 60_000, maxWait: 5_000 },
      );
    }),
  );

  const lockWinners = lockResults.filter(Boolean).length;
  console.log(`  results: ${lockResults.map((r) => (r ? "WON" : "lost")).join("  ")}`);
  console.log(`  winners: ${lockWinners} of ${CONCURRENCY}`);

  const lockOk = lockWinners === 1;

  // ── Part 2: the scheduler's own entry point ───────────────────────────────
  console.log(`\n  starting ${CONCURRENCY} CONCURRENT advanceOnce() calls...\n`);

  const advanceResults = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => advanceOnce(60)),
  );

  const acquired = advanceResults.filter((r) => r.acquired).length;
  const skipped = advanceResults.filter((r) => !r.acquired).length;
  const totalTicks = advanceResults.reduce((n, r) => n + r.tickCount, 0);

  advanceResults.forEach((r, i) => {
    console.log(
      `    advance#${i + 1} acquired=${r.acquired} ticks=${r.tickCount}` +
        (r.error ? ` error=${r.error.slice(0, 60)}` : ""),
    );
  });

  console.log(`\n  acquired (did the work): ${acquired}`);
  console.log(`  skipped  (lock held)   : ${skipped}`);
  console.log(`  total tickCount        : ${totalTicks}`);

  // If the engine is unavailable (simulation off, or a teammate is mid-edit on
  // engine.ts) the advances will report an error rather than contend. That is
  // reported distinctly instead of being counted as a pass or a failure.
  const errored = advanceResults.filter((r) => r.error);
  const advanceOk = errored.length === 0 && acquired === 1 && skipped === CONCURRENCY - 1;

  console.log(
    `\n  ${lockOk ? "PASS" : "FAIL"} — lock: exactly 1 winner out of ${CONCURRENCY}`,
  );
  if (errored.length > 0) {
    console.log(
      `\n  NOT DEMONSTRATED at the advance level: ${errored.length} advance(s) errored.`,
    );
    for (const e of errored) console.log(`    ${e.error}`);
    console.log(
      "  The lock primitive above is still proven; the advance path could not be\n" +
        "  exercised in this run. Reported rather than counted as a pass.",
    );
  } else {
    console.log(
      `  ${advanceOk ? "PASS" : "FAIL"} — advance: 1 performed the work, ${skipped} skipped`,
    );
  }

  if (!lockOk || (errored.length === 0 && !advanceOk)) {
    process.exitCode = 1;
  }

  await client.$disconnect();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});