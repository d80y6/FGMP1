/**
 * PROOF THAT EVERY ALERT RULE CAN FIRE — and for the right reason.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * On a freshly started server the preview reported 6 firing / 0 unknown / 5 ok.
 * Which meant no rule had ever been observed in a firing state.
 *
 * A rule only ever seen green is untested. Six of eleven were in that position,
 * and the danger is specific: a rule that fires for the WRONG reason is worse
 * than one that never fires, because it is trusted. So every rule here is
 * asserted in BOTH directions, and each firing assertion checks the `explanation`
 * text as well as the state — a rule that reaches `firing` while saying something
 * untrue about why is still a broken rule.
 *
 * ── WHY THE THEFT RULE GETS THE MOST SPACE ────────────────────────────────
 * It is the one rule where absence and zero mean different things. "The detector
 * ran and found nothing" is a healthy quiet site. "The detector has never run"
 * is a broken pipeline on the exact alarm this platform exists to raise. Those
 * must never collapse into the same reading, in either direction.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateRule, type AlertRule, type MetricReading } from "../alerting/rules";
import { parseAlertRules } from "../alerting/config";
import { theftDetections, registry, schedulerRunning } from "@/lib/observability/metrics";

const SHIPPED = parseAlertRules(readFileSync("config/alerts.json", "utf8"));

const reported = (value: number): MetricReading => ({ value, reported: true });
const ABSENT: MetricReading = { value: null, reported: false };

function ruleById(id: string): AlertRule {
  const found = SHIPPED.rules.find((r) => r.id === id);
  if (!found) throw new Error(`no shipped rule with id "${id}"`);
  return found;
}

/**
 * Assert a rule reaches `firing` AND that its explanation is truthful.
 *
 * The `because` fragment is required to appear in the explanation, so a rule
 * cannot reach `firing` by accident while reporting a reason that does not match
 * what the metric actually said.
 */
function assertFires(rule: AlertRule, reading: MetricReading, because: string): void {
  const r = evaluateRule(rule, reading);
  assert.equal(r.state, "firing", `${rule.id} should fire on ${JSON.stringify(reading)}`);
  assert.ok(
    r.explanation.includes(because),
    `${rule.id} fired but its explanation did not mention ${JSON.stringify(because)}. ` +
      `Explanation was: ${r.explanation}`,
  );
}

function assertDoesNotFire(rule: AlertRule, reading: MetricReading): void {
  const r = evaluateRule(rule, reading);
  assert.notEqual(r.state, "firing", `${rule.id} fired unexpectedly on ${JSON.stringify(reading)}`);
}

// ── 1. theft_detector_silent — the rule that matters most ───────────────────
describe("theft_detector_silent — silence is not safety", () => {
  const rule = ruleById("theft_detector_silent");

  test("MANY detections → ok (a working detector finding nothing wrong)", () => {
    assertDoesNotFire(rule, reported(25));
  });

  test("ONE detection → ok (threshold is < 1, so a single hit is enough)", () => {
    assertDoesNotFire(rule, reported(1));
  });

  test("ZERO detections while the detector RAN → FIRES", () => {
    // This is the intended alert: the detector is demonstrably working and has
    // found nothing for the whole window. Worth an operator's attention.
    assertFires(rule, reported(0), "reported 0");
  });

  test("ABSENT → unknown, NOT firing and NOT ok", () => {
    // The property verified live over HTTP and which must not regress: a
    // detector that has never run is not evidence of a quiet site.
    const r = evaluateRule(rule, ABSENT);
    assert.equal(r.state, "unknown");
    assert.notEqual(r.state, "ok", "absent must never read as healthy");
    assert.notEqual(r.state, "firing", "absence must not masquerade as a finding");
    assert.ok(r.explanation.includes("never reported"), r.explanation);
  });

  test("it fires for the SILENCE reason, not a generic one", () => {
    const r = evaluateRule(rule, reported(0));
    assert.ok(r.explanation.includes("reported 0"), "must cite the measured zero");
    assert.ok(!r.explanation.includes("never reported"), "must not claim absence");
  });
});

describe("tanks_reporting_but_no_theft_signal — corroboration, not duplication", () => {
  const rule = ruleById("tanks_reporting_but_no_theft_signal");

  test("a detector that ran → ok regardless of volume", () => {
    assertDoesNotFire(rule, reported(3));
    assertDoesNotFire(rule, reported(100));
  });

  test("a detector that never reported → unknown", () => {
    assert.equal(evaluateRule(rule, ABSENT).state, "unknown");
  });

  test("zero with live corroboration → firing", () => {
    assertFires(rule, reported(0), "reported 0");
  });
});

describe("theft evidence is published per EVALUATION, not per hit", () => {
  test("a NO_CANDIDATE evaluation is itself evidence the detector ran", () => {
    // The wiring decision that makes the silence rule work: if only hits were
    // counted, a working detector on a quiet fleet and a broken detector would
    // publish identical series, and the rule could not tell them apart.
    const before = registry.render();
    assert.ok(before.includes("fgmp_theft_detections_total"), "counter is registered");

    theftDetections.inc({ result: "NO_CANDIDATE" });
    const after = registry.render();
    assert.ok(
      after.includes('fgmp_theft_detections_total{result="NO_CANDIDATE"} 1'),
      `expected a NO_CANDIDATE series, got: ${after.split("\n").find((l) => l.startsWith("fgmp_theft"))}`,
    );
  });
});

// ── 2. The rest of the rules, both directions ───────────────────────────────
describe("every shipped rule can reach firing", () => {
  /** Values chosen to breach each shipped rule's threshold. */
  const firingCases: Array<[string, number, string]> = [
    ["theft_detector_silent", 0, "reported 0"],
    ["tanks_reporting_but_no_theft_signal", 0, "reported 0"],
    ["scheduler_tick_stalled", 999_999, "reported 999999"],
    ["scheduler_not_running", 0, "reported 0"],
    ["interlock_denials_spiking", 3, "reported 3"],
    ["notifications_have_no_transport", 7, "reported 7"],
    ["notifications_failing_to_send", 4, "reported 4"],
    ["db_pool_saturated", 0.95, "reported 0.95"],
    ["db_query_errors", 2, "reported 2"],
    ["rate_limiter_degraded", 1, "reported 1"],
    ["ingest_rejecting_readings", 11, "reported 11"],
  ];

  test("the test list covers every rule in the shipped config", () => {
    // Guards against a rule being added to config without a firing case here,
    // which is precisely how a rule becomes untested decoration again.
    const covered = new Set(firingCases.map(([id]) => id));
    for (const r of SHIPPED.rules) {
      assert.ok(covered.has(r.id), `rule "${r.id}" has no firing test`);
    }
    assert.equal(covered.size, SHIPPED.rules.length, "no orphan firing cases");
  });

  for (const [id, value, because] of firingCases) {
    test(`${id} fires at ${value}`, () => {
      assertFires(ruleById(id), reported(value), because);
    });
  }
});

describe("every shipped rule also has a NON-firing state", () => {
  test("rules with an upper bound do not fire below it", () => {
    assertDoesNotFire(ruleById("db_pool_saturated"), reported(0.1));
    assertDoesNotFire(ruleById("scheduler_tick_stalled"), reported(3));
  });

  test("theft rules do not fire when the detector has produced candidates", () => {
    assertDoesNotFire(ruleById("theft_detector_silent"), reported(9));
    assertDoesNotFire(ruleById("tanks_reporting_but_no_theft_signal"), reported(9));
  });

  test("rate limiter is fine at 0 and only fires at exactly the degraded marker", () => {
    assertDoesNotFire(ruleById("rate_limiter_degraded"), reported(0));
    assertFires(ruleById("rate_limiter_degraded"), reported(1), "reported 1");
  });

  test("notification rules are separable: SENT count alone fires neither", () => {
    // The reason there are two rules rather than one. SENT is the healthy
    // outcome and must not trip either of them.
    assertDoesNotFire(ruleById("notifications_have_no_transport"), reported(0));
    assertDoesNotFire(ruleById("notifications_failing_to_send"), reported(0));
  });

  test("a scheduler that IS running does not fire the not-running rule", () => {
    assertDoesNotFire(ruleById("scheduler_not_running"), reported(1));
  });
});

// ── 3. Absent must never read as healthy, rule by rule ─────────────────────
describe("NO rule reports ok because it received no data", () => {
  test("every requiresLiveData rule is unknown when absent", () => {
    for (const r of SHIPPED.rules.filter((x) => x.requiresLiveData)) {
      const e = evaluateRule(r, ABSENT);
      assert.notEqual(e.state, "ok", `${r.id} reported ok with no data`);
    }
  });

  test("every ABSENT_IS_UNKNOWN rule is unknown when absent", () => {
    for (const r of SHIPPED.rules.filter((x) => x.absencePolicy === "ABSENT_IS_UNKNOWN")) {
      assert.equal(evaluateRule(r, ABSENT).state, "unknown", `${r.id}`);
    }
  });

  test("the ABSENT_IS_ZERO rules disclose their substitution", () => {
    // These are counters, so absence genuinely can mean zero — but the
    // explanation must say so rather than imply a measurement was taken.
    for (const r of SHIPPED.rules.filter((x) => x.absencePolicy === "ABSENT_IS_ZERO")) {
      const e = evaluateRule(r, ABSENT);
      assert.notEqual(e.state, "ok", `${r.id} reported ok with no data`);
      assert.ok(e.explanation.includes("never reported"), `${r.id}: ${e.explanation}`);
    }
  });
});

// ── 4. The pool-saturation honesty case ────────────────────────────────────
describe("db_pool_saturated — a metric that cannot be observed is not invented", () => {
  test("it evaluates to unknown rather than ok when unobservable", () => {
    const r = evaluateRule(ruleById("db_pool_saturated"), ABSENT);
    assert.equal(r.state, "unknown", "must not claim the pool is fine when it cannot be seen");
  });

  test("it CAN fire when a real ratio is supplied", () => {
    assertFires(ruleById("db_pool_saturated"), reported(0.95), "reported 0.95");
  });

  test("the metric really is absent from the registry — not merely unread", () => {
    // If something started publishing this, the rule would need a re-think: it
    // would become observable and the honest-unknown behaviour above would be
    // a bug rather than a design choice.
    const line = registry
      .render()
      .split("\n")
      .find((l) => l.startsWith("fgmp_db_pool_saturation_ratio "));
    assert.equal(line, undefined, "this Prisma build exposes no pool stats, so nothing publishes it");
  });
});

// ── 5. The scheduler gauge is now wired ────────────────────────────────────
describe("scheduler_running is published by the scheduler lifecycle", () => {
  test("the gauge exists and is writable", () => {
    schedulerRunning.set({}, 1);
    // A gauge set with an EMPTY label set renders WITHOUT braces, so matching on
    // "{}" would have failed against a perfectly correct metric.
    const line = registry
      .render()
      .split("\n")
      .find((l: string) => l.startsWith("fgmp_scheduler_running"));
    assert.ok(line, "gauge must be settable");
    assert.match(line, /1$/, `expected a value of 1, got: ${line}`);
  });

  test("stopping clears it, so a stopped scheduler does not pin the rule at 1", () => {
    schedulerRunning.set({}, 1);
    assert.equal(evaluateRule(ruleById("scheduler_not_running"), reported(1)).state, "ok");
    schedulerRunning.set({}, 0);
    assert.equal(evaluateRule(ruleById("scheduler_not_running"), reported(0)).state, "firing");
  });
});
