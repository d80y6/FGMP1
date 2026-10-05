/**
 * Correlation rule TYPES (Phase 2, vertical 5).
 *
 * ── WHY THESE ARE NOT IN types.ts ───────────────────────────────────────────
 * There were two `AlarmType` definitions that disagreed:
 *
 *   types.ts                  FUEL_* … COMM_LOSS, DISPENSER_FAULT   (no ANY)
 *   use-correlation-rules.ts  FUEL_* … COMM_LOSS, ANY               (no DISPENSER_FAULT)
 *
 * Merging one into the other would have produced a duplicate export that
 * shadowed the engine's domain type, and the mismatch is a RUNTIME bug, not a
 * cosmetic one: the database enum `RuleAlarmType` contains BOTH `ANY` and
 * `DISPENSER_FAULT`, so a rule persisted with `alarmType: "DISPENSER_FAULT"`
 * would fail to typecheck against the browser's narrower union, and a rule
 * persisted with `"ANY"` would fail against the engine's.
 *
 * So the rule vocabulary is derived from the Prisma enum — the single source of
 * truth — and the engine's `AlarmType` in types.ts is left alone. `ANY` is a
 * correlation-only concept ("count alarms of every type"), which is why it
 * belongs to the rule domain rather than to an alarm.
 *
 * The mapping is asserted below rather than assumed: if the Prisma enum and
 * this file ever drift, the build breaks instead of a rule silently
 * mis-classifying an alarm.
 */
import type { RuleAlarmType, RuleScope } from "@prisma/client";

/**
 * Alarm types a correlation RULE may count.
 *
 * Mirrors the `RuleAlarmType` database enum exactly, including `ANY`, which
 * means "every alarm type" rather than a specific alarm.
 */
export type RuleAlarmTypeValue = `${RuleAlarmType}`;

/** Mirrors the `RuleScope` database enum. The national value is `NATIONAL`. */
export type CorrelationRuleScope = `${RuleScope}`;

/** Severity a firing rule escalates to. */
export type CorrelationSeverity = "L1" | "L2" | "L3";

export interface CorrelationRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  alarmType: RuleAlarmTypeValue;
  threshold: number;
  windowMinutes: number;
  scope: CorrelationRuleScope;
  escalateTo: CorrelationSeverity;
  createdAt: string;
  updatedAt: string;
}

export interface RuleDraft {
  name: string;
  description: string;
  enabled: boolean;
  alarmType: RuleAlarmTypeValue;
  threshold: number;
  windowMinutes: number;
  scope: CorrelationRuleScope;
  escalateTo: CorrelationSeverity;
}

/**
 * Compile-time proof the union above matches the database enum.
 *
 * If a value is added to `RuleAlarmType` in the schema and not here, this fails
 * to compile — which is the failure mode we want, rather than the UI silently
 * refusing to offer a valid alarm type.
 */
type _AssertRuleAlarmTypesMatch = Exclude<RuleAlarmType, RuleAlarmTypeValue> extends never
  ? true
  : ["MISMATCH between prisma RuleAlarmType and RuleAlarmTypeValue", Exclude<RuleAlarmType, RuleAlarmTypeValue>];
export type RuleAlarmTypesInSync = _AssertRuleAlarmTypesMatch;