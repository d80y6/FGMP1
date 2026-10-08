/**
 * ALERT RULES — types and evaluation, with provenance.
 *
 * ── WHY RULES ARE DATA AND NOT CODE ────────────────────────────────────────
 * Alert thresholds are guesses until an operator has seen them fire against
 * real traffic. Encoding them as a TypeScript array means the only way to change
 * one is a deploy, which means nobody can safely experiment, and the only way to
 * review one is to read the diff of a file that also contains the evaluator.
 *
 * These live in `config/alerts.json` instead: readable, editable, diffable, and
 * reviewable without reading the code that consumes them.
 *
 * ── EVERY THRESHOLD HERE IS INFERRED ───────────────────────────────────────
 * No specification supplied a single number in this file. Every threshold
 * therefore carries `rationale` (what it is for) and `confirmWith` (what an
 * operator must check before trusting it), exactly as `interlock-thresholds.ts`
 * does for safety thresholds. `source: "INFERRED"` is not a formality — it is
 * the honest label, and `confirmWith` is the hand-off to whoever can confirm it.
 *
 * ── THE RULE THAT MATTERS MOST ─────────────────────────────────────────────
 * `theft_detector_silent` is the reason this exists. A fuel-theft detector that
 * stops producing candidates is INDISTINGUISHABLE from a site with no theft:
 * both look like "zero detections". One is good news and the other is a broken
 * pipeline on the exact alarm this platform exists to raise. See
 * `AbsencePolicy` below for how the two are told apart.
 */

/** Mirrors `ThresholdSource` from interlock-thresholds.ts. */
export type RuleSource = "SPECIFIED" | "SITE_POLICY" | "DERIVED" | "INFERRED";

/** Severity of the operational condition, NOT of the alert's own urgency. */
export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * How a rule treats a metric that has never reported.
 *
 * This is the central design decision of the module, so it is a first-class
 * field rather than an implicit behaviour.
 *
 *   "ABSENT_IS_ZERO"  — treat no data as 0. Only defensible when the metric is a
 *                       COUNTER whose zero is meaningful, i.e. "nothing has
 *                       happened" and "nothing reported" genuinely agree.
 *   "ABSENT_IS_UNKNOWN" — the rule cannot conclude. Evaluates to `unknown`,
 *                       never to `ok`.
 *
 * The third possibility, which is the failure mode this whole module exists to
 * prevent, is evaluating an absent metric as `ok`. A monitor that is green
 * because it received nothing is worse than no monitor, because it is trusted.
 * There is deliberately NO option that maps absence to ok.
 */
export type AbsencePolicy = "ABSENT_IS_ZERO" | "ABSENT_IS_UNKNOWN";

/** Comparison the rule applies. */
export type Comparator = "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ";

/** One alert rule, fully declared. */
export interface AlertRule {
  /** Stable id. Referenced by the preview response and by any future routing. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: AlertSeverity;
  /** The metric this rule reads, e.g. "fgmp_last_tick_timestamp_seconds". */
  readonly metric: string;
  /** Labels identifying the series, e.g. { status: "NO_TRANSPORT" }. */
  readonly labels?: Readonly<Record<string, string>>;
  readonly comparator: Comparator;
  readonly threshold: number;
  readonly unit: string;
  readonly absencePolicy: AbsencePolicy;
  /**
   * When true, the rule cannot fire unless its supporting metric HAS reported.
   * For a silence rule this is the whole point: firing on "no data" would make
   * the alert fire during exactly the outage it exists to catch, and then be
   * ignored.
   */
  readonly requiresLiveData: boolean;
  readonly rationale: string;
  readonly confirmWith: string;
  readonly source: RuleSource;
  readonly sourceRef?: string;
  /** Set once an operator has reviewed an inferred value and kept it. */
  readonly confirmedBy?: string | null;
  readonly confirmedAt?: string | null;
}

/** The file as it appears on disk. */
export interface AlertRulesFile {
  readonly version: number;
  readonly rules: readonly AlertRule[];
}

/** Result of evaluating one rule. */
export type RuleState = "ok" | "firing" | "unknown";

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: AlertSeverity;
  readonly state: RuleState;
  /** The value read. null when the series never reported. */
  readonly observed: number | null;
  readonly threshold: number;
  readonly comparator: Comparator;
  readonly comparatorText: string;
  readonly unit: string;
  /** Operator-facing sentence. Never claims health it did not observe. */
  readonly message: string;
  /** Why the state is what it is. Distinguishes "measured 0" from "no data". */
  readonly explanation: string;
  readonly rationale: string;
  readonly confirmWith: string;
  readonly source: RuleSource;
  readonly confirmedBy?: string | null;
}

/** A metric reading, plus whether it was ever actually reported. */
export interface MetricReading {
  /** null means the series was NEVER reported — distinct from a reported 0. */
  value: number | null;
  reported: boolean;
}

/**
 * Compare an observed value against a rule's threshold.
 *
 * Unknown is not false. A rule whose data is absent must never read `ok`.
 */
export function evaluateRule(rule: AlertRule, reading: MetricReading): RuleEvaluation {
  const comparatorText = `${rule.comparator} ${rule.threshold}${rule.unit ? " " + rule.unit : ""}`;

  // ── Absence ──────────────────────────────────────────────────────────────
  // A metric that never reported is handled FIRST, before any comparison, so no
  // comparator can accidentally treat it as a number.
  if (!reading.reported || reading.value === null) {
    if (rule.absencePolicy === "ABSENT_IS_ZERO" && !rule.requiresLiveData) {
      // Continue below and evaluate as 0 — the rule has declared that zero is a
      // fair reading of "nothing happened".
      //
      // requiresLiveData is checked HERE as well as after the comparison: under
      // ABSENT_IS_ZERO a missing series is substituted with 0 before any
      // comparator runs, so a guard placed only after the comparison would never
      // see `reported: false` and would silently evaluate a silent pipeline.
    } else {
      return {
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        state: "unknown",
        observed: null,
        threshold: rule.threshold,
        comparator: rule.comparator,
        comparatorText,
        unit: rule.unit,
        message: `${rule.title}: no data reported for ${rule.metric}.`,
        explanation:
          `The series ${rule.metric} has never reported, so its value is unknown rather ` +
          `than zero. This rule cannot conclude either way, and it is deliberately NOT ` +
          `reported as healthy — a monitor that is green because it received nothing is ` +
          `trusted in exactly the situation where it is useless.`,
        rationale: rule.rationale,
        confirmWith: rule.confirmWith,
        source: rule.source,
        confirmedBy: rule.confirmedBy ?? null,
      };
    }
  }

  const observed = reading.reported && reading.value !== null ? reading.value : 0;

  const firing = compare(observed, rule.comparator, rule.threshold);

  // ── requiresLiveData ──────────────────────────────────────────────────────
  // For a SILENCE rule this is the difference between a useful alarm and noise.
  // "Theft detections have been zero for 6 hours" and "the theft pipeline has
  // not reported for 6 hours" are different problems with different fixes, and a
  // rule that conflates them will page for the wrong one.
  if (firing && rule.requiresLiveData && !reading.reported) {
    return {
      ruleId: rule.id,
      title: rule.title,
      severity: rule.severity,
      state: "unknown",
      observed: null,
      threshold: rule.threshold,
      comparator: rule.comparator,
      comparatorText,
      unit: rule.unit,
      message: `${rule.title}: no data reported for ${rule.metric}.`,
      explanation:
        `The rule's condition is met numerically (absent treated as ${observed}), but ` +
        `requiresLiveData is set so absence cannot raise it. Firing here would alert on ` +
        `the very outage this rule exists to detect.`,
      rationale: rule.rationale,
      confirmWith: rule.confirmWith,
      source: rule.source,
      confirmedBy: rule.confirmedBy ?? null,
    };
  }

  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    state: firing ? "firing" : "ok",
    observed,
    threshold: rule.threshold,
    comparator: rule.comparator,
    comparatorText,
    unit: rule.unit,
    message: firing
      ? `${rule.title}: observed ${observed}${rule.unit ? " " + rule.unit : ""} (${comparatorText}).`
      : `${rule.title}: observed ${observed}${rule.unit ? " " + rule.unit : ""} (${comparatorText}) — not breached.`,
    explanation: reading.reported
      ? `The series reported ${observed}${rule.unit ? " " + rule.unit : ""}; ${comparatorText} is ${firing ? "breached" : "not breached"}.`
      : `The series never reported; treated as ${observed} because absencePolicy is ${rule.absencePolicy}.`,
    rationale: rule.rationale,
    confirmWith: rule.confirmWith,
    source: rule.source,
    confirmedBy: rule.confirmedBy ?? null,
  };
}

/** Comparator semantics. Equality is exact, not approximate. */
export function compare(observed: number, comparator: Comparator, threshold: number): boolean {
  switch (comparator) {
    case "GT": return observed > threshold;
    case "GTE": return observed >= threshold;
    case "LT": return observed < threshold;
    case "LTE": return observed <= threshold;
    case "EQ": return observed === threshold;
    case "NEQ": return observed !== threshold;
  }
}

/**
 * Evaluate a whole rule set.
 *
 * Order is preserved from the file so an operator reading the response sees the
 * rules in the order they are written in the config.
 */
export function evaluateRules(
  rules: readonly AlertRule[],
  readings: ReadonlyMap<string, MetricReading>,
): RuleEvaluation[] {
  return rules.map((rule) => evaluateRule(rule, readings.get(rule.id) ?? { value: null, reported: false }));
}

/**
 * Overall posture.
 *
 * Note there is deliberately NO "healthy" verdict available when any rule is
 * unknown. A partial picture is reported as partial.
 */
export type Posture = "firing" | "degraded" | "unknown";

export function overallPosture(evaluations: readonly RuleEvaluation[]): Posture {
  if (evaluations.some((e) => e.state === "firing")) return "firing";
  if (evaluations.some((e) => e.state === "unknown")) return "unknown";
  return "degraded";
}