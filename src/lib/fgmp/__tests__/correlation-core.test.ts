/**
 * Unit tests for the server-side correlation core.
 *
 * These run with no database, no server and no browser — which is the point.
 * The previous implementation could only be exercised from a React component
 * with localStorage seeded and a fetch mock, so "is correlation correct?" was
 * not answerable without standing up the whole application.
 *
 * Run:  bun test src/lib/fgmp/__tests__/correlation-core.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRules,
  matchKey,
  encodeAlarmIds,
  splitResults,
  NATIONAL_BUCKET,
  type ServerRule,
  type CorrelationAlarm,
  type SiteScope,
} from "../correlation/core";

/** Fixed instant. Never Date.now() — the whole module is clock-injected. */
const NOW = 1_700_000_000_000;
const MIN = 60_000;

function site(
  id: string,
  regionId: string,
  governorateId: string,
): SiteScope {
  return {
    siteId: id,
    siteLabel: `Site ${id}`,
    regionId,
    regionLabel: `Region ${regionId}`,
    governorateId,
    governorateLabel: `Gov ${governorateId}`,
  };
}

function alarm(
  id: string,
  type: string,
  minutesAgo: number,
  siteId: string | null = "s1",
  regionId: string | null = "r1",
  governorateId: string | null = "g1",
): CorrelationAlarm {
  return { id, type, createdAt: NOW - minutesAgo * MIN, siteId, regionId, governorateId };
}

const RULE: ServerRule = {
  id: "rule-1",
  tenantId: "t1",
  enabled: true,
  alarmType: "FUEL_CRITICAL",
  threshold: 3,
  windowMinutes: 15,
  scope: "REGION",
  escalateTo: "L3",
};

const SITES = [site("s1", "r1", "g1"), site("s2", "r2", "g2"), site("s3", "r1", "g1")];

describe("evaluateRules — determinism", () => {
  test("same inputs produce byte-identical output", () => {
    const alarms = [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2)];

    const first = evaluateRules([RULE], alarms, SITES, NOW);
    const second = evaluateRules([RULE], alarms, SITES, NOW);

    assert.deepEqual(first, second);
    // Serialised, so property order and array order are both pinned down.
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test("output does not depend on alarm input order", () => {
    const forward = [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 3)];
    const reversed = [...forward].reverse();

    const a = evaluateRules([RULE], forward, SITES, NOW);
    const b = evaluateRules([RULE], reversed, SITES, NOW);

    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test("rule input order does not change per-rule results", () => {
    const r2: ServerRule = { ...RULE, id: "rule-2", threshold: 2, scope: "SITE" };
    const alarms = [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2)];

    const forward = evaluateRules([RULE, r2], alarms, SITES, NOW);
    const backward = evaluateRules([r2, RULE], alarms, SITES, NOW);

    const key = (rs: ReturnType<typeof evaluateRules>) =>
      JSON.stringify(
        [...rs].sort((x, y) => (x.ruleId < y.ruleId ? -1 : 1)),
      );
    assert.equal(key(forward), key(backward));
  });
});

describe("evaluateRules — idempotency (same event twice -> one match)", () => {
  test("evaluating the same stream twice yields the same match key, not a new one", () => {
    const alarms = [
      alarm("a1", "FUEL_CRITICAL", 1),
      alarm("a2", "FUEL_CRITICAL", 2),
      alarm("a3", "FUEL_CRITICAL", 3),
    ];

    const first = splitResults(evaluateRules([RULE], alarms, SITES, NOW));
    const second = splitResults(evaluateRules([RULE], alarms, SITES, NOW));

    assert.equal(first.matches.length, 1);
    assert.equal(second.matches.length, 1);

    // This is the property the UNIQUE constraint enforces in SQL. Two runs
    // over an unchanged stream MUST collapse to one persisted row.
    assert.equal(matchKey(first.matches[0]), matchKey(second.matches[0]));
  });

  test("the idempotency key is insensitive to alarm ordering within the match", () => {
    const alarms = [
      alarm("a1", "FUEL_CRITICAL", 1),
      alarm("a2", "FUEL_CRITICAL", 2),
      alarm("a3", "FUEL_CRITICAL", 3),
    ];
    const one = splitResults(evaluateRules([RULE], alarms, SITES, NOW)).matches[0];
    const two = splitResults(evaluateRules([RULE], [...alarms].reverse(), SITES, NOW)).matches[0];

    assert.equal(matchKey(one), matchKey(two));
  });

  test("a genuinely NEW event produces a DIFFERENT key", () => {
    // The counter-test. If the key were constant per rule+scope, a real second
    // escalation would be silently swallowed as a duplicate.
    const first = splitResults(
      evaluateRules([RULE], [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 3)], SITES, NOW),
    ).matches[0];

    const second = splitResults(
      evaluateRules(
        [RULE],
        [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 3), alarm("a4", "FUEL_CRITICAL", 4)],
        SITES,
        NOW,
      ),
    ).matches[0];

    assert.notEqual(matchKey(first), matchKey(second));
  });

  test("encodeAlarmIds is order-insensitive", () => {
    assert.equal(encodeAlarmIds(["b", "a"]), encodeAlarmIds(["a", "b"]));
  });

  test("encodeAlarmIds rejects ids that would make the encoding ambiguous", () => {
    // Joining on "," is only injective while no id contains a comma. A cuid
    // never does, but the encoder must not DEPEND on that: a "," in an id
    // would make two different alarm sets encode identically, and the UNIQUE
    // constraint would then silently drop a real escalation as a duplicate.
    assert.throws(() => encodeAlarmIds(["a,b"]), /comma/i);
    assert.throws(() => encodeAlarmIds(["a", "b,c"]), /comma/i);
  });
});

describe("evaluateRules — threshold and window", () => {
  test("below threshold does not trigger", () => {
    const r = splitResults(
      evaluateRules([RULE], [alarm("a1", "FUEL_CRITICAL", 1)], SITES, NOW),
    );
    assert.equal(r.matches.length, 0);
    assert.equal(r.notTriggered[0].reason, "below-threshold");
  });

  test("exactly at threshold triggers", () => {
    const r = splitResults(
      evaluateRules(
        [RULE],
        [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 3)],
        SITES,
        NOW,
      ),
    );
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].matchCount, 3);
  });

  test("alarms outside the window are excluded", () => {
    const r = splitResults(
      evaluateRules(
        [RULE],
        [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 60)],
        SITES,
        NOW,
      ),
    );
    assert.equal(r.matches.length, 0);
  });

  test("a different alarm type is not counted", () => {
    const r = splitResults(
      evaluateRules([RULE], [alarm("a1", "GEN_FAILURE", 1), alarm("a2", "GEN_FAILURE", 2), alarm("a3", "GEN_FAILURE", 3)], SITES, NOW),
    );
    assert.equal(r.matches.length, 0);
  });

  test("ANY matches every alarm type", () => {
    const anyRule: ServerRule = { ...RULE, alarmType: "ANY" };
    const r = splitResults(
      evaluateRules(
        [anyRule],
        [alarm("a1", "GEN_FAILURE", 1), alarm("a2", "FUEL_LOW", 2), alarm("a3", "BATT_FAILURE", 3)],
        SITES,
        NOW,
      ),
    );
    assert.equal(r.matches.length, 1);
  });

  test("disabled rule never triggers", () => {
    const off: ServerRule = { ...RULE, enabled: false };
    const r = splitResults(
      evaluateRules([off], [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 3)], SITES, NOW),
    );
    assert.equal(r.matches.length, 0);
    assert.equal(r.notTriggered[0].reason, "disabled");
  });
});

describe("evaluateRules — scope bucketing", () => {
  test("SITE scope groups by site", () => {
    const r: ServerRule = { ...RULE, scope: "SITE", threshold: 2 };
    const res = splitResults(
      evaluateRules([r], [alarm("a1", "FUEL_CRITICAL", 1, "s1"), alarm("a2", "FUEL_CRITICAL", 2, "s1")], SITES, NOW),
    );
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].scopeKey, "s1");
  });

  test("REGION scope groups sites in the same region together", () => {
    // s1 and s3 are both in region r1.
    const res = splitResults(
      evaluateRules([RULE], [alarm("a1", "FUEL_CRITICAL", 1, "s1"), alarm("a2", "FUEL_CRITICAL", 2, "s1"), alarm("a3", "FUEL_CRITICAL", 3, "s3")], SITES, NOW),
    );
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].scopeKey, "r1");
    assert.equal(res.matches[0].matchCount, 3);
  });

  test("NATIONAL scope collapses every alarm into one bucket", () => {
    const r: ServerRule = { ...RULE, scope: "NATIONAL", threshold: 2 };
    const res = splitResults(
      evaluateRules([r], [alarm("a1", "FUEL_CRITICAL", 1, "s1"), alarm("a2", "FUEL_CRITICAL", 2, "s2")], SITES, NOW),
    );
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].scopeKey, NATIONAL_BUCKET);
    assert.equal(res.matches[0].matchCount, 2);
  });

  test("two independently-breaching regions BOTH escalate", () => {
    // r1 and r2 each reach the threshold. Recording only one would leave a
    // real cluster unescalated, which is the defect this replaced.
    const res = splitResults(
      evaluateRules(
        [{ ...RULE, threshold: 2 }],
        [
          alarm("a1", "FUEL_CRITICAL", 1, "s1", "r1", "g1"),
          alarm("a2", "FUEL_CRITICAL", 2, "s1", "r1", "g1"),
          alarm("a3", "FUEL_CRITICAL", 1, "s2", "r2", "g2"),
          alarm("a4", "FUEL_CRITICAL", 2, "s2", "r2", "g2"),
        ],
        SITES,
        NOW,
      ),
    );
    assert.equal(res.matches.length, 2);
    assert.deepEqual(res.matches.map((m) => m.scopeKey).sort(), ["r1", "r2"]);
  });

  test("an alarm with no site cannot be placed in a geographic bucket", () => {
    const res = splitResults(
      evaluateRules(
        [RULE],
        [alarm("a1", "FUEL_CRITICAL", 1, null), alarm("a2", "FUEL_CRITICAL", 2, null), alarm("a3", "FUEL_CRITICAL", 3, null)],
        SITES,
        NOW,
      ),
    );
    assert.equal(res.matches.length, 0);
    assert.equal(res.notTriggered[0].reason, "unresolvable-scope");
  });

  test("an unknown site id is not silently pooled into another bucket", () => {
    const res = splitResults(
      evaluateRules([{ ...RULE, threshold: 2 }], [alarm("a1", "FUEL_CRITICAL", 1, "ghost"), alarm("a2", "FUEL_CRITICAL", 2, "ghost")], SITES, NOW),
    );
    assert.equal(res.matches.length, 0);
  });
});

describe("evaluateRules — defensive behaviour", () => {
  test("a zero or negative threshold is clamped to 1, never unbounded", () => {
    const bad: ServerRule = { ...RULE, threshold: 0 };
    const res = splitResults(evaluateRules([bad], [alarm("a1", "FUEL_CRITICAL", 1)], SITES, NOW));
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].matchCount, 1);
  });

  test("a zero window is clamped to 1 minute rather than matching nothing", () => {
    const bad: ServerRule = { ...RULE, threshold: 1, windowMinutes: 0 };
    const res = splitResults(evaluateRules([bad], [alarm("a1", "FUEL_CRITICAL", 0)], SITES, NOW));
    assert.equal(res.matches.length, 1);
  });

  test("empty input is handled without throwing", () => {
    assert.deepEqual(evaluateRules([], [], [], NOW), []);
    const r = splitResults(evaluateRules([RULE], [], SITES, NOW));
    assert.equal(r.matches.length, 0);
    assert.equal(r.notTriggered[0].reason, "no-matching-alarms");
  });

  test("future-dated alarms are excluded, not counted", () => {
    const res = splitResults(
      evaluateRules(
        [{ ...RULE, threshold: 1 }],
        [{ id: "future", type: "FUEL_CRITICAL", createdAt: NOW + 60_000, siteId: "s1", regionId: "r1", governorateId: "g1" }],
        SITES,
        NOW,
      ),
    );
    assert.equal(res.matches.length, 0);
  });

  test("evaluation is pure — inputs are not mutated", () => {
    const alarms = [alarm("a1", "FUEL_CRITICAL", 1), alarm("a2", "FUEL_CRITICAL", 2), alarm("a3", "FUEL_CRITICAL", 3)];
    const rules = [RULE];
    const sites = [...SITES];
    const snapshot = JSON.stringify({ alarms, rules, sites });

    evaluateRules(rules, alarms, sites, NOW);

    assert.equal(JSON.stringify({ alarms, rules, sites }), snapshot);
  });
});