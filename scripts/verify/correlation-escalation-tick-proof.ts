/**
 * LIVE PROOF — a correlation escalation SURVIVES the engine's alarm lifecycle.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `scripts/verify/correlation-escalation-proof.ts` proved that a match raises alarms.
 * It called `evaluateAndPersist` directly. That leaves the real question
 * unanswered: in production the alarms are raised and aged by `engine.tick()`,
 * which has its own escalation path (`escalateStaleAlarms`). If the two paths
 * fight, an escalation can be silently undone between the moment it is applied
 * and the moment an operator sees it — and a raised-then-downgraded alarm is
 * worse than one never raised, because the correlation view says it was handled.
 *
 * This script therefore drives the PRODUCTION path:
 *
 *   1. seed alarms the way production raises them (via a tick)
 *   2. run correlation — the escalation applies
 *   3. tick AGAIN, several times, so the engine's own escalation runs over the
 *      alarms correlation already raised
 *   4. assert severity is still where correlation put it
 *   5. assert the audit row is still present and intact after the ticks
 *
 * No hardware is required: `engine.tick()` is deterministic and seeded
 * (`assertSimulationAllowed` reads an env flag), so this is reproducible.
 *
 * Exits non-zero on any failure.
 */
import { evaluateAndPersist } from "../../src/lib/fgmp/correlation/service";
import { engine } from "../../src/lib/fgmp/engine";
import { withTenant } from "../../src/lib/fgmp/tenant-context";

let pass = 0;
let fail = 0;
const ok = (l: string, d = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? `\n       ${d}` : ""}`); };
const bad = (l: string, d: string) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${l}\n       ${d}`); };

const TENANT = "t-default";

/** Read alarms through the OWNER so verification is not itself RLS-limited. */
async function ownerAlarms(ids: string[]) {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) throw new Error("FGMP_MIGRATE_DATABASE_URL required for verification reads");
  const { PrismaClient } = await import("@prisma/client");
  const c = new PrismaClient({ datasources: { db: { url } } });
  const rows = await c.alarm.findMany({
    where: { id: { in: ids }, tenantId: TENANT },
    select: { id: true, severity: true, escalationLevel: true, status: true },
  });
  await c.$disconnect();
  return rows;
}

/**
 * Raise alarms the way PRODUCTION does: by ticking the engine.
 *
 * `engine.tick()` is what creates alarms in this system — there is no separate
 * "raise an alarm" entry point in the request path. So the fixture ticks the
 * engine and then collects whatever alarms it produced, rather than inserting
 * rows directly, which would test a path production never takes.
 */
async function alarmsFromEngineTick(want: number): Promise<string[]> {
  const before = new Set(
    (await withTenant(TENANT, async (tx) =>
      tx.alarm.findMany({ select: { id: true } }),
    )).map((a) => a.id),
  );

  // Tick until enough new alarms exist, so the result does not depend on how
  // many alarms a single tick happens to produce for the seeded fleet.
  for (let i = 0; i < 12 && before.size < want + 40; i++) {
    await engine.tick(60);
  }

  const all = await withTenant(TENANT, async (tx) =>
    tx.alarm.findMany({
      where: { status: "OPEN", type: { in: ["FUEL_LOW", "FUEL_CRITICAL", "GEN_OFFLINE"] } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  );
  return all.map((a) => a.id).slice(0, want);
}

async function main() {
  console.log("\n  ── Phase 5: does a correlation escalation survive engine.tick()? ──\n");

  // Ensure the engine holds this tenant, since tick() reads tenant-scoped rows.
  await engine.ensureInit([TENANT]);

  // ── 1. ALARMS RAISED BY THE PRODUCTION PATH ───────────────────────────────
  const alarmIds = await alarmsFromEngineTick(3);
  if (alarmIds.length < 3) {
    bad("engine.tick() raised enough alarms to test with",
      `only ${alarmIds.length} FUEL_LOW/FUEL_CRITICAL/GEN_OFFLINE alarms visible to ${TENANT}. ` +
      `Is the database seeded?`);
    process.exit(1);
  }

  const before = await ownerAlarms(alarmIds);
  const beforeSev = [...new Set(before.map((a) => a.severity))].sort().join(",");
  ok("alarms raised by engine.tick() (the production path)",
    `${alarmIds.length} alarms, severities = [${beforeSev}]`);

  // The rule targets L3 so any change is unambiguously upward.
  const tag = `tickproof-${Date.now().toString(36)}`;
  const rule = await withTenant(TENANT, async (tx) =>
    tx.correlationRule.create({
      data: {
        name: `tick proof ${tag}`,
        tenant: { connect: { id: TENANT } },
        alarmType: "FUEL_LOW",
        threshold: 2,
        windowMinutes: 240,
        scope: "NATIONAL",
        escalateTo: "L3",
      },
    }),
  );

  try {
    // ── 2. CORRELATION ESCALATES ────────────────────────────────────────────
    const run = await evaluateAndPersist({ tenantId: TENANT, now: Date.now() });
    const afterEval = await ownerAlarms(alarmIds);
    const escalated = afterEval.filter((a) => a.severity === "L3").length;
    if (escalated > 0) {
      ok("correlation raised the engine-raised alarms",
        `${escalated}/${afterEval.length} now L3 (raisedAlarms=${run.raisedAlarms})`);
    } else {
      bad("correlation raised the engine-raised alarms",
        `none reached L3; severities = ${afterEval.map((a) => a.severity).join(",")}`);
    }

    const severityAfterEval = new Map(afterEval.map((a) => [a.id, a.severity]));

    // ── 3. TICK AGAIN — DOES THE ENGINE CLOBBER THE ESCALATION? ──────────────
    // Several ticks, because escalateStaleAlarms is time-thresholded and one
    // tick may not cross a boundary. This is the whole point of the script.
    for (let i = 0; i < 5; i++) {
      await engine.tick(300);
    }
    const afterTicks = await ownerAlarms(alarmIds);

    const clobbered = afterTicks.filter(
      (a) => severityAfterEval.get(a.id) === "L3" && a.severity !== "L3",
    );
    if (clobbered.length === 0) {
      ok(
        "3. engine.tick() does NOT clobber the correlation escalation",
        `after 5 ticks: ${afterTicks.map((a) => `${a.severity}/lvl${a.escalationLevel}/${a.status}`).join(", ")}`,
      );
    } else {
      bad(
        "3. engine.tick() does NOT clobber the correlation escalation",
        `${clobbered.length} alarm(s) dropped below L3 after ticking — ` +
          clobbered.map((a) => `${a.id.slice(-6)}: L3 -> ${a.severity}`).join(", "),
      );
    }

    const stillL3 = afterTicks.filter((a) => a.severity === "L3").length;
    if (stillL3 === escalated) {
      ok("   the escalated set is unchanged after ticking",
        `${escalated} before ticks, ${stillL3} after`);
    } else {
      bad("   the escalated set is unchanged after ticking",
        `was ${escalated}, now ${stillL3}`);
    }

    // ── 4. escalationLevel vs severity — CAN THEY DISAGREE? ────────────────
    // The engine's escalateStaleAlarms sets escalationLevel and status but
    // explicitly does not write severity. So an alarm correlation raised to L3
    // can sit at escalationLevel 1 (a L3 severity with a level-1 escalation),
    // which is exactly the "displays one thing, pages as another" risk.
    const disagree = afterTicks.filter(
      (a) => a.severity === "L3" && a.escalationLevel < 3,
    );
    if (disagree.length > 0) {
      console.log(
        `  \x1b[33mOBSERVE\x1b[0m severity and escalationLevel diverge by design:\n` +
          disagree
            .map((a) => `${a.id.slice(-6)}: severity=L3 escalationLevel=${a.escalationLevel} status=${a.status}`)
            .join("\n") +
          `\n       severity describes the CONDITION; escalationLevel describes AGE.\n` +
          `       Both are read independently, so nothing reconciles them.`,
      );
    } else {
      ok("   severity and escalationLevel happen to agree here",
        afterTicks.map((a) => `sev=${a.severity}/lvl${a.escalationLevel}`).join(", "));
    }

    // ── 5. THE AUDIT ROW SURVIVES THE TICKS ────────────────────────────────
    const url = process.env.FGMP_MIGRATE_DATABASE_URL;
      if (!url) throw new Error("FGMP_MIGRATE_DATABASE_URL is not set");
    const { PrismaClient } = await import("@prisma/client");
    const oc = new PrismaClient({ datasources: { db: { url } } });
    const auditRows = await oc.auditLog.findMany({
      where: { tenantId: TENANT, action: "correlation.escalate" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    await oc.$disconnect();

    if (auditRows.length === 0) {
      bad("5. the escalation audit survives engine.tick()", "no audit rows found");
    } else {
      const ours = auditRows.filter((r) => r.details.includes(rule.id));
      if (ours.length === 0) {
        bad("5. the escalation audit survives engine.tick()",
          `audit rows exist but none reference rule ${rule.id}`);
      } else {
        const parsed = JSON.parse(ours[0].details) as {
          ruleId: string;
          raisedCount: number;
          alarms?: Array<{ alarmId: string; from: string; to: string }>;
        };
        const complete =
          parsed.ruleId === rule.id &&
          parsed.raisedCount > 0 &&
          Array.isArray(parsed.alarms) &&
          parsed.alarms.length === parsed.raisedCount &&
          parsed.alarms.every((a) => a.from && a.to);
        if (complete) {
          ok(
            "5. the escalation audit survives engine.tick() intact",
            `${ours.length} row(s) for this rule; raisedCount=${parsed.raisedCount}, ` +
              `alarms=${JSON.stringify(parsed.alarms)}`,
          );
        } else {
          bad("5. the escalation audit survives engine.tick() intact",
            `incomplete detail: ${JSON.stringify(parsed)}`);
        }
      }
    }
  } finally {
    await withTenant(TENANT, async (tx) =>
      tx.correlationRule.deleteMany({ where: { id: rule.id } }),
    ).catch(() => undefined);
  }

  console.log(`\n  \x1b[1mPASS: ${pass}  FAIL: ${fail}\x1b[0m\n`);
  if (fail) {
    console.log("\x1b[31m  RESULT: FAIL — an escalation did not survive the engine lifecycle.\x1b[0m\n");
    process.exit(1);
  }
  console.log("\x1b[32m  RESULT: PASS — escalation survives the engine's alarm lifecycle.\x1b[0m\n");
}

main().catch((e) => {
  console.error(`\n  \x1b[31mCRASH\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
  process.exit(1);
});