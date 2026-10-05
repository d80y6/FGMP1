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
import type { CorrelationRule, CorrelationRuleScope as RuleScope } from "@/lib/fgmp/correlation-types";

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
