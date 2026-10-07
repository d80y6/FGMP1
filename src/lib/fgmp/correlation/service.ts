/**
 * Server-side alarm correlation — PERSISTENCE and orchestration.
 *
 * The pure algorithm lives in ./core and is unit-tested with no database. This
 * module supplies the parts that genuinely need one: tenant-scoped reads of
 * the event stream, geographic resolution, and idempotent persistence of the
 * conclusions.
 *
 * TENANT SCOPE AND RLS (Phase 1)
 * ------------------------------
 * Every read and write here runs inside withTenant(tenantId, …). That is not
 * decoration: RLS is FORCE-enabled on CorrelationRule and CorrelationMatch, so
 * a statement without app.tenant_id in scope matches zero rows, and an INSERT
 * without it is rejected by WITH CHECK. The functions therefore take a tenantId
 * and refuse to guess one.
 *
 * There is deliberately NO owner-connection path here. Seeding needs one
 * because it spans tenants and creates them; correlation does not — it is
 * inherently per-tenant, and running it as the owner would remove the very
 * guarantee the tables were given.
 */

import type { AlarmSeverity, Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { withTenant } from "../tenant-context";
import {
  computeEscalations,
  outcomeForPlan,
  escalationAuditDetail,
  type EscalationPlan,
} from "./escalation";
import {
  evaluateRules,
  encodeAlarmIds,
  splitResults,
  NATIONAL_BUCKET,
  type ServerRule,
  type CorrelationAlarm,
  type SiteScope,
  type Match,
  type NotTriggered,
} from "./core";

/** Postgres error code for a unique_violation. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Record what the escalation did, on the tenant transaction client.
 *
 * Written through `tx`, NOT the module-level `db`, and inside the same
 * transaction as the severity UPDATE. Two reasons:
 *
 *   - the module-level client is a different pooled connection, so an audit
 *     written outside the transaction could outlive a rollback that undid the
 *     escalation — an audit trail asserting an action that was then reverted.
 *   - writing on `tx` means it is tenant-scoped by construction, which RLS
 *     enforces rather than trusting.
 *
 * A failure to audit must NOT roll back the escalation. The severity change is
 * the safety-relevant action, and losing it because an audit insert failed would
 * be strictly worse than an unaudated escalation. So the audit is best-effort
 * and the failure is reported rather than swallowed.
 */
async function recordEscalationAudit(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    ruleId: string;
    matchId: string;
    scopeLabel: string;
    escalateTo: AlarmSeverity | null;
    plan: EscalationPlan;
    evaluatedAt: Date;
    outcome: string;
  },
): Promise<void> {
  try {
    await tx.auditLog.create({
      data: {
        tenantId: args.tenantId,
        action: "correlation.escalate",
        entity: "CorrelationMatch",
        entityId: args.matchId,
        // AuditLog.details is `String`, not Json — a JSON column the schema
        // describes as "JSON string". Passing the object directly failed at
        // runtime with "Expected String, provided Object", and because this
        // helper is deliberately best-effort the failure was swallowed into a
        // console warning. The escalation still applied, so the live proof still
        // passed — which is precisely how an empty audit trail hides behind a
        // green test. Serialised here so the row is actually written.
        details: JSON.stringify(
          escalationAuditDetail({
            ruleId: args.ruleId,
            matchId: args.matchId,
            scopeLabel: args.scopeLabel,
            escalateTo: args.escalateTo,
            plan: args.plan,
            evaluatedAt: args.evaluatedAt,
          }),
        ),
      } as never,
    });
  } catch (err) {
    // Deliberately not rethrown. See the note above: the escalation is the
    // action that matters, and the outcome on the match row already states what
    // happened. Report the gap so it is visible instead of silent.
    console.warn(
      `[correlation] escalation applied but its audit row failed: ${(err as Error).message}`,
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export interface EvaluateOptions {
  tenantId: string;
  /** Evaluation instant in epoch millis. Injected so runs are reproducible. */
  now: number;
  /**
   * How far back to load alarms, in minutes. Overrides the widest rule window
   * so the query is bounded rather than reading the whole alarm history.
   */
  lookbackMinutes?: number;
}

export interface EvaluateOutcome {
  tenantId: string;
  /** Rules evaluated. */
  rulesConsidered: number;
  /** Matches that fired in this run. */
  triggered: Match[];
  /** Rules that did not fire, with the reason. */
  notTriggered: NotTriggered[];
  /**
   * Matches whose persisted row already existed. This is the number that makes
   * idempotency observable: a second run over an unchanged stream reports every
   * match as deduplicated and inserts nothing.
   */
  deduplicated: number;
  /** Matches newly persisted by this run. */
  inserted: number;
  /**
   * Alarms whose severity this run actually RAISED.
   *
   * Distinct from `inserted`: a run can persist a match that legitimately
   * changed nothing (no `escalateTo`, or every alarm already at the target), and
   * reporting only the match count would hide that. This is the number that
   * answers "did correlation do anything this tick?".
   */
  raisedAlarms: number;
}

/**
 * Load the geographic context needed to bucket alarms.
 *
 * Runs inside the caller's tenant transaction so it only ever sees that
 * tenant's sites — the Site/Region/Governorate rows are themselves RLS-protected.
 */
async function loadSiteScopes(tx: Prisma.TransactionClient): Promise<SiteScope[]> {
  const sites = await tx.site.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      regionId: true,
      governorateId: true,
      region: { select: { id: true, name: true } },
      governorate: { select: { id: true, name: true } },
    },
  });

  return sites.map((s) => ({
    siteId: s.id,
    siteLabel: s.name || s.code,
    regionId: s.regionId,
    regionLabel: s.region.name,
    governorateId: s.governorateId,
    governorateLabel: s.governorate.name,
  }));
}

/**
 * Load the alarm event stream inside the tenant's window.
 *
 * Only alarms the correlation rules can actually act on are loaded: created
 * within the widest enabled rule window. Loading the full history would make
 * every evaluation O(history) and grow without bound.
 */
async function loadAlarms(
  tx: Prisma.TransactionClient,
  now: number,
  lookbackMinutes: number,
): Promise<CorrelationAlarm[]> {
  const since = new Date(now - lookbackMinutes * 60_000);
  const rows = await tx.alarm.findMany({
    where: { createdAt: { gte: since, lte: new Date(now) } },
    select: {
      id: true,
      type: true,
      createdAt: true,
      siteId: true,
      site: { select: { regionId: true, governorateId: true } },
    },
  });

  return rows.map((a) => ({
    id: a.id,
    type: String(a.type),
    createdAt: a.createdAt.getTime(),
    siteId: a.siteId,
    regionId: a.site.regionId,
    governorateId: a.site.governorateId,
  }));
}

/**
 * Evaluate every enabled rule for one tenant and persist the conclusions.
 *
 * Idempotent by construction: each match is inserted against the UNIQUE
 * constraint on (ruleId, scopeKey, alarmIds). Re-evaluating an unchanged event
 * stream produces identical keys, which collide, which are counted as
 * `deduplicated` and not written. A genuinely new event changes the alarm set
 * and therefore the key, so it is inserted — the check does not suppress real
 * escalations, only repeats.
 */
export async function evaluateAndPersist(
  opts: EvaluateOptions,
): Promise<EvaluateOutcome> {
  const { tenantId, now } = opts;

  return withTenant(tenantId, async (tx) => {
    const rules = await tx.correlationRule.findMany({ where: { tenantId, enabled: true } });

    if (rules.length === 0) {
      return {
        tenantId,
        rulesConsidered: 0,
        triggered: [],
        notTriggered: [],
        deduplicated: 0,
        inserted: 0,
        // No rules, so nothing could have been evaluated and nothing could have
        // been escalated. Zero is the truthful value, not a default — and it is
        // stated explicitly rather than left off, because omitting it made this
        // return literal structurally different from the main path and the
        // mismatch only surfaced as a type error at the call site.
        raisedAlarms: 0,
      };
    }

    // Bound the read by the widest window any enabled rule declares.
    const widest = Math.max(...rules.map((r) => r.windowMinutes), 1);
    const lookback = Math.max(opts.lookbackMinutes ?? 0, widest);

    const [sites, alarms] = await Promise.all([
      loadSiteScopes(tx),
      loadAlarms(tx, now, lookback),
    ]);

    const asServerRules: ServerRule[] = rules.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      enabled: r.enabled,
      alarmType: r.alarmType,
      threshold: r.threshold,
      windowMinutes: r.windowMinutes,
      scope: r.scope,
      escalateTo: r.escalateTo,
    }));

    const results = evaluateRules(asServerRules, alarms, sites, now);
    const { matches, notTriggered } = splitResults(results);

    let inserted = 0;
    let deduplicated = 0;

    // Counters for the ACTION, not just the match row. `raised` is what an
    // operator needs to know: how many alarms this evaluation actually changed.
    let raisedTotal = 0;

    for (const m of matches) {
      // ── Phase 5: a match must ACT or record that it did nothing ──────────
      //
      // Previously this wrote `outcome: "SUPPRESSED"` and moved on, so a rule
      // could claim ten alarms were correlated while all ten stayed L2 and kept
      // paging. The action now happens BEFORE the match row is written, inside
      // the same transaction, so a failure to act cannot leave a row claiming
      // the action happened.
      //
      // Ordering matters for idempotency. If the match row were written first and
      // the escalation second, a crash between them would leave a deduplicated
      // match with un-escalated alarms — and the next run would skip the action
      // as "already recorded", permanently losing the escalation. Acting first
      // means a crash rolls the whole transaction back and the next run redoes
      // it. Raising an already-raised alarm is idempotent in itself, so
      // re-applying is safe.
      const candidates = await tx.alarm.findMany({
        where: { id: { in: m.alarmIds } },
        select: { id: true, severity: true },
      });

      const plan = computeEscalations(
        candidates.map((a) => ({ alarmId: a.id, currentSeverity: a.severity })),
        m.escalateTo as never,
      );

      if (plan.entries.length > 0) {
        // Raise severity in place. Every consumer of Alarm.severity — the NOC
        // dashboard, the paging integration, the operator's severity-filtered
        // queues — reads this column, so raising it makes the escalation visible
        // everywhere at once instead of requiring every consumer to learn about
        // a parallel escalation record.
        await tx.alarm.updateMany({
          where: { id: { in: plan.entries.map((e) => e.alarmId) } },
          data: { severity: m.escalateTo as never },
        });
        raisedTotal += plan.entries.length;
      }

      // The recorded outcome is DERIVED from what was actually done, so it can
      // never claim an action that did not occur.
      const outcome = outcomeForPlan(plan, m.escalateTo as never);

      try {
        const created = await tx.correlationMatch.create({
          data: {
            tenantId,
            ruleId: m.ruleId,
            scopeKey: m.scopeKey,
            scope: m.scope as never,
            scopeLabel: m.scopeLabel,
            outcome: outcome as never,
            escalateTo: m.escalateTo as never,
            matchCount: m.matchCount,
            alarmIds: encodeAlarmIds(m.alarmIds),
            evaluatedAt: new Date(now),
            escalatedCount: plan.entries.length,
            // Preserve the BEFORE severities. The UPDATE above overwrote
            // Alarm.severity, so without this the original value is gone and the
            // change could only be asserted, never reconstructed.
            fromSeverity:
              plan.entries.length > 0
                ? (Object.fromEntries(
                    plan.entries.map((e) => [e.alarmId, e.fromSeverity]),
                  ) as never)
                : (undefined as never),
          },
        });

        await recordEscalationAudit(tx, {
          tenantId,
          ruleId: m.ruleId,
          matchId: created.id,
          scopeLabel: m.scopeLabel,
          escalateTo: m.escalateTo as never,
          plan,
          evaluatedAt: new Date(now),
          outcome,
        });

        inserted++;
      } catch (err) {
        // The UNIQUE constraint is the match-row idempotency guarantee. A
        // collision means this exact (rule, bucket, alarm-set) was already
        // recorded. The escalation above has ALREADY been applied in this
        // transaction, which is safe precisely because raising an
        // already-raised alarm changes nothing.
        if (isUniqueViolation(err)) {
          deduplicated++;
          continue;
        }
        throw err;
      }
    }

    return {
      tenantId,
      rulesConsidered: rules.length,
      triggered: matches,
      notTriggered,
      deduplicated,
      inserted,
      raisedAlarms: raisedTotal,
    };
  });
}

/**
 * Persisted evaluation history, newest first. Read-only, for display.
 *
 * Suppression records are returned so an operator can see WHY an alarm was
 * correlated — the UI shows the result, it never recomputes it.
 */
export async function listMatches(
  tenantId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    ruleId: string;
    ruleName: string;
    scope: string;
    scopeLabel: string;
    escalateTo: string;
    matchCount: number;
    alarmIds: string[];
    evaluatedAt: Date;
  }>
> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.correlationMatch.findMany({
      orderBy: { evaluatedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      include: { rule: { select: { name: true } } },
    });

    return rows.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      ruleName: r.rule.name,
      scope: r.scope,
      scopeLabel: r.scopeLabel,
      escalateTo: r.escalateTo,
      matchCount: r.matchCount,
      alarmIds: r.alarmIds ? r.alarmIds.split(",").filter(Boolean) : [],
      evaluatedAt: r.evaluatedAt,
    }));
  });
}

/** Load rules for display/edit. */
export async function listRules(tenantId: string) {
  return withTenant(tenantId, (tx) =>
    tx.correlationRule.findMany({ orderBy: { createdAt: "asc" } }),
  );
}

/**
 * Create a rule.
 *
 * @param client Injection point for tests; defaults to the RLS-enforced app
 *   client. Deliberately NOT an owner client — rules are ordinary tenant data.
 */
export async function createRule(
  tenantId: string,
  data: {
    name: string;
    description?: string;
    alarmType: string;
    threshold: number;
    windowMinutes: number;
    scope: string;
    escalateTo: string;
  },
  client?: PrismaClient,
): Promise<unknown> {
  if (client) {
    return client.correlationRule.create({
      data: { ...data, tenantId } as never,
    });
  }
  return withTenant(tenantId, (tx) =>
    tx.correlationRule.create({ data: { ...data, tenantId } as never }),
  );
}

/** Update a rule's mutable fields. */
export async function updateRule(
  tenantId: string,
  ruleId: string,
  patch: Partial<{
    name: string;
    description: string;
    enabled: boolean;
    alarmType: string;
    threshold: number;
    windowMinutes: number;
    scope: string;
    escalateTo: string;
  }>,
): Promise<unknown> {
  return withTenant(tenantId, (tx) =>
    tx.correlationRule.update({
      where: { id: ruleId },
      // tenantId in the where clause is defence in depth: even if a caller
      // passes a ruleId belonging to another tenant, the row is unreachable
      // under RLS and Prisma raises P2025 rather than mutating it.
      data: patch as never,
    }),
  );
}

/** Delete a rule. Cascades to its matches. */
export async function deleteRule(tenantId: string, ruleId: string): Promise<unknown> {
  return withTenant(tenantId, (tx) =>
    tx.correlationRule.delete({ where: { id: ruleId } }),
  );
}

/** Re-exported so callers do not need to reach into ./core for the bucket key. */
export { NATIONAL_BUCKET };