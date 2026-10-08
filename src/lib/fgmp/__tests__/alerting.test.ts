/**
 * Tests for alert rule evaluation.
 *
 * The properties that matter are all about HONESTY rather than arithmetic, so
 * the bulk of these assert what the evaluator refuses to claim:
 *   - an absent metric is never `ok`
 *   - absent and zero are distinguishable where the rule says they are
 *   - a rule with no data can never report the platform healthy
 *
 * Run: bun test src/lib/fgmp/__tests__/alerting.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRule,
  evaluateRules,
  compare,
  overallPosture,
  type AlertRule,
  type MetricReading,
} from "../alerting/rules";
import { parseExposition, readingFor, tickAgeSeconds } from "../alerting/readings";
import { parseAlertRules, AlertConfigError } from "../alerting/config";

const ABSENT: MetricReading = { value: null, reported: false };
const ZERO: MetricReading = { value: 0, reported: true };

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "r1",
    title: "Test rule",
    description: "",
    severity: "WARNING",
    metric: "fgmp_test",
    labels: {},
    comparator: "GT",
    threshold: 0,
    unit: "",
    absencePolicy: "ABSENT_IS_UNKNOWN",
    requiresLiveData: false,
    rationale: "because",
    confirmWith: "ask someone",
    source: "INFERRED",
    ...over,
  };
}

// ── The core guarantee ──────────────────────────────────────────────────────
describe("an absent metric is NEVER ok", () => {
  test("ABSENT_IS_UNKNOWN yields unknown, not ok", () => {
    const r = evaluateRule(rule({ absencePolicy: "ABSENT_IS_UNKNOWN" }), ABSENT);
    assert.equal(r.state, "unknown");
    assert.notEqual(r.state, "ok");
  });

  test("unknown regardless of comparator direction", () => {
    for (const comparator of ["GT", "GTE", "LT", "LTE", "EQ", "NEQ"] as const) {
      const r = evaluateRule(
        rule({ comparator, absencePolicy: "ABSENT_IS_UNKNOWN" }),
        ABSENT,
      );
      assert.equal(r.state, "unknown", `comparator ${comparator} must stay unknown`);
    }
  });

  test("unknown regardless of threshold, including negative", () => {
    for (const threshold of [-100, -1, 0, 1, 1e9]) {
      const r = evaluateRule(
        rule({ threshold, absencePolicy: "ABSENT_IS_UNKNOWN" }),
        ABSENT,
      );
      assert.equal(r.state, "unknown");
    }
  });

  test("the message never implies health", () => {
    const r = evaluateRule(rule(), ABSENT);
    assert.ok(!/healthy|ok\b|within/i.test(r.message), `message was: ${r.message}`);
  });

  test("overall posture cannot be 'ok' while a rule is unknown", () => {
    // The decisive property: a monitor that is green because it received
    // nothing is trusted in exactly the situation where it is useless.
    // Both rules are GT 0 and both read BELOW threshold, so neither fires; the
    // only thing preventing a healthy verdict is rule "b" having no data.
    const evals = evaluateRules(
      [rule({ id: "a" }), rule({ id: "b" })],
      new Map([
        ["a", { value: -1, reported: true }],
        ["b", ABSENT],
      ]),
    );
    assert.equal(evals.find((e) => e.ruleId === "a")!.state, "ok");
    assert.equal(evals.find((e) => e.ruleId === "b")!.state, "unknown");
    assert.equal(overallPosture(evals), "unknown");
    assert.ok(!evals.some((e) => e.state === "firing" && e.observed === null));
  });

  test("all rules reporting cleanly is the only path to 'degraded'", () => {
    const evals = evaluateRules(
      [rule({ id: "a" }), rule({ id: "b" })],
      new Map([
        ["a", { value: -1, reported: true }],
        ["b", { value: 0, reported: true }],
      ]),
    );
    assert.equal(overallPosture(evals), "degraded");
    assert.ok(evals.every((e) => e.state === "ok"));
  });

  test("a firing rule outranks an unknown one", () => {
    const evals = evaluateRules(
      [rule({ id: "a" }), rule({ id: "b" })],
      new Map([
        ["a", { value: 99, reported: true }],
        ["b", ABSENT],
      ]),
    );
    assert.equal(overallPosture(evals), "firing", "a known breach is not masked by unknowns");
  });
});

// ── Absent vs zero ──────────────────────────────────────────────────────────
describe("absent and zero are distinguishable", () => {
  test("the same comparator gives different results for absent vs zero", () => {
    const absent = evaluateRule(
      rule({ absencePolicy: "ABSENT_IS_UNKNOWN", comparator: "LT", threshold: 1 }),
      ABSENT,
    );
    const zero = evaluateRule(
      rule({ absencePolicy: "ABSENT_IS_UNKNOWN", comparator: "LT", threshold: 1 }),
      ZERO,
    );
    assert.equal(absent.state, "unknown");
    assert.equal(zero.state, "firing", "a REPORTED zero below threshold fires");
  });

  test("requiresLiveData blocks firing from absence even under ABSENT_IS_ZERO", () => {
    // Without this, a silence rule pages during the outage it exists to catch.
    const r = evaluateRule(
      rule({ absencePolicy: "ABSENT_IS_ZERO", requiresLiveData: true }),
      ABSENT,
    );
    assert.equal(r.state, "unknown", "absence must not fire a requiresLiveData rule");
  });

  test("ABSENT_IS_ZERO may FIRE on absence, but never certifies health", () => {
    // A counter that never reported may legitimately raise an alarm — "no errors
    // have been recorded" and "nothing is recording errors" both leave the
    // count at zero, and that is a real operational concern.
    //
    // It may NOT clear. "No data" is not evidence of "no problems", so the
    // non-breaching side of a substituted zero is `unknown`. An earlier version
    // ran the comparator on the substituted value and reported `ok` here, which
    // is precisely the monitor-green-because-it-received-nothing failure this
    // module exists to prevent.
    const firing = evaluateRule(
      rule({ absencePolicy: "ABSENT_IS_ZERO", comparator: "GT", threshold: -1 }),
      ABSENT,
    );
    assert.equal(firing.state, "firing", "absence may raise an alarm for a counter");

    const clearing = evaluateRule(
      rule({ absencePolicy: "ABSENT_IS_ZERO", comparator: "GT", threshold: 0 }),
      ABSENT,
    );
    assert.equal(clearing.state, "unknown", "absence must never certify health");
    assert.ok(
      clearing.explanation.includes("never reported"),
      `explanation must disclose the substitution, was: ${clearing.explanation}`,
    );
  });

  test("reported zero is still a real observation, not a substitution", () => {
    const r = evaluateRule(rule({ comparator: "GT", threshold: 0 }), ZERO);
    assert.equal(r.state, "ok");
    assert.ok(r.explanation.includes("reported 0"));
  });
});

// ── The theft-silence case the whole module exists for ─────────────────────
describe("detector silence vs no theft", () => {
  const silence = rule({
    id: "theft_detector_silent",
    comparator: "LT",
    threshold: 1,
    absencePolicy: "ABSENT_IS_UNKNOWN",
    requiresLiveData: true,
  });

  test("a detector that never reported is unknown, NOT 'no theft'", () => {
    const r = evaluateRule(silence, ABSENT);
    assert.equal(r.state, "unknown");
    assert.ok(
      /never reported|unknown/i.test(r.explanation),
      "must say the data is unknown, not that theft is absent",
    );
  });

  test("a detector that ran and found nothing is a real, healthy zero", () => {
    const r = evaluateRule(silence, ZERO);
    assert.equal(r.state, "firing", "zero detections IS the condition this rule watches");
    assert.ok(r.explanation.includes("reported 0"));
  });

  test("the two states produce different outcomes", () => {
    assert.notEqual(evaluateRule(silence, ABSENT).state, evaluateRule(silence, ZERO).state);
  });
});

// ── Comparators ─────────────────────────────────────────────────────────────
describe("comparators", () => {
  test("all six behave as their operator-facing name implies", () => {
    assert.equal(compare(5, "GT", 3), true);
    assert.equal(compare(3, "GT", 3), false);
    assert.equal(compare(3, "GTE", 3), true);
    assert.equal(compare(3, "GT", 5), false);
    assert.equal(compare(3, "LT", 5), true);
    assert.equal(compare(3, "LTE", 3), true);
    assert.equal(compare(3, "EQ", 3), true);
    assert.equal(compare(3, "NEQ", 3), false);
  });

  test("evaluation uses the comparator it was given", () => {
    // A comparator asks "does the CONDITION hold", so EQ fires when equal and
    // NEQ fires when different. My first pass asserted the opposite for EQ,
    // which was the test being wrong rather than the evaluator.
    const eq = evaluateRule(rule({ comparator: "EQ", threshold: 1 }), { value: 1, reported: true });
    assert.equal(eq.state, "firing", "EQ(1,1): the condition holds, so it fires");
    const neq = evaluateRule(rule({ comparator: "NEQ", threshold: 1 }), { value: 1, reported: true });
    assert.equal(neq.state, "ok", "NEQ(1,1): the condition does not hold");
    const neq2 = evaluateRule(rule({ comparator: "NEQ", threshold: 1 }), { value: 2, reported: true });
    assert.equal(neq2.state, "firing", "NEQ(2,1): the condition holds");
  });
});

// ── Reading metrics: the absent/zero distinction at the source ──────────────
describe("parseExposition — reading a value vs reading an absence", () => {
  const text = [
    "# HELP fgmp_a_total help",
    "# TYPE fgmp_a_total counter",
    "fgmp_a_total 42",
    "fgmp_b_total 0",
    "fgmp_notification_outcomes_total{status=\"SENT\",channel=\"EMAIL\"} 5",
    "fgmp_notification_outcomes_total{status=\"NO_TRANSPORT\",channel=\"EMAIL\"} 3",
    "",
  ].join("\n");

  const parsed = parseExposition(text);

  test("a reported value is read", () => {
    assert.deepEqual(parsed.get("fgmp_a_total"), { value: 42, reported: true });
  });

  test("a reported ZERO is distinguished from an absent series", () => {
    assert.deepEqual(parsed.get("fgmp_b_total"), { value: 0, reported: true });
    assert.equal(parsed.get("fgmp_never_emitted"), undefined);
  });

  test("HELP and TYPE lines are not parsed as samples", () => {
    assert.equal(parsed.has("# HELP fgmp_a_total help"), false);
    assert.equal(parsed.has("# TYPE fgmp_a_total counter"), false);
  });

  test("labelled series are readable by exact label set", () => {
    const r = rule({ metric: "fgmp_notification_outcomes_total", labels: { status: "NO_TRANSPORT", channel: "EMAIL" } });
    assert.deepEqual(readingFor(parsed, r), { value: 3, reported: true });
  });

  test("label ORDER does not matter", () => {
    const r = rule({ metric: "fgmp_notification_outcomes_total", labels: { channel: "EMAIL", status: "SENT" } });
    assert.deepEqual(readingFor(parsed, r), { value: 5, reported: true });
  });

  test("a label set that does not exist is absent, not zero", () => {
    const r = rule({ metric: "fgmp_notification_outcomes_total", labels: { status: "WHATSAPP" } });
    assert.deepEqual(readingFor(parsed, r), ABSENT);
  });

  test("a metric that never emitted is absent", () => {
    const r = rule({ metric: "fgmp_theft_detections_total" });
    assert.deepEqual(readingFor(parsed, r), ABSENT);
  });

  test("tick age is derived, and absent when the gauge never reported", () => {
    const now = 1_700_000_000_000;
    const withTick = parseExposition("fgmp_last_tick_timestamp_seconds 1699999940\n");
    assert.deepEqual(tickAgeSeconds(withTick, now), { value: 60, reported: true });
    assert.deepEqual(tickAgeSeconds(parseExposition(""), now), ABSENT);
  });
});

// ── Config validation ───────────────────────────────────────────────────────
describe("config validation rejects rather than defaults", () => {
  const valid = JSON.stringify({
    version: 1,
    rules: [
      {
        id: "a", title: "T", description: "", severity: "WARNING",
        metric: "m", labels: {}, comparator: "GT", threshold: 1, unit: "",
        absencePolicy: "ABSENT_IS_UNKNOWN", requiresLiveData: true,
        rationale: "r", confirmWith: "c", source: "INFERRED",
      },
    ],
  });

  test("a well-formed file parses", () => {
    assert.equal(parseAlertRules(valid).rules.length, 1);
  });

  test("an unknown comparator is REJECTED, not defaulted", () => {
    // Defaulting here would produce an always-green monitor, which is the one
    // outcome this module exists to prevent.
    const bad = valid.replace('"GT"', '"GREATER_THAN"');
    assert.throws(() => parseAlertRules(bad), AlertConfigError);
  });

  test("an unknown absencePolicy is rejected", () => {
    assert.throws(() => parseAlertRules(valid.replace("ABSENT_IS_UNKNOWN", "NOPE")), AlertConfigError);
  });

  test("an unknown severity is rejected", () => {
    assert.throws(() => parseAlertRules(valid.replace('"WARNING"', '"URGENT"')), AlertConfigError);
  });

  // Deleting the key from the OBJECT rather than string-replacing it. A
  // .replace() against JSON.stringify output silently matches nothing — there is
  // no space after the colon — so the assertion ran against a perfectly valid
  // document and proved nothing.
  const without = (key: string) => {
    const doc = JSON.parse(valid);
    delete doc.rules[0][key];
    return JSON.stringify(doc);
  };

  test("a missing rationale is rejected", () => {
    assert.throws(() => parseAlertRules(without("rationale")), AlertConfigError);
  });

  test("a missing confirmWith is rejected", () => {
    assert.throws(() => parseAlertRules(without("confirmWith")), AlertConfigError);
  });

  test("requiresLiveData must be explicit", () => {
    assert.throws(() => parseAlertRules(without("requiresLiveData")), AlertConfigError);
  });

  test("a missing absencePolicy is rejected", () => {
    assert.throws(() => parseAlertRules(without("absencePolicy")), AlertConfigError);
  });

  test("an empty rationale is rejected", () => {
    assert.throws(() => parseAlertRules(valid.replace('"r"', '"  "')), AlertConfigError);
  });

  test("the reject-not-default check actually exercises a bad value", () => {
    // Guard against the whole fixture silently failing to parse.
    assert.throws(() => parseAlertRules(valid.replace('"GT"', '"NOPE"')), AlertConfigError);
    assert.doesNotThrow(() => parseAlertRules(valid), "the valid fixture must parse");
  });

  test("duplicate rule ids are rejected", () => {
    const dup = JSON.stringify({
      version: 1,
      rules: [JSON.parse(valid).rules[0], JSON.parse(valid).rules[0]],
    });
    assert.throws(() => parseAlertRules(dup), AlertConfigError);
  });

  test("malformed JSON produces a clear error", () => {
    assert.throws(() => parseAlertRules("{not json"), AlertConfigError);
  });

  test("an empty rules array is rejected", () => {
    assert.throws(() => parseAlertRules('{"version":1,"rules":[]}'), AlertConfigError);
  });
});

describe("the shipped config is valid and self-documenting", () => {
  const shipped = parseAlertRules(
    require("node:fs").readFileSync("config/alerts.json", "utf8"),
  );

  test("it parses", () => {
    assert.ok(shipped.rules.length > 0);
  });

  test("EVERY rule carries rationale and confirmWith", () => {
    for (const r of shipped.rules) {
      assert.ok(r.rationale.length > 20, `${r.id} needs a real rationale`);
      assert.ok(r.confirmWith.length > 20, `${r.id} needs a real confirmWith`);
    }
  });

  test("every threshold is labelled INFERRED, because none has been confirmed", () => {
    for (const r of shipped.rules) {
      assert.equal(r.source, "INFERRED", `${r.id} claims a source nobody supplied`);
      assert.equal(r.confirmedBy, null, `${r.id} claims a confirmation that did not happen`);
    }
  });

  test("the silence rules distinguish absent from zero", () => {
    const silence = shipped.rules.filter((r) => r.id.includes("theft") || r.id.includes("tick"));
    assert.ok(silence.length > 0);
    for (const r of silence) {
      assert.equal(r.absencePolicy, "ABSENT_IS_UNKNOWN", `${r.id} would conflate silence with zero`);
      assert.equal(r.requiresLiveData, true, `${r.id} could fire during the outage it detects`);
    }
  });

  test("notification rules use the TransportOutcome vocabulary", () => {
    const notif = shipped.rules.filter((r) => r.metric === "fgmp_notification_outcomes_total");
    const statuses = new Set(notif.map((r) => r.labels?.status));
    assert.ok(statuses.has("NO_TRANSPORT"), "must alert on nobody receiving pages");
    assert.ok(statuses.has("FAILED"), "must separate a failing provider from an absent one");
    for (const s of statuses) {
      assert.ok(["SENT", "FAILED", "NO_TRANSPORT"].includes(s!), `unexpected status ${s}`);
    }
  });

  test("every rule's metric is one the platform actually exposes, or is declared missing", () => {
    const known = new Set([
      "fgmp_theft_detections_total",
      "fgmp_last_tick_timestamp_seconds",
      "fgmp_scheduler_running",
      "fgmp_interlock_denials_total",
      "fgmp_notification_outcomes_total",
      "fgmp_db_pool_saturation_ratio",
      "fgmp_db_query_errors_total",
      "fgmp_rate_limit_degraded",
      "fgmp_ingest_rejected_total",
    ]);
    for (const r of shipped.rules) {
      assert.ok(known.has(r.metric), `${r.id} reads ${r.metric}, which no rule documents`);
    }
  });
});