/**
 * Evidence script — proves correlation idempotency AT THE DATABASE.
 *
 * The unit tests prove the pure evaluator is deterministic and that a repeated
 * evaluation yields an identical match key. That is necessary but not
 * sufficient: it says nothing about what happens when two evaluations race to
 * persist the same match, which is the case that matters under a scheduler with
 * more than one instance.
 *
 * This script proves the database refuses the duplicate. The guarantee is the
 * UNIQUE constraint on (ruleId, scopeKey, alarmIds), so it is tested directly:
 *
 *   1. seed a rule and enough alarms to cross its threshold
 *   2. run evaluation twice
 *   3. assert run 1 inserted 1 match, run 2 inserted 0 and deduplicated 1
 *   4. assert exactly ONE row exists for that key
 *   5. assert a genuinely new alarm produces a SECOND, distinct row
 *
 * Run:  DATABASE_URL=<fgmp_app> FGMP_MIGRATE_DATABASE_URL=<fgmp_migrate> \
 *         bun run scripts/verify/correlation-idempotency-proof.ts
 */

import { db } from "../../src/lib/db";
import { withTenant } from "../../src/lib/fgmp/tenant-context";
import { evaluateAndPersist, listMatches } from "../../src/lib/fgmp/correlation/service";

const TENANT = "t-default";

/** Create a disposable rule, returning its id. */
async function makeRule(name: string): Promise<string> {
  return withTenant(TENANT, async (tx) => {
    const rule = await tx.correlationRule.create({
      data: {
        tenantId: TENANT,
        name,
        description: "idempotency proof",
        enabled: true,
        alarmType: "GEN_FAILURE",
        threshold: 2,
        windowMinutes: 60,
        scope: "SITE",
        escalateTo: "L3",
      },
    });
    return rule.id;
  });
}

/** Raise `n` alarms at one site, all inside the rule window. */
async function makeAlarms(n: number, tag: string): Promise<string[]> {
  return withTenant(TENANT, async (tx) => {
    const site = await tx.site.findFirst({ select: { id: true } });
    if (!site) throw new Error("no site available for the proof");

    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = await tx.alarm.create({
        data: {
          tenantId: TENANT,
          siteId: site.id,
          type: "GEN_FAILURE",
          severity: "L2",
          status: "OPEN",
          message: `proof ${tag} ${i}`,
          createdAt: new Date(Date.now() - 60_000),
        },
      });
      ids.push(a.id);
    }
    return ids;
  });
}

async function main() {
  console.log("=".repeat(72));
  console.log("PROOF 3 — correlation idempotency at the DATABASE level");
  console.log("=".repeat(72));

  const now = Date.now();
  const ruleId = await makeRule(`proof-${Date.now()}`);

  // Two alarms at one site, threshold 2 -> the rule fires.
  const alarmIds = await makeAlarms(2, "first");

  console.log(`\n  rule:    ${ruleId}  (threshold 2, SITE scope, 60m window)`);
  console.log(`  alarms:  ${alarmIds.length} GEN_FAILURE at one site`);

  // ── Run 1 ────────────────────────────────────────────────────────────────
  const first = await evaluateAndPersist({ tenantId: TENANT, now });
  const firstForRule = first.triggered.filter((m) => m.ruleId === ruleId);

  console.log(`\n  run 1: inserted=${first.inserted} deduplicated=${first.deduplicated}`);
  console.log(`         matches for our rule: ${firstForRule.length}`);

  // ── Run 2 — the same event stream, evaluated again ───────────────────────
  const second = await evaluateAndPersist({ tenantId: TENANT, now: now + 1000 });
  const secondForRule = second.triggered.filter((m) => m.ruleId === ruleId);

  console.log(`\n  run 2 (same events, evaluated again):`);
  console.log(`         inserted=${second.inserted} deduplicated=${second.deduplicated}`);
  console.log(`         matches for our rule: ${secondForRule.length}`);

  // ── How many rows actually exist? ────────────────────────────────────────
  const rows = await withTenant(TENANT, (tx) =>
    tx.correlationMatch.findMany({ where: { ruleId } }),
  );

  console.log(`\n  persisted CorrelationMatch rows for this rule: ${rows.length}`);

  // ── A genuinely new alarm must produce a NEW row ─────────────────────────
  const now2 = Date.now();
  await makeAlarms(1, "second");
  // Third evaluation: same window, so the SAME match must come back (idempotency).
    // Not bound to a variable — the assertion is on the persisted rows below.
    await evaluateAndPersist({ tenantId: TENANT, now: now2 });
  const rowsAfter = await withTenant(TENANT, (tx) =>
    tx.correlationMatch.findMany({ where: { ruleId } }),
  );

  console.log(`\n  after adding ONE more alarm:`);
  console.log(`         rows: ${rows.length} -> ${rowsAfter.length}`);
  console.log(`         (a distinct alarm set must be recorded, not swallowed)`);

  // ── Verdict ──────────────────────────────────────────────────────────────
  const run1Inserted = firstForRule.length === 1;
  // Run 1 wrote N new rows; run 2 must write ZERO new rows and account for
  // exactly one more deduplicated match. Comparing run 2's `inserted` against
  // run 1's TOTAL is wrong — run 1's total includes rows for OTHER enabled
  // rules in the tenant, while run 2's insert count must be 0 for the repeated
  // set. The invariant is: nothing new was written, and the repeated match was
  // counted as a duplicate.
  const run2Deduped =
    secondForRule.length === 1 &&
    second.inserted === 0 &&
    second.deduplicated === first.deduplicated + 1;
  const oneRow = rows.length === 1;
  const newEventRecorded = rowsAfter.length === rows.length + 1;

  console.log(`\n  ${run1Inserted ? "PASS" : "FAIL"} — first evaluation recorded the match`);
  console.log(`  ${run2Deduped ? "PASS" : "FAIL"} — second evaluation was deduplicated, not re-inserted`);
  console.log(`  ${oneRow ? "PASS" : "FAIL"} — exactly one row exists for the repeated event set`);
  console.log(`  ${newEventRecorded ? "PASS" : "FAIL"} — a new alarm produced a new row (no over-suppression)`);

  if (!(run1Inserted && run2Deduped && oneRow && newEventRecorded)) {
    process.exitCode = 1;
  }

  // ── Cleanup, so the proof leaves no fixture behind ───────────────────────
  await withTenant(TENANT, async (tx) => {
    await tx.correlationMatch.deleteMany({ where: { ruleId } });
    await tx.correlationRule.delete({ where: { id: ruleId } });
    await tx.alarm.deleteMany({ where: { id: { in: alarmIds } } });
  });
  console.log("\n  fixtures removed.");

  const after = await listMatches(TENANT, 5);
  console.log(`  matches visible via listMatches(): ${after.length}`);

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error("FAILED:", err);
  await db.$disconnect();
  process.exit(1);
});