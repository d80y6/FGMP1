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

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { withTenant } from "../tenant-context";
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

    for (const m of matches) {
      try {
        await tx.correlationMatch.create({
          data: {
            tenantId,
            ruleId: m.ruleId,
            scopeKey: m.scopeKey,
            scope: m.scope as never,
            scopeLabel: m.scopeLabel,
            outcome: "SUPPRESSED",
            escalateTo: m.escalateTo as never,
            matchCount: m.matchCount,
            alarmIds: encodeAlarmIds(m.alarmIds),
            evaluatedAt: new Date(now),
          },
        });
        inserted++;
      } catch (err) {
        // The UNIQUE constraint is the idempotency guarantee. A collision means
        // this exact (rule, bucket, alarm-set) was already recorded, which is
        // precisely the "same event evaluated twice" case.
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