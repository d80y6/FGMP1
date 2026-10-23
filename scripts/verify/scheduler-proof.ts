/**
 * Evidence script — proves the scheduler advances state with NO client.
 *
 * This is the "close the browser" test. The defect being fixed is that the
 * platform's clock only moved when the dashboard polled /api/fgmp/tick. So the
 * demonstration must involve zero HTTP requests: this script never starts a
 * server and never calls a route.
 *
 * Run:  bun run scripts/verify/scheduler-proof.ts
 */

import { PrismaClient } from "@prisma/client";
import { db } from "../../src/lib/db";
import { startScheduler } from "../../src/lib/fgmp/scheduler";

/** Count simulation events. Monotonic: an advance can only add. */
async function snapshot(): Promise<{ events: number; alarms: number }> {
  const [events, alarms] = await Promise.all([
    db.siteEvent.count(),
    db.alarm.count(),
  ]);
  return { events, alarms };
}

/**
 * A monotonic fingerprint of engine state.
 *
 * Deliberately NOT SiteEvent/Alarm counts. `engine.tick()` mostly advances
 * in-memory state and the simulated clock, and only writes a SiteEvent when a
 * site actually records something — so counting rows reports 0 for a scheduler
 * that is demonstrably working.
 *
 * Sampled immediately after a manual advance (below) rather than after the
 * scheduler loop, because the engine holds only the LAST tenant's state once
 * the loop has swept every tenant. The cumulative `tickCount` returned by
 * advanceOnce is the scheduler-level measure; this is the per-engine measure.
 */
function fingerprint(state: unknown): string {
  const eng = state as {
    tanks?: Array<{ id: string; currentLevelLitres: number }>;
    generators?: Array<{ id: string; runtimeHours: number }>;
  };
  const tanks = eng.tanks ?? [];
  const gens = eng.generators ?? [];
  if (tanks.length === 0 && gens.length === 0) return "(engine holds no state)";
  return (
    tanks
      .slice(0, 6)
      .map((t) => `${t.id}:${Number(t.currentLevelLitres).toFixed(3)}`)
      .join("|") +
    " gens:" +
    gens
      .slice(0, 3)
      .map((g) => `${g.id}:${Number(g.runtimeHours).toFixed(3)}`)
      .join("|")
  );
}

async function main() {
  console.log("=".repeat(72));
  console.log("PROOF 4 — scheduler advances state with ZERO HTTP requests");
  console.log("=".repeat(72));

  // engine.tick() refuses to fabricate telemetry unless simulation is enabled
  // (a guard added in Phase 2 vertical 1 so a developer sees real ingested
  // data rather than generated numbers). This script advances the clock, so it
  // must opt in explicitly — and says so, because it is not pretending to
  // prove anything about real telemetry.
  if (process.env.FGMP_SIMULATION !== "1") {
    console.log(
      "\n  NOTE: FGMP_SIMULATION is not set to 1. engine.tick() refuses to run\n" +
        "  without it, so this proof cannot advance anything. Set FGMP_SIMULATION=1\n" +
        "  to exercise the scheduler's timing and locking, which is what this\n" +
        "  script measures. Telemetry realism is vertical 1's concern, not this one's.\n",
    );
    process.exitCode = 1;
    return;
  }

  const { withTenant } = await import("../../src/lib/fgmp/tenant-context");
  const { engine } = await import("../../src/lib/fgmp/engine");

  // ── Part A: does one manual advance change engine state? ──────────────────
  // Measured on a single tenant so the reading is unambiguous. The engine holds
  // one tenant's state at a time, so after the scheduler sweeps all tenants the
  // in-memory view belongs to whichever ran last.
  const ops = new PrismaClient({
    datasources: {
      db: { url: process.env.FGMP_OPS_DATABASE_URL as string },
    },
  });

  // reload() and tick() run OUTSIDE a transaction. Holding an interactive
  // transaction open across them exceeded Prisma's 5s default and failed with
  // P2028 "Transaction already closed ... 12182 ms passed". The scheduler
  // process runs on the owner role, so the engine's reads are not
  // RLS-restricted and need no transaction-local tenant context here.
  const loadFor = async () => {
    await engine.reload();
    return fingerprint(engine);
  };

  const stateA = await loadFor();
  const before = await withTenant("t-default", () => snapshot());
  console.log(`\n  engine loaded for t-default: ${stateA.slice(0, 100)}`);

  await engine.tick(60);
  const stateB = fingerprint(engine);
  const after1 = await withTenant("t-default", () => snapshot());

  console.log(`\n  after one 60s tick: ${stateB.slice(0, 100)}`);
  console.log(`  a single tick changed engine state: ${stateA !== stateB}`);
  console.log(
    `  persisted delta: events +${after1.events - before.events}, ` +
      `alarms +${after1.alarms - before.alarms}`,
  );

  const singleTickMoved = stateA !== stateB;

  // ── Part B: does the TIMER advance with no client attached? ───────────────
  console.log("\n  starting scheduler (interval 2000ms, step 60s)...");
  console.log("  NO HTTP server is running and NO request is made from here on.\n");

  const advances: Array<{ acquired: boolean; tickCount: number }> = [];
  const handle = startScheduler({
    intervalMs: 2_000,
    stepSeconds: 60,
    runImmediately: true,
    onAdvance: (r) => {
      advances.push({ acquired: r.acquired, tickCount: r.tickCount });
      console.log(
        `    advance#${advances.length} acquired=${r.acquired} ` +
          `ticks=${r.tickCount} events=${r.eventsCreated} alarms=${r.alarmsCreated}`,
      );
      // Surface refusals — a scheduler that declines to run and says why is
      // very different from one that silently advances nothing.
      if (r.error) console.log(`      refusal: ${r.error}`);
    },
  });

  console.log("  waiting 7s of wall-clock time with nothing polling...\n");
  await new Promise((r) => setTimeout(r, 7_000));

  await handle.stop();

  console.log(`\n  advances performed on the timer: ${advances.length}`);

  // Cumulative tickCount proves the clock moved: it grows by the tenant count
  // (3) per successful advance. The first reading establishes the baseline.
  const gained = advances.reduce((n, a) => n + a.tickCount, 0);
  console.log(`  cumulative ticks from the scheduler: ${gained}`);

  const timedAdvanced = advances.length >= 2 && gained > 0;

  // PASS requires both halves: the clock genuinely moves state, and it moved
  // on a timer with no client polling it.
  const advanced = singleTickMoved && timedAdvanced;

  console.log(
    `\n  ${advanced ? "PASS" : "FAIL"} — state advanced with zero HTTP requests.`,
  );
  console.log(`     single tick moved engine state : ${singleTickMoved}`);
  console.log(`     timer advanced without a client: ${timedAdvanced}`);

  if (!advanced) {
    process.exitCode = 1;
  }

  await ops.$disconnect();
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("FAILED:", err);
  await db.$disconnect();
  process.exit(1);
});