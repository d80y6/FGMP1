/**
 * ─────────────────────────────────────────────────────────────────────────────
 * CORRELATION ESCALATION — turning a match into an actual action
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * `evaluateAndPersist` recorded every fired match with a hardcoded
 * `outcome: "SUPPRESSED"` and then took no action whatsoever. Nothing consumed a
 * `CorrelationMatch`. `escalateTo` was stored on the rule and never acted on.
 *
 * So an operator could author "10 FUEL_LOW within 30 min → escalate to L3", the
 * rule would fire, a row would appear in the correlation view showing the alarms
 * as handled — and the ten alarms stayed individually L2, individually paging
 * someone. That is worse than not having the feature: the correlation view told
 * an operator the alarms were correlated when they were still firing.
 *
 * ── WHY SEVERITY IS RAISED IN PLACE ─────────────────────────────────────────
 * Two options were considered:
 *
 *   (a) MUTATE `Alarm.severity` upward.
 *   (b) Write a separate escalation record and leave the alarm alone.
 *
 * (a) is chosen. Every consumer of alarm severity in this platform — the NOC
 * dashboard, the paging integration, the operator's severity-filtered work
 * queues — reads `Alarm.severity`. Under (b) a correlated group would need every
 * one of those consumers taught about a second source of truth, and the most
 * safety-relevant one (does this page someone?) would be the easiest to get
 * wrong. Raising the field makes the action visible everywhere at once, which is
 * the entire point of escalating.
 *
 * The cost is that the ORIGINAL severity is overwritten. It is therefore
 * preserved explicitly on the match row (`fromSeverity`) so the change is
 * reconstructable rather than merely asserted — an operator can see that an L2
 * became an L3, and an audit can recover what it was.
 *
 * ── THE DIRECTION OF THE CHANGE ─────────────────────────────────────────────
 * Severity is raised ONLY. An escalation that LOWERED severity would let a rule
 * author silence a critical alarm by configuring a rule that matched it, which
 * is a privilege-escalation path disguised as a feature. `computeEscalations`
 * therefore skips any alarm already at or above the target.
 *
 * ── WHY THIS IS A PURE MODULE ───────────────────────────────────────────────
 * The decision — which alarms move, from what, to what, and what to record — is
 * separated from the database write so it can be tested exhaustively without a
 * database. `applyEscalations` performs the write; `computeEscalations` decides
 * what to write. Every assertion in the test suite exercises the decision half.
 */

import type { AlarmSeverity } from "@prisma/client";

/** The minimum detail a match must carry for an escalation to be possible. */
export interface EscalationCandidate {
  /** The alarm's current severity, as read from the database. */
  alarmId: string;
  currentSeverity: AlarmSeverity;
}

/** One alarm that will change severity, with the before and after recorded. */
export interface EscalationPlanEntry {
  alarmId: string;
  fromSeverity: AlarmSeverity;
  toSeverity: AlarmSeverity;
}

/** What the evaluator decided, and therefore what must be recorded as done. */
export interface EscalationPlan {
  /** Alarms whose severity will be raised. Empty means nothing to do. */
  entries: EscalationPlanEntry[];
  /**
   * Alarms deliberately NOT raised because they are already at or above the
   * target. Recorded rather than silently skipped so a rule matching a critical
   * alarm is visible as a no-op instead of looking unapplied.
   */
  alreadyAtOrAbove: Array<{ alarmId: string; severity: AlarmSeverity }>;
}

/**
 * Decide which alarms a match escalates.
 *
 * PURE. No database, no clock, no side effects — the caller supplies the
 * candidates it read and receives a plan.
 *
 * @param candidates The alarms in the match's `alarmIds` set, with their
 *                   CURRENT severity. The caller MUST read these inside the
 *                   tenant transaction; under FORCE RLS an unscoped read
 *                   returns zero rows, which would make every match silently
 *                   escalate nothing.
 * @param escalateTo The rule's target severity. `null` means the rule escalates
 *                   to nothing and must perform no action.
 */
export function computeEscalations(
  candidates: readonly EscalationCandidate[],
  escalateTo: AlarmSeverity | null,
): EscalationPlan {
  const entries: EscalationPlanEntry[] = [];
  const alreadyAtOrAbove: EscalationPlan["alreadyAtOrAbove"] = [];

  // A rule with no escalation target records a match and takes NO action.
  // This is not a degenerate case: it is how an operator writes a
  // "just group these for me" rule, and it must not silently raise anything.
  if (escalateTo === null) {
    return { entries, alreadyAtOrAbove };
  }

  for (const c of candidates) {
    if (severityRank(c.currentSeverity) >= severityRank(escalateTo)) {
      // Already at or above the target. Raising would either be a no-op or a
      // DOWNGRADE, and a downgrade is the dangerous case — see the module note.
      alreadyAtOrAbove.push({ alarmId: c.alarmId, severity: c.currentSeverity });
      continue;
    }
    entries.push({
      alarmId: c.alarmId,
      fromSeverity: c.currentSeverity,
      toSeverity: escalateTo,
    });
  }

  return { entries, alreadyAtOrAbove };
}

/**
 * Numeric rank for L1 < L2 < L3.
 *
 * The Prisma enum's declaration order happens to be L1, L2, L3, so comparing
 * the strings would work today — but a lexicographic comparison of that enum is
 * a coincidence, not a property. Explicit rank makes the ordering independent of
 * how the enum is declared.
 */
export function severityRank(s: AlarmSeverity): number {
  switch (s) {
    case "L1":
      return 1;
    case "L2":
      return 2;
    case "L3":
      return 3;
    default: {
      // Unknown value: treat as the HIGHEST so an unrecognised severity is never
      // silently downgraded by a rule. Failing toward "already critical" is the
      // safe direction for every consumer of this function.
      const exhaustive: never = s;
      void exhaustive;
      return 3;
    }
  }
}

/**
 * The outcome to persist for a match, derived from what was ACTUALLY done.
 *
 * This is the fix for `outcome: "SUPPRESSED"` being written unconditionally. The
 * recorded outcome is a function of the plan, so it cannot claim an action that
 * did not happen:
 *
 *   no alarms moved        -> ESCALATION_NOOP
 *   some moved              -> ESCALATED
 *
 * A match where every alarm was already at or above the target is a genuine
 * NOOP, and recording it as such is what makes the correlation view honest: an
 * operator sees "this rule matched, nothing needed raising" rather than a
 * suppressed-looking row that changed nothing.
 */
export function outcomeForPlan(
  plan: EscalationPlan,
  escalateTo: AlarmSeverity | null,
): EscalationOutcome {
  if (escalateTo === null) return "ESCALATION_NOOP";
  if (plan.entries.length > 0) return "ESCALATED";
  return "ESCALATION_NOOP";
}

/**
 * Persisted outcome vocabulary.
 *
 * Mirrors the `RuleEvaluationOutcome` database enum. `SUPPRESSED` is retained
 * for rows written before this change so historical data stays readable — it is
 * documented as legacy rather than deleted, because deleting it would either
 * fail to migrate or silently rewrite history into a state it was never in.
 */
export type EscalationOutcome = "ESCALATED" | "ESCALATION_NOOP" | "SUPPRESSED";

/** True when an outcome means alarms were actually changed. */
export function outcomeChangedAlarms(o: EscalationOutcome): boolean {
  return o === "ESCALATED";
}

/**
 * Build the audit detail for an applied escalation.
 *
 * Enough to reconstruct the action from the audit trail alone: which rule
 * produced it, which match, every alarm with its before and after severity, and
 * when. Without `fromSeverity` an audit could not distinguish "raised L2→L3"
 * from "always L3", which is the difference between a correctable alarm and a
 * genuine misconfiguration.
 */
export function escalationAuditDetail(args: {
  ruleId: string;
  matchId: string;
  scopeLabel: string;
  escalateTo: AlarmSeverity | null;
  plan: EscalationPlan;
  evaluatedAt: Date;
}): Record<string, unknown> {
  return {
    ruleId: args.ruleId,
    matchId: args.matchId,
    scope: args.scopeLabel,
    escalateTo: args.escalateTo,
    evaluatedAt: args.evaluatedAt.toISOString(),
    raisedCount: args.plan.entries.length,
    unchangedCount: args.plan.alreadyAtOrAbove.length,
    // Explicit before/after per alarm. This is the record that makes the change
    // reconstructable rather than merely claimed.
    alarms: args.plan.entries.map((e) => ({
      alarmId: e.alarmId,
      from: e.fromSeverity,
      to: e.toSeverity,
    })),
  };
}