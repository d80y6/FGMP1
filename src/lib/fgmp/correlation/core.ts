/**
 * Server-side alarm correlation — PURE evaluation core.
 *
 * This module contains no React, no `window`, no `localStorage`, no database
 * and no clock of its own. Every input is passed in and the output depends only
 * on those inputs, which is what makes the three required properties provable:
 *
 *   DETERMINISTIC — for the same (rules, alarms, sites, now) it always returns
 *                   byte-identical output. `now` is a required parameter, never
 *                   `Date.now()`, so a replay of yesterday's event stream
 *                   produces yesterday's answer.
 *
 *   IDEMPOTENT    — a "match" is identified by (ruleId, scopeKey, alarmIds).
 *                   Evaluating the same event stream twice yields the same
 *                   matches with the same keys, so persisting them is a no-op
 *                   the second time. That is enforced by a database UNIQUE
 *                   constraint in SQL, not merely by convention here.
 *
 *   BROWSER-FREE  — it runs in a plain Bun test, a cron job, or a request
 *                   handler with nothing running but Node.
 *
 * WHY THIS IS SERVER-SIDE (Phase 2)
 * ---------------------------------
 * The previous implementation kept rules in localStorage and evaluated them in
 * the browser on an 8s poll. Two consequences, both unacceptable for an alarm
 * system:
 *   1. A rule only fired for whoever had the tab open. Closing the dashboard
 *      silently stopped correlation, so the platform's belief about an
 *      escalating event depended on whether someone was looking at it.
 *   2. Rules lived per-browser, so two operators could hold contradictory
 *      rule sets and the platform had no authoritative answer at all.
 *
 * The evaluation is unchanged in spirit — it is the same counting-and-grouping
 * algorithm the client used — but it now runs against persisted events and
 * persists its conclusions.
 */

import type { RuleAlarmType, RuleScope, AlarmSeverity } from "@prisma/client";

/** Severity literal, kept structural so this module needs no generated client. */
export type Severity = "L1" | "L2" | "L3";

/** A correlation rule as stored in the database. */
export interface ServerRule {
  id: string;
  tenantId: string;
  enabled: boolean;
  /** "ANY" matches every alarm type. */
  alarmType: RuleAlarmType | string;
  threshold: number;
  windowMinutes: number;
  scope: RuleScope | string;
  escalateTo: AlarmSeverity | Severity | string;
}

/**
 * The alarm fields correlation depends on.
 *
 * `siteId` is resolved to geographic ids by the caller (which owns the
 * database session and therefore the tenant context). Everything the algorithm
 * needs is here, so this function never touches the network or the database.
 */
export interface CorrelationAlarm {
  id: string;
  type: string;
  /** Epoch millis. Normalised to numbers by the caller so parsing is not repeated. */
  createdAt: number;
  siteId: string | null;
  regionId: string | null;
  governorateId: string | null;
}

/** Geographic context for a site, used to label buckets. */
export interface SiteScope {
  siteId: string;
  siteLabel: string;
  regionId: string;
  regionLabel: string;
  governorateId: string;
  governorateLabel: string;
}

/** One rule firing against one geographic bucket. */
export interface Match {
  ruleId: string;
  tenantId: string;
  /** Stable bucket key: site id, region id, governorate id, or "__ALL__". */
  scopeKey: string;
  scope: string;
  /** Human-readable, e.g. "Region: Central Highlands". */
  scopeLabel: string;
  escalateTo: string;
  matchCount: number;
  /** Member alarm ids, SORTED — sorting is what makes the key stable. */
  alarmIds: string[];
  outcome: "SUPPRESSED";
}

/** Why a rule did not produce a match. Useful for the UI and for tests. */
export interface NotTriggered {
  ruleId: string;
  outcome: "NOT_TRIGGERED";
  reason:
    | "disabled"
    | "no-matching-alarms"
    | "below-threshold"
    | "unresolvable-scope";
  matchCount: number;
}

export type RuleResult = Match | NotTriggered;

export type EvaluationResult = RuleResult[];

/** Bucket key used for NATIONAL scope — every alarm shares one bucket. */
export const NATIONAL_BUCKET = "__ALL__";

/**
 * Resolve the geographic bucket for an alarm under a given scope.
 *
 * Returns null when the alarm cannot be placed in a bucket — an alarm with no
 * site cannot be correlated at SITE/REGION/GOVERNORATE scope. Such alarms are
 * SKIPPED rather than pooled into a shared bucket, because pooling them would
 * fabricate a geographic cluster that does not exist.
 */
function bucketFor(
  alarm: CorrelationAlarm,
  sites: Map<string, SiteScope>,
  scope: string,
): { key: string; label: string } | null {
  if (scope === "NATIONAL") {
    return { key: NATIONAL_BUCKET, label: "National" };
  }

  if (!alarm.siteId) return null;
  const site = sites.get(alarm.siteId);
  if (!site) return null;

  switch (scope) {
    case "SITE":
      return { key: site.siteId, label: `Site: ${site.siteLabel}` };
    case "REGION":
      return { key: site.regionId, label: `Region: ${site.regionLabel}` };
    case "GOVERNORATE":
      return {
        key: site.governorateId,
        label: `Governorate: ${site.governorateLabel}`,
      };
    default:
      return null;
  }
}

/**
 * Evaluate every rule against the event stream.
 *
 * Pure. `now` is the evaluation instant in epoch millis and is REQUIRED so the
 * caller is explicit about the clock — no hidden `Date.now()`.
 */
export function evaluateRules(
  rules: readonly ServerRule[],
  alarms: readonly CorrelationAlarm[],
  sites: readonly SiteScope[],
  now: number,
): EvaluationResult {
  const siteMap = new Map<string, SiteScope>();
  for (const s of sites) siteMap.set(s.siteId, s);

  const results: EvaluationResult = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      results.push({
        ruleId: rule.id,
        outcome: "NOT_TRIGGERED",
        reason: "disabled",
        matchCount: 0,
      });
      continue;
    }

    // Defensive clamps. A zero or negative threshold would fire on a single
    // alarm or on none at all; both are configuration errors that must not
    // become an unbounded escalation loop.
    const threshold = Math.max(1, Math.trunc(rule.threshold) || 1);
    const windowMs = Math.max(1, Math.trunc(rule.windowMinutes) || 1) * 60_000;
    const windowStart = now - windowMs;

    const inWindow: CorrelationAlarm[] = [];
    for (const a of alarms) {
      if (rule.alarmType !== "ANY" && a.type !== rule.alarmType) continue;
      if (a.createdAt < windowStart || a.createdAt > now) continue;
      inWindow.push(a);
    }

    if (inWindow.length === 0) {
      results.push({
        ruleId: rule.id,
        outcome: "NOT_TRIGGERED",
        reason: "no-matching-alarms",
        matchCount: 0,
      });
      continue;
    }

    const buckets = new Map<string, { label: string; alarms: CorrelationAlarm[] }>();
    let unresolvable = 0;
    for (const a of inWindow) {
      const b = bucketFor(a, siteMap, String(rule.scope));
      if (!b) {
        unresolvable++;
        continue;
      }
      const existing = buckets.get(b.key);
      if (existing) existing.alarms.push(a);
      else buckets.set(b.key, { label: b.label, alarms: [a] });
    }

    // Collect every bucket that meets the threshold, not just the largest.
    //
    // The client picked a single "best" bucket per rule. That loses information:
    // two different regions can each independently breach a REGION-scoped rule,
    // and both are real escalations. Recording only one would let a genuine
    // cluster go unescalated because another cluster happened to be bigger.
    //
    // Ordering is by scopeKey so the output is byte-stable across runs.
    const firing = [...buckets.entries()]
      .filter(([, v]) => v.alarms.length >= threshold)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    if (firing.length === 0) {
      results.push({
        ruleId: rule.id,
        outcome: "NOT_TRIGGERED",
        reason: unresolvable > 0 ? "unresolvable-scope" : "below-threshold",
        matchCount: inWindow.length - unresolvable,
      });
      continue;
    }

    for (const [scopeKey, bucket] of firing) {
      // Sorting the member ids is what makes the idempotency key stable: the
      // same set of alarms in a different iteration order must produce the
      // same key, or re-evaluation would insert a duplicate.
      const alarmIds = bucket.alarms.map((a) => a.id).sort();
      results.push({
        ruleId: rule.id,
        tenantId: rule.tenantId,
        scopeKey,
        scope: String(rule.scope),
        scopeLabel: bucket.label,
        escalateTo: String(rule.escalateTo),
        matchCount: alarmIds.length,
        alarmIds,
        outcome: "SUPPRESSED",
      });
    }
  }

  return results;
}

/**
 * Serialise a match into the `alarmIds` column value.
 *
 * Sorted ids joined by ",". This value is the third component of the UNIQUE
 * key, so the encoding must be INJECTIVE: two different alarm sets must never
 * produce the same string.
 *
 * Joining on a separator is injective only while no id contains that
 * separator. cuid-style ids never do, but relying on that silently is a trap —
 * an id containing "," would make two distinct alarm sets encode identically
 * and the UNIQUE constraint would then discard a real escalation as a
 * duplicate. So the separator is validated rather than assumed.
 */
export function encodeAlarmIds(alarmIds: readonly string[]): string {
  for (const id of alarmIds) {
    if (id.includes(",")) {
      throw new Error(
        `encodeAlarmIds: alarm id ${JSON.stringify(id)} contains a comma, ` +
          `which is the key separator and would make the encoding ambiguous.`,
      );
    }
  }
  return [...alarmIds].sort().join(",");
}

/**
 * The stable identity of a match — the value the database UNIQUE constraint
 * enforces. Exposed so the persistence layer and the tests assert the SAME key
 * rather than two independently-derived ones.
 */
export function matchKey(m: {
  ruleId: string;
  scopeKey: string;
  alarmIds: readonly string[];
}): string {
  return `${m.ruleId}|${m.scopeKey}|${encodeAlarmIds(m.alarmIds)}`;
}

/** Partition results into matches and non-matches. */
export function splitResults(
  results: readonly RuleResult[],
): { matches: Match[]; notTriggered: NotTriggered[] } {
  const matches: Match[] = [];
  const notTriggered: NotTriggered[] = [];
  for (const r of results) {
    if (r.outcome === "SUPPRESSED") matches.push(r);
    else notTriggered.push(r as NotTriggered);
  }
  return { matches, notTriggered };
}