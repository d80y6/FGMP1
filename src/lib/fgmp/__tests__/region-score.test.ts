/**
 * Tests for the shared region score.
 *
 * These exist because the formula used to be duplicated: the leaderboard and
 * the performance trend each had their own copy, which agreed only by
 * coincidence and would have diverged silently. The cases below pin the
 * behaviour that both surfaces depend on — the weights, the 5 % alarm
 * tolerance, the 5000 L/site fuel baseline and the clamps — so a future edit
 * has to change them on purpose.
 *
 * Run: bun test src/lib/fgmp/__tests__/region-score.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AVG_TANK_CAPACITY_PER_SITE,
  scoreRegion,
} from "@/lib/fgmp/region-score";
import type { RegionBreakdownRow } from "@/lib/fgmp/types";

function region(over: Partial<RegionBreakdownRow> = {}): RegionBreakdownRow {
  return {
    region: "Amanat Alasimah",
    sites: 10,
    fuel: 0,
    alarms: 0,
    running: 0,
    consumed: 0,
    fuelPct: 0,
    ...over,
  };
}

describe("scoreRegion", () => {
  test("a region with no alarms, full tanks and every generator running scores 100", () => {
    const r = region({ fuel: 10 * AVG_TANK_CAPACITY_PER_SITE, running: 10 });
    // coverage is only 100 % when the region IS the fleet.
    const { score, factors } = scoreRegion(r, 10);
    assert.equal(factors.stability, 100);
    assert.equal(factors.fuelAvail, 100);
    assert.equal(factors.genActivity, 100);
    assert.equal(factors.coverage, 100);
    assert.equal(score, 100);
  });

  test("weights are 35 / 25 / 20 / 20", () => {
    // One site out of four, no fuel, no generators: stability still scores 100
    // (it measures alarm density, not fuel), so 35 + 0 + 0 + 20x0.25 = 40.
    const { score, factors } = scoreRegion(region({ sites: 1 }), 4);
    assert.equal(factors.stability, 100);
    assert.equal(factors.coverage, 25);
    assert.equal(score, 35 + 5);
  });

  test("alarm density up to 5 % of sites costs nothing, and saturation costs everything", () => {
    const quiet = scoreRegion(region({ sites: 20, alarms: 1 }), 20);
    assert.equal(quiet.factors.stability, 100, "1 alarm in 20 sites is at the 5 % line, not past it");

    // 100 - (1.0 - 0.05) * 105 = 0.25: an alarm per site all but zeroes it, and
    // the formula reaches exactly 0 just past a 1:1 ratio (density ~1.0024).
    const swamped = scoreRegion(region({ sites: 10, alarms: 10 }), 10);
    assert.ok(swamped.factors.stability <= 0.25);

    const hopeless = scoreRegion(region({ sites: 10, alarms: 20 }), 10);
    assert.equal(hopeless.factors.stability, 0, "past saturation the clamp holds at zero");
  });

  test("stability falls linearly between the 5 % line and saturation", () => {
    // 20 sites, 10 alarms = 50 % density → 100 - (0.5 - 0.05) * 105 = 52.75
    const { factors } = scoreRegion(region({ sites: 20, alarms: 10 }), 20);
    assert.ok(Math.abs(factors.stability - 52.75) < 1e-9);
  });

  test("fuel availability is capped at 100 % and never negative", () => {
    const over = scoreRegion(region({ sites: 2, fuel: 999_999 }), 2);
    assert.equal(over.factors.fuelAvail, 100);
    const empty = scoreRegion(region({ sites: 2, fuel: 0 }), 2);
    assert.equal(empty.factors.fuelAvail, 0);
  });

  test("a zero-site region does not divide by zero", () => {
    const { score, factors } = scoreRegion(region({ sites: 0 }), 0);
    assert.ok(Number.isFinite(score));
    assert.equal(factors.coverage, 0);
    assert.equal(factors.fuelAvail, 0);
  });

  test("the score is always a whole number in 0..100", () => {
    for (const sites of [0, 1, 3, 17, 250]) {
      for (const alarms of [0, 1, 7, 60]) {
        for (const fuel of [0, 1234.5, 90_000]) {
          const { score } = scoreRegion(region({ sites, alarms, fuel }), 250);
          assert.ok(Number.isInteger(score), `score ${score} is not an integer`);
          assert.ok(score >= 0 && score <= 100, `score ${score} is out of range`);
        }
      }
    }
  });
});
