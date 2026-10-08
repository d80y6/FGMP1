/**
 * SCENARIOS — letting an operator see a firing alert before it is real.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 * Every threshold in config/alerts.json is INFERRED and unconfirmed. An
 * operator asked to trust one has a reasonable demand: show me what it looks
 * like when it fires. Without that, the only way to see a rule fire is to cause
 * the condition — at 03:00, during an incident.
 *
 * `GET /api/fgmp/ops/alerts/preview?scenario=fuel-theft` substitutes a synthetic
 * reading so the operator can inspect the firing shape, the explanation text and
 * the breach value without touching the platform's real state.
 *
 * ── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 * It never mutates the metrics registry and never delivers anything. Scenarios
 * are a VIEW over the rules, not a way to make an alert real: a fired scenario
 * still reaches no human and still pages nobody. Delivery remains the
 * notification transport layer's job, with its TransportOutcome vocabulary.
 *
 * The `scenario` parameter is always opt-in and never remembered — there is no
 * way for the preview to start reporting a synthetic state to someone who did
 * not ask for it, which would be a monitor lying by default.
 */

import type { AlertRule } from "./rules";

/** A named set of metric readings that stands in for live state. */
export interface Scenario {
  readonly name: string;
  readonly title: string;
  /** What an operator is meant to learn from looking at this. */
  readonly describes: string;
  /** Metric name -> value. Absent metrics are deliberately omitted. */
  readonly values: Readonly<Record<string, number>>;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "quiet",
    title: "Healthy fleet",
    describes:
      "Everything reporting and nothing wrong. Useful as a baseline: if a rule " +
      "fires here, its threshold is too tight and will generate noise.",
    values: {
      fgmp_theft_detections_total: 4,
      fgmp_last_tick_timestamp_seconds_offset: 30,
      fgmp_scheduler_running: 1,
      fgmp_interlock_denials_total: 0,
      "fgmp_notification_outcomes_total{status=\"NO_TRANSPORT\"}": 0,
      "fgmp_notification_outcomes_total{status=\"FAILED\"}": 0,
      "fgmp_db_pool_saturation_ratio": 0.12,
      fgmp_db_query_errors_total: 0,
      fgmp_rate_limit_degraded: 0,
      fgmp_ingest_rejected_total: 0,
    },
  },
  {
    name: "fuel-theft",
    title: "Theft detector silent while tanks keep reporting",
    describes:
      "The detector ran and found nothing for six hours, while ingest is healthy. " +
      "This is the alert the whole ruleset exists for: it is NOT the same as the " +
      "detector being broken, and the two are separated by requiresLiveData.",
    values: {
      fgmp_theft_detections_total: 0,
      fgmp_last_tick_timestamp_seconds_offset: 45,
      fgmp_scheduler_running: 1,
      fgmp_interlock_denials_total: 0,
      "fgmp_notification_outcomes_total{status=\"NO_TRANSPORT\"}": 0,
      "fgmp_notification_outcomes_total{status=\"FAILED\"}": 0,
      fgmp_db_pool_saturation_ratio: 0.2,
      fgmp_db_query_errors_total: 0,
      fgmp_rate_limit_degraded: 0,
      fgmp_ingest_rejected_total: 0,
    },
  },
  {
    name: "detector-dead",
    title: "Theft detector has never reported at all",
    describes:
      "The pipeline is broken rather than quiet. `theft_detector_silent` must read " +
      "UNKNOWN here, not firing and NOT ok — a detector that never ran is not " +
      "evidence of a clean site. Compare with the fuel-theft scenario: both look " +
      "like zero to an operator skimming a dashboard, and only one is good news.",
    // NO theft value at all. The absence is the point.
    values: {
      fgmp_last_tick_timestamp_seconds_offset: 40,
      fgmp_scheduler_running: 1,
      fgmp_interlock_denials_total: 0,
      "fgmp_notification_outcomes_total{status=\"NO_TRANSPORT\"}": 0,
      "fgmp_notification_outcomes_total{status=\"FAILED\"}": 0,
      fgmp_db_pool_saturation_ratio: 0.15,
      fgmp_db_query_errors_total: 0,
      fgmp_rate_limit_degraded: 0,
      fgmp_ingest_rejected_total: 3,
    },
  },
  {
    name: "no-transport",
    title: "Pages are going nowhere",
    describes:
      "Alarms are being raised and there is no transport to send them. Uses the " +
      "TransportOutcome vocabulary from notification-transport.ts rather than an " +
      "alerting-specific word, so this reads the same way the notification layer " +
      "reports it.",
    values: {
      fgmp_theft_detections_total: 6,
      fgmp_last_tick_timestamp_seconds_offset: 25,
      fgmp_scheduler_running: 1,
      fgmp_interlock_denials_total: 2,
      "fgmp_notification_outcomes_total{status=\"NO_TRANSPORT\"}": 14,
      "fgmp_notification_outcomes_total{status=\"FAILED\"}": 0,
      fgmp_db_pool_saturation_ratio: 0.3,
      fgmp_db_query_errors_total: 0,
      fgmp_rate_limit_degraded: 0,
      fgmp_ingest_rejected_total: 0,
    },
  },
  {
    name: "cascade",
    title: "Scheduler stopped, pool saturated, queries failing",
    describes:
      "Several independent conditions at once. Useful for checking that a rule set " +
      "stays readable when many alerts fire together — and for confirming the " +
      "operator is not expected to act on all of them simultaneously.",
    values: {
      fgmp_theft_detections_total: 0,
      fgmp_last_tick_timestamp_seconds_offset: 5400,
      fgmp_scheduler_running: 0,
      fgmp_interlock_denials_total: 19,
      "fgmp_notification_outcomes_total{status=\"NO_TRANSPORT\"}": 0,
      "fgmp_notification_outcomes_total{status=\"FAILED\"}": 8,
      fgmp_db_pool_saturation_ratio: 0.97,
      fgmp_db_query_errors_total: 42,
      fgmp_rate_limit_degraded: 1,
      fgmp_ingest_rejected_total: 77,
    },
  },
];

/** Look up a scenario by name. Returns undefined rather than defaulting. */
export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}

/** Names, for the endpoint's own discovery response. */
export function scenarioNames(): string[] {
  return SCENARIOS.map((s) => s.name);
}

/**
 * Which ruleIds a scenario is expected to put into each state.
 *
 * Declared as DATA rather than derived by running the evaluator, so the tests
 * assert an INDEPENDENT expectation. Deriving the expectation by calling the
 * code under test would let the evaluator define its own correct answer, which
 * is the guard-fires-before-the-test failure in a new costume.
 */
export const SCENARIO_EXPECTATIONS: Readonly<
  Record<string, { firing: string[]; unknown: string[] }>
> = {
  quiet: {
    firing: [],
    unknown: ["db_pool_saturated"],
  },
  "fuel-theft": {
    firing: ["theft_detector_silent", "tanks_reporting_but_no_theft_signal"],
    unknown: [],
  },
  "detector-dead": {
    firing: [],
    unknown: ["theft_detector_silent", "tanks_reporting_but_no_theft_signal"],
  },
  "no-transport": {
    firing: [
      "notifications_have_no_transport",
      "interlock_denials_spiking",
      "theft_detector_silent",
      "tanks_reporting_but_no_theft_signal",
    ],
    unknown: ["db_pool_saturated"],
  },
  cascade: {
    firing: [
      "scheduler_tick_stalled",
      "scheduler_not_running",
      "interlock_denials_spiking",
      "notifications_failing_to_send",
      "db_pool_saturated",
      "db_query_errors",
      "rate_limiter_degraded",
      "ingest_rejecting_readings",
      "theft_detector_silent",
      "tanks_reporting_but_no_theft_signal",
    ],
    unknown: [],
  },
};

/** Rules a scenario does not speak for, so the endpoint can say so plainly. */
export function rulesNotInScenario(
  rules: readonly AlertRule[],
  scenario: Scenario,
): string[] {
  const covered = new Set(Object.keys(scenario.values));
  return rules
    .filter((r) => {
      const key = r.labels && Object.keys(r.labels).length > 0
        ? `${r.metric}{${Object.entries(r.labels).map(([k, v]) => `${k}=${v}`).join(",")}}`
        : r.metric;
      return !covered.has(key);
    })
    .map((r) => r.id);
}
