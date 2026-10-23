/**
 * LIVE PROOF — a correlation match actually changes the alarms (Phase 5).
 *
 * ── WHY A SCRIPT AND NOT ONLY UNIT TESTS ─────────────────────────────────────
 * The unit tests prove `computeEscalations` decides correctly. They cannot prove
 * the DATABASE was written. This script asserts the two things the Lead asked
 * for directly against PostgreSQL:
 *
 *   1. The alarms actually change. Verified by querying `Alarm` after an
 *      evaluation — NOT by reading the summary the evaluator returned, because a
 *      summary reporting "escalated 3" is exactly what the previous version
 *      would have claimed while writing nothing.
 *   2. Re-running does not double-apply. The match-row UNIQUE constraint dedupes
 *      the ROW; this proves the ACTION is separately idempotent.
 *
 * Exits non-zero on any failure.
 */
import { evaluateAndPersist, listMatches } from "../../src/lib/fgmp/correlation/service";
import { withTenant } from "../../src/lib/fgmp/tenant-context";

let pass = 0;
let fail = 0;
const ok = (l: string, d = "") => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${l}${d ? `\n       ${d}` : ""}`); };
const bad = (l: string, d: string) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${l}\n       ${d}`); };

const TENANT = "t-default";

/** Read alarms through the OWNER so this proof is not itself blocked by RLS. */
async function ownerAlarms(ids: string[]) {
  const url = process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) throw new Error("FGMP_MIGRATE_DATABASE_URL required to read alarm state for verification");
  const { PrismaClient } = await import("@prisma/client");
  const c = new PrismaClient({ datasources: { db: { url } } });
  const rows = await c.alarm.findMany({
    where: { id: { in: ids }, tenantId: TENANT },
    select: { id: true, severity: true, type: true, siteId: true },
  });
  await c.$disconnect();
  return rows;
}

/**
 * Create N alarms at ONE existing site, so a SITE-scoped rule can match them.
 *
 * Reuses a seeded site rather than creating one: Site requires regionId,
 * governorateId, districtId, latitude and longitude, and inventing a throwaway
 * geography tree here would add noise without testing anything about escalation.
 * The site is read through the tenant context so RLS proves it is this tenant's.
 */
async function seedFixture(n: number) {
  const tag = `corrproof-${Date.now().toString(36)}`;
  const site = await withTenant(TENANT, async (tx) =>
    tx.site.findFirst({ orderBy: { code: "asc" }, select: { id: true, code: true } }),
  );
  if (!site) throw new Error(`no site visible to ${TENANT} — is the database seeded?`);

  const alarms = await withTenant(TENANT, async (tx) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        tx.alarm.create({
          data: {
            site: { connect: { id: site.id } },
            tenant: { connect: { id: TENANT } },
            type: "FUEL_LOW",
            severity: "L2",
            status: "OPEN",
            message: `proof alarm ${i} ${tag}`,
            createdAt: new Date(),
          },
        }),
      ),
    ),
  );
  return { tag, site, alarms };
}

/** Remove the fixture alarms. Matched on the unique tag in the message. */
async function cleanup(tag: string) {
  try {
    await withTenant(TENANT, async (tx) => {
      await tx.alarm.deleteMany({ where: { message: { contains: tag } } });
    });
  } catch (err) {
    console.warn(`  cleanup: ${(err as Error).message}`);
  }
}

async function main() {
  console.log("\n  ── Phase 5: correlation escalation, live against PostgreSQL ──\n");

  // Threshold 2, SITE scope, window 60, escalate to L3. The fixture creates 3
  // FUEL_LOW alarms at one site within the window, so the rule must fire.
  const { tag, site, alarms } = await seedFixture(3);
  const alarmIds = alarms.map((a) => a.id);
  console.log(`  fixture ${tag}: ${alarms.length} FUEL_LOW alarms at site ${site.code}, all L2\n`);

  try {
    // ── BEFORE: confirm the starting severity in the DATABASE ──────────────
    const before = await ownerAlarms(alarmIds);
    const beforeSev = [...new Set(before.map((a) => a.severity))].sort();
    if (beforeSev.length === 1 && beforeSev[0] === "L2") {
      ok("BEFORE: all alarms are L2 in the database", `severities = [${beforeSev.join(", ")}]`);
    } else {
      bad("BEFORE: all alarms are L2 in the database", `saw [${beforeSev.join(", ")}]`);
    }

    const rule = await withTenant(TENANT, async (tx) => tx.correlationRule.create({
      data: {
        name: `proof rule ${tag}`,
        tenant: { connect: { id: TENANT } },
        alarmType: "FUEL_LOW",
        threshold: 2,
        windowMinutes: 60,
        scope: "SITE",
        escalateTo: "L3",
      },
    }));

    // ── 1. THE ALARMS ACTUALLY CHANGE ──────────────────────────────────────
    const run1 = await evaluateAndPersist({ tenantId: TENANT, now: Date.now() });
    const after1 = await ownerAlarms(alarmIds);
    const allL3 = after1.length === 3 && after1.every((a) => a.severity === "L3");

    if (allL3) {
      ok(
        "1. alarms actually reach the escalated severity IN THE DATABASE",
        `queried Alarm directly: ${after1.map((a) => `${a.id.slice(-6)}=${a.severity}`).join(", ")}`,
      );
    } else {
      bad(
        "1. alarms actually reach the escalated severity IN THE DATABASE",
        `saw ${after1.map((a) => `${a.id.slice(-6)}=${a.severity}`).join(", ")}`,
      );
    }

    if (run1.raisedAlarms === 3) {
      ok("summary agrees with the database", `raisedAlarms = ${run1.raisedAlarms}`);
    } else {
      bad("summary agrees with the database", `raisedAlarms = ${run1.raisedAlarms}, expected 3`);
    }

    // ── The match row records a truthful outcome ───────────────────────────
    const matches = await listMatches(TENANT, 200);
    const mine = matches.find((m) => m.ruleId === rule.id);
    if (mine) {
      // listMatches projects display fields; read the raw row for outcome/count.
      const url = process.env.FGMP_MIGRATE_DATABASE_URL!;
      const { PrismaClient } = await import("@prisma/client");
      const c = new PrismaClient({ datasources: { db: { url } } });
      const raw = await c.correlationMatch.findUnique({ where: { id: mine.id } });
      await c.$disconnect();
      if (raw?.outcome === "ESCALATED" && raw.escalatedCount === 3) {
        ok(
          "match row records ESCALATED with the real count",
          `outcome=${raw.outcome}, escalatedCount=${raw.escalatedCount}`,
        );
      } else {
        bad(
          "match row records ESCALATED with the real count",
          `outcome=${raw?.outcome}, escalatedCount=${raw?.escalatedCount}`,
        );
      }
      if (raw?.fromSeverity && typeof raw.fromSeverity === "object") {
        const vals = Object.values(raw.fromSeverity as Record<string, string>);
        ok(
          "match row preserves the BEFORE severities",
          `fromSeverity = ${JSON.stringify(raw.fromSeverity)}`,
        );
        if (!vals.every((v) => v === "L2")) {
          bad("fromSeverity holds the pre-escalation values", `values were ${vals.join(",")}`);
        }
      } else {
        bad("match row preserves the BEFORE severities", `fromSeverity was ${JSON.stringify(raw?.fromSeverity)}`);
      }
    } else {
      bad("match row recorded", "no CorrelationMatch row found for the proof rule");
    }

    // ── 2. RE-RUNNING DOES NOT DOUBLE-APPLY ────────────────────────────────
    const run2 = await evaluateAndPersist({ tenantId: TENANT, now: Date.now() });
    const after2 = await ownerAlarms(alarmIds);
    const stillL3 = after2.length === 3 && after2.every((a) => a.severity === "L3");

    if (stillL3 && run2.raisedAlarms === 0) {
      ok(
        "2. re-running raises nothing further",
        `run 2 raisedAlarms = ${run2.raisedAlarms}; DB still ` +
          `${[...new Set(after2.map((a) => a.severity))].join(",")} (unchanged, not L4/garbage)`,
      );
    } else {
      bad(
        "2. re-running raises nothing further",
        `raisedAlarms = ${run2.raisedAlarms}, severities = ${after2.map((a) => a.severity).join(",")}`,
      );
    }

    if (run2.deduplicated >= 1) {
      ok("re-run recognised the duplicate match", `deduplicated = ${run2.deduplicated}`);
    } else {
      bad("re-run recognised the duplicate match", `deduplicated = ${run2.deduplicated}, expected >= 1`);
    }

    // ── 3. NO DOWNGRADE (the security case) ────────────────────────────────
    // Retarget the rule at L1 and re-evaluate: the alarms must stay L3.
    await withTenant(TENANT, async (tx) =>
      tx.correlationRule.update({ where: { id: rule.id }, data: { escalateTo: "L1" } }),
    );
    // Force a NEW match row so the rule is re-evaluated over a new alarm set.
    const siteForExtra = await withTenant(TENANT, async (tx) =>
      tx.site.findFirst({ where: { code: { contains: "SITE" } }, select: { id: true } }),
    );
    if (siteForExtra) {
      await withTenant(TENANT, async (tx) =>
        tx.alarm.create({
          data: {
            site: { connect: { id: siteForExtra.id } },
            tenant: { connect: { id: TENANT } },
            type: "FUEL_LOW",
            severity: "L3",
            status: "OPEN",
            message: `proof L3 ${tag}`,
            createdAt: new Date(),
          },
        }),
      );
    }
    await evaluateAndPersist({ tenantId: TENANT, now: Date.now() });
    const after3 = await ownerAlarms(alarmIds);
    if (after3.every((a) => a.severity === "L3")) {
      ok("3. a rule targeting L1 cannot DOWNGRADE L3 alarms", "all still L3");
    } else {
      bad(
        "3. a rule targeting L1 cannot DOWNGRADE L3 alarms",
        `severities = ${after3.map((a) => a.severity).join(",")}`,
      );
    }

    // ── 4. THE ACTION IS AUDITED ──────────────────────────────────────────
    // Asserted explicitly, because this is where a bug hid: AuditLog.details is
    // `String`, the insert was handed an object, it threw, and because the audit
    // is best-effort the throw was swallowed into a console warning. The
    // escalation still applied, so every behavioural assertion above passed and
    // the audit trail was EMPTY. A green proof must not be able to hide that.
    const url2 = process.env.FGMP_MIGRATE_DATABASE_URL!;
    const { PrismaClient: PC2 } = await import("@prisma/client");
    const oc = new PC2({ datasources: { db: { url: url2 } } });
    const auditRows = await oc.auditLog.findMany({
      where: { tenantId: TENANT, action: "correlation.escalate" },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    await oc.$disconnect();
    if (auditRows.length > 0) {
      const parsed = JSON.parse(auditRows[0].details) as {
        ruleId: string;
        raisedCount: number;
        alarms?: Array<{ alarmId: string; from: string; to: string }>;
      };
      if (parsed.ruleId === rule.id) {
        ok(
          "4. the escalation is audited with before/after severities",
          `${auditRows.length} audit row(s); latest raisedCount=${parsed.raisedCount}, ` +
            `alarms=${JSON.stringify(parsed.alarms ?? [])}`,
        );
      } else {
        bad("4. the escalation is audited with before/after severities",
          `latest audit row is for rule ${parsed.ruleId}, expected ${rule.id}`);
      }
    } else {
      bad(
        "4. the escalation is audited with before/after severities",
        "NO audit rows found — the escalation applied but left no trail",
      );
    }

    await withTenant(TENANT, async (tx) =>
      tx.correlationRule.deleteMany({ where: { id: rule.id } }),
    ).catch(() => undefined);
  } finally {
    await cleanup(tag);
  }

  console.log(`\n  \x1b[1mPASS: ${pass}  FAIL: ${fail}\x1b[0m\n`);
  if (fail) {
    console.log("\x1b[31m  RESULT: FAIL — a match did not act, or the action was not idempotent.\x1b[0m\n");
    process.exit(1);
  }
  console.log("\x1b[32m  RESULT: PASS — matches act, and act exactly once.\x1b[0m\n");
}

main().catch((e) => {
  console.error(`\n  \x1b[31mCRASH\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
  process.exit(1);
});