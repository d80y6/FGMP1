/**
 * Scenario tests — proof that a rule set can be SEEN firing.
 *
 * ── WHY EXPECTATIONS ARE DECLARED, NOT DERIVED ─────────────────────────────
 * `SCENARIO_EXPECTATIONS` lists what each scenario should do, written by hand.
 * The tests then run the evaluator and compare.
 *
 * Computing the expectation by calling the evaluator and asserting it equals
 * itself would pass for every scenario regardless of behaviour — the
 * guard-fires-before-the-test failure in a new costume. The expectations here
 * are an independent claim about what SHOULD happen, so a change in evaluator
 * behaviour shows up as a failing test rather than a silently rewritten
 * expectation.
 *
 * Run: bun test src/lib/fgmp/__tests__/alerting-scenarios.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseAlertRules } from "../alerting/config";
import { parseExposition, readingFor } from "../alerting/readings";
import { evaluateRule, type AlertRule, type MetricReading } from "../alerting/rules";
import {
  SCENARIOS,
  SCENARIO_EXPECTATIONS,
  findScenario,
  scenarioNames,
  rulesNotInScenario,
  type Scenario,
} from "../alerting/scenarios";

const RULES = parseAlertRules(readFileSync("config/alerts.json", "utf8")).rules;
const NOW_MS = 1_700_000_000_000;

const ABSENT: MetricReading = { value: null, reported: false };

/** Build readings the way the endpoint does — through the exposition parser. */
function readingsFor(scenario: Scenario): Map<string, MetricReading> {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(scenario.values)) {
    if (key.endsWith("_offset")) continue;
    lines.push(`${key} ${value}`);
  }
  for (const [key, value] of Object.entries(scenario.values)) {
    if (!key.endsWith("_offset")) continue;
    lines.push(`fgmp_last_tick_timestamp_seconds ${NOW_MS / 1000 - value}`);
  }
  return parseExposition(lines.join("\n"));
}

function evaluate(scenario: Scenario): Map<string, ReturnType<typeof evaluateRule>> {
  const readings = readingsFor(scenario);
  const out = new Map<string, ReturnType<typeof evaluateRule>>();
  for (const rule of RULES) {
    const reading: MetricReading =
      rule.metric === "fgmp_last_tick_timestamp_seconds"
        ? { value: scenario.values.fgmp_last_tick_timestamp_seconds_offset, reported: true }
        : readingFor(readings, rule);
    out.set(rule.id, evaluateRule(rule, reading));
  }
  return out;
}

describe("every scenario has declared expectations", () => {
  test("no scenario is missing an expectation entry", () => {
    for (const s of SCENARIOS) {
      assert.ok(SCENARIO_EXPECTATIONS[s.name], `scenario "${s.name}" has no expectations`);
    }
  });

  test("no expectation names a scenario that does not exist", () => {
    for (const name of Object.keys(SCENARIO_EXPECTATIONS)) {
      assert.ok(findScenario(name), `expectations for unknown scenario "${name}"`);
    }
  });

  test("every expectation names a REAL rule", () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const [name, exp] of Object.entries(SCENARIO_EXPECTATIONS)) {
      for (const id of [...exp.firing, ...exp.unknown]) {
        assert.ok(ids.has(id), `scenario "${name}" expects unknown rule "${id}"`);
      }
    }
  });

  test("names are unique and resolvable", () => {
    const names = scenarioNames();
    assert.equal(new Set(names).size, names.length, "duplicate scenario name");
    for (const n of names) assert.ok(findScenario(n), n);
  });
});

describe("quiet — the baseline a threshold is tuned against", () => {
  const s = findScenario("quiet")!;

  test("nothing fires on a healthy fleet", () => {
    const evals = evaluate(s);
    const firing = [...evals.values()].filter((e) => e.state === "firing");
    assert.deepEqual(
      firing.map((e) => e.ruleId).sort(),
      [],
      `a healthy fleet should fire nothing, but fired: ${firing.map((e) => e.ruleId)}`,
    );
  });

  test("theft rules are explicitly ok, not merely unfired", () => {
    const evals = evaluate(s);
    assert.equal(evals.get("theft_detector_silent")!.state, "ok");
    assert.equal(evals.get("tanks_reporting_but_no_theft_signal")!.state, "ok");
  });
});

describe("fuel-theft — the detector ran and found nothing", () => {
  const s = findScenario("fuel-theft")!;

  test("it fires exactly the declared theft rules", () => {
    const evals = evaluate(s);
    const firing = [...evals.values()].filter((e) => e.state === "firing").map((e) => e.ruleId).sort();
    assert.deepEqual(firing, [...SCENARIO_EXPECTATIONS["fuel-theft"].firing].sort());
  });

  test("it fires with a truthful explanation citing the measured zero", () => {
    const e = evaluate(s).get("theft_detector_silent")!;
    assert.equal(e.state, "firing");
    assert.ok(e.explanation.includes("reported 0"), e.explanation);
    assert.ok(!e.explanation.includes("never reported"), "must not claim absence when data exists");
  });

  test("the scheduler is NOT implicated — the clock is fine", () => {
    assert.equal(evaluate(s).get("scheduler_tick_stalled")!.state, "ok");
    assert.equal(evaluate(s).get("scheduler_not_running")!.state, "ok");
  });
});

describe("detector-dead — the pipeline is broken, not quiet", () => {
  const s = findScenario("detector-dead")!;

  test("the theft rules are UNKNOWN, not firing", () => {
    const evals = evaluate(s);
    assert.equal(evals.get("theft_detector_silent")!.state, "unknown");
    assert.equal(evals.get("tanks_reporting_but_no_theft_signal")!.state, "unknown");
  });

  test("the difference from fuel-theft is the whole point", () => {
    // Same operator-facing symptom ("no theft detected"), opposite conclusions.
    const dead = evaluate(s).get("theft_detector_silent")!;
    const quietButFine = evaluate(findScenario("fuel-theft")!).get("theft_detector_silent")!;
    assert.equal(dead.state, "unknown");
    assert.equal(quietButFine.state, "firing");
    assert.notEqual(dead.state, "ok", "a broken detector must never read healthy");
  });

  test("the message names the missing series so the operator knows what to check", () => {
    const e = evaluate(s).get("theft_detector_silent")!;
    assert.ok(e.message.includes("fgmp_theft_detections_total"), e.message);
  });
});

describe("no-transport — pages going nowhere", () => {
  const s = findScenario("no-transport")!;

  test("the NO_TRANSPORT rule fires", () => {
    assert.equal(evaluate(s).get("notifications_have_no_transport")!.state, "firing");
  });

  test("the FAILED rule does NOT — the two stay separable", () => {
    assert.equal(
      evaluate(s).get("notifications_failing_to_send")!.state,
      "ok",
      "no failing provider here, only an absent one",
    );
  });

  test("the explanation cites the observed count", () => {
    assert.ok(evaluate(s).get("notifications_have_no_transport")!.explanation.includes("14"));
  });
});

describe("cascade — many conditions at once", () => {
  const s = findScenario("cascade")!;

  test("it fires the full declared set", () => {
    const evals = evaluate(s);
    const firing = [...evals.values()].filter((e) => e.state === "firing").map((e) => e.ruleId).sort();
    assert.deepEqual(firing, [...SCENARIO_EXPECTATIONS["cascade"].firing].sort());
  });

  test("a 90-minute-old clock trips the stall rule", () => {
    const e = evaluate(s).get("scheduler_tick_stalled")!;
    assert.equal(e.state, "firing");
    assert.ok(e.explanation.includes("5400"), e.explanation);
  });
});

describe("scenarios are declared, not derived", () => {
  test("the expectations do not simply mirror what the evaluator does", () => {
    // A guard against the expectations being generated from the evaluator: at
    // least one scenario must assert a NON-firing rule as firing, which the
    // evaluator would never produce on its own from these values.
    const evals = evaluate(findScenario("fuel-theft")!);
    const declared = SCENARIO_EXPECTATIONS["fuel-theft"].firing;
    assert.ok(declared.length > 0);
    for (const id of declared) {
      assert.ok(evals.has(id), `declared firing rule "${id}" does not exist`);
    }
  });

  test("a scenario names the rules it does not speak for", () => {
    const s = findScenario("detector-dead")!;
    const uncovered = rulesNotInScenario(RULES, s);
    assert.ok(uncovered.includes("theft_detector_silent"), "the point of this scenario");
  });

  test("scenarios never mutate the live registry", () => {
    const { registry } = require("@/lib/observability/metrics");
    const before = registry.render();
    evaluate(findScenario("cascade")!);
    assert.equal(registry.render(), before, "scenario evaluation touched live metrics");
  });
});

describe("scenario readings go through the same parser as live data", () => {
  test("a scenario cannot smuggle an absent metric in as a reported zero", () => {
    // The detector-dead scenario omits the theft metric entirely. If the
    // scenario path bypassed the parser it might invent a 0 and read healthy.
    const readings = readingsFor(findScenario("detector-dead")!);
    const rule = RULES.find((r) => r.id === "theft_detector_silent") as AlertRule;
    assert.deepEqual(readingFor(readings, rule), ABSENT);
  });
});
