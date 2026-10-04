/**
 * Alarm Correlation Rule Engine — pure functions, no React, no side effects.
 *
 * Importable from both client and server code (but only ever called from
 * client components against the live alarm feed). The engine EVALUATES rules
 * against current alarms and reports which rules WOULD trigger and which
 * alarms they would escalate. It does NOT mutate alarms on the backend — the
 * feature is advisory / what-if only.
 *
 * The "now" timestamp is injected via an optional parameter (`now`) so callers
 * can evaluate at a known point in time (e.g. for tests or replays). When
 * omitted, the engine uses Date.now() — but it does so lazily inside the
 * evaluate function so the module remains importable from server code without
 * touching window/document.
 */

import type { SiteState } from "@/lib/fgmp/types";
import type { CorrelationRule, RuleScope } from "@/lib/fgmp/use-correlation-rules";

/**
 * Minimal alarm shape required by the engine. The FGMP alarms API returns
 * richer objects (severity, status, escalationLevel, message, value,
 * threshold, acknowledgedAt, resolvedAt, …) — all of those are passed through
 * untouched by `triggeringAlarms`. We only depend on the four fields below.
 */
export interface AlarmState {
  id: string;
  /** Alarm type discriminator (e.g. "FUEL_CRITICAL"). */
  type: string;
  /** ISO timestamp — when the alarm was first raised. */
  createdAt: string;
  /** FK to SiteState.id. Used to resolve the alarm's geographic scope. */
  siteId?: string | null;
  /** Optional nested site snapshot (used only if siteId lookup fails). */
  site?: { name?: string; code?: string; region?: string; governorate?: string; district?: string } | null;
  [key: string]: unknown;
}

export interface RuleEvaluation {
  triggered: boolean;
  /** The alarms that satisfied the rule (all alarms in the winning scope group). */
  triggeringAlarms: AlarmState[];
  /** Human-readable scope label, e.g. "Region: Central Highlands". */
  scopeLabel: string;
}

export type EvaluatedRule = CorrelationRule & RuleEvaluation;

/** Scope label prefixes (used by the engine + UI). */
const SCOPE_LABEL_PREFIX: Record<RuleScope, string> = {
  SITE: "Site",
  REGION: "Region",
  GOVERNORATE: "Governorate",
  NATIONAL: "National",
};

/**
 * Compute the scope bucket key for an alarm. Returns:
 *   - For SITE: the siteId
 *   - For REGION: the region name (or region id as fallback)
 *   - For GOVERNORATE: the governorate name (or id as fallback)
 *   - For NATIONAL: the literal "ALL" (every alarm shares one bucket)
 *
 * Returns null when the alarm's site can't be resolved AND the scope needs
 * site data (i.e. anything other than NATIONAL).
 */
function scopeKeyFor(
  alarm: AlarmState,
  siteMap: Map<string, SiteState>,
  scope: RuleScope,
): { key: string; label: string } | null {
  if (scope === "NATIONAL") {
    return { key: "__ALL__", label: "National" };
  }

  // Resolve site: prefer the sites lookup; fall back to the alarm's nested
  // `site` object (which the alarms API includes).
  const site = alarm.siteId ? siteMap.get(alarm.siteId) : undefined;
  let region = site?.region ?? alarm.site?.region ?? "";
  let governorate = site?.governorate ?? alarm.site?.governorate ?? "";
  let siteName = site?.name ?? alarm.site?.name ?? "";
  const siteCode = site?.code ?? alarm.site?.code ?? "";

  switch (scope) {
    case "SITE":
      if (!alarm.siteId) return null;
      return {
        key: alarm.siteId,
        label: siteName || siteCode ? `${siteName || siteCode}` : `Site ${alarm.siteId.slice(-6)}`,
      };
    case "REGION":
      if (!region) return null;
      return { key: region, label: `${SCOPE_LABEL_PREFIX.REGION}: ${region}` };
    case "GOVERNORATE":
      if (!governorate) return null;
      return { key: governorate, label: `${SCOPE_LABEL_PREFIX.GOVERNORATE}: ${governorate}` };
    default:
      return null;
  }
}

/**
 * Evaluate a single rule against the current alarm feed.
 *
 * Algorithm:
 *   1. If the rule is disabled, return { triggered: false, [], "" }.
 *   2. Compute the rolling time window: [now - windowMinutes, now].
 *   3. Filter alarms by (a) type (or ANY) and (b) createdAt within the window.
 *   4. Group the filtered alarms by scope bucket (site/region/governorate/national).
 *   5. If any bucket's count >= threshold, the rule is triggered. Return the
 *      alarms in the highest-count bucket + that bucket's human-readable label.
 *
 * Edge cases:
 *   - Missing site data for SITE/REGION/GOVERNORATE scopes: the alarm is
 *     skipped (can't be grouped). If ALL filtered alarms are skipped, the
 *     rule is not triggered.
 *   - Empty alarms list: not triggered.
 *   - Threshold <= 0: treated as 1 (defensive — should never happen since
 *     the store sanitises on read).
 *   - windowMinutes <= 0: treated as 1 (same defence).
 */
export function evaluateRule(
  rule: CorrelationRule,
  alarms: AlarmState[],
  sites: SiteState[],
  now: number = Date.now(),
): RuleEvaluation {
  if (!rule.enabled) {
    return { triggered: false, triggeringAlarms: [], scopeLabel: "" };
  }

  const threshold = Math.max(1, rule.threshold);
  const windowMs = Math.max(1, rule.windowMinutes) * 60_000;
  const windowStart = now - windowMs;

  const siteMap = new Map<string, SiteState>();
  for (const s of sites) siteMap.set(s.id, s);

  // Step 3: filter by type + time window.
  const matching: AlarmState[] = [];
  for (const a of alarms) {
    if (rule.alarmType !== "ANY" && a.type !== rule.alarmType) continue;
    const created = parseAlarmTime(a.createdAt);
    if (created === null) continue;
    if (created < windowStart || created > now) continue;
    matching.push(a);
  }

  if (matching.length < threshold) {
    return { triggered: false, triggeringAlarms: [], scopeLabel: "" };
  }

  // Step 4: group by scope bucket.
  const buckets = new Map<string, { label: string; alarms: AlarmState[] }>();
  for (const a of matching) {
    const bucket = scopeKeyFor(a, siteMap, rule.scope);
    if (!bucket) continue; // missing site data — skip
    const existing = buckets.get(bucket.key);
    if (existing) {
      existing.alarms.push(a);
    } else {
      buckets.set(bucket.key, { label: bucket.label, alarms: [a] });
    }
  }

  // Step 5: find the bucket with the most alarms; if any >= threshold, triggered.
  let best: { label: string; alarms: AlarmState[] } | null = null;
  for (const bucket of buckets.values()) {
    if (bucket.alarms.length >= threshold) {
      if (!best || bucket.alarms.length > best.alarms.length) {
        best = bucket;
      }
    }
  }

  if (!best) {
    return { triggered: false, triggeringAlarms: [], scopeLabel: "" };
  }

  return {
    triggered: true,
    triggeringAlarms: best.alarms,
    scopeLabel: best.label,
  };
}

/**
 * Evaluate every rule against the current alarm feed. Returns the rules in
 * the same order as the input, each augmented with its evaluation result.
 */
export function evaluateAllRules(
  rules: CorrelationRule[],
  alarms: AlarmState[],
  sites: SiteState[],
  now: number = Date.now(),
): EvaluatedRule[] {
  return rules.map((rule) => {
    const result = evaluateRule(rule, alarms, sites, now);
    return { ...rule, ...result };
  });
}

/**
 * Parse an alarm's `createdAt` into an epoch millisecond timestamp. Accepts
 * ISO strings (preferred), epoch numbers (as strings or numbers), and returns
 * null for anything we can't safely interpret. Used internally — exported for
 * tests.
 */
export function parseAlarmTime(createdAt: unknown): number | null {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
  if (typeof createdAt !== "string" || !createdAt) return null;
  // Try ISO first.
  const ms = Date.parse(createdAt);
  if (!Number.isNaN(ms)) return ms;
  // Then try a bare epoch number string (e.g. "1700000000000").
  const asNum = Number(createdAt);
  if (!Number.isNaN(asNum) && asNum > 0) return asNum;
  return null;
}

/**
 * Format a rule's trigger condition as a short human-readable string:
 *   "3+ FUEL_CRITICAL in REGION within 15min → L3"
 *
 * Used by the Active Rules tab and the editor preview.
 */
export function formatRuleCondition(rule: CorrelationRule): string {
  const type = rule.alarmType === "ANY" ? "ANY" : rule.alarmType;
  return `${rule.threshold}+ ${type} in ${rule.scope} within ${rule.windowMinutes}min → ${rule.escalateTo}`;
}
