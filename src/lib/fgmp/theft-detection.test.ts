/**
 * Tests for fuel theft DETECTION.
 *
 * The false-positive cases carry more weight than the true-positive ones. A
 * detector that cries wolf gets ignored, and an ignored theft detector is
 * indistinguishable from no detector at all — while costing an operator their
 * trust in every other alarm.
 */

import { describe, expect, test } from "bun:test";
import {
  detectUnexplainedLoss,
  toleranceFor,
  burnRateLitresPerHour,
  expectedConsumption,
  severityFor,
  DEFAULT_SENSOR_ACCURACY,
  type TheftEvidence,
} from "./theft-detection";

/** A window with no unexplained loss: the tank dropped exactly what was burned. */
const clean = (over: Partial<TheftEvidence> = {}): TheftEvidence => ({
  tankId: "tank-1",
  siteId: "site-1",
  levelStartLitres: 1000,
  levelEndLitres: 880,
  expectedConsumptionLitres: 120,
  windowHours: 4,
  capacityLitres: 2000,
  sensorAccuracyFraction: DEFAULT_SENSOR_ACCURACY,
  ...over,
});

describe("toleranceFor — the error budget must SCALE with the tank", () => {
  test("a bigger tank has a bigger absolute tolerance", () => {
    const small = toleranceFor(clean({ capacityLitres: 500 }));
    const large = toleranceFor(clean({ capacityLitres: 5000 }));
    // A fixed tolerance is wrong in both directions: it would never fire on a
    // large tank and would fire constantly on a small one.
    expect(large).toBeGreaterThan(small);
  });

  test("tolerance grows with worse sensor accuracy", () => {
    const good = toleranceFor(clean({ sensorAccuracyFraction: 0.005 }));
    const poor = toleranceFor(clean({ sensorAccuracyFraction: 0.05 }));
    expect(poor).toBeGreaterThan(good);
  });

  test("tolerance is always positive and finite", () => {
    for (const cap of [0, 1, 1000, 1e6]) {
      const t = toleranceFor(clean({ capacityLitres: cap }));
      expect(t).toBeGreaterThan(0);
      expect(Number.isFinite(t)).toBe(true);
    }
  });
});

describe("detectUnexplainedLoss — true positives", () => {
  test("a large unexplained drop is detected", () => {
    // 1000 → 700 with only 120 L expected to have burned: 180 L unexplained.
    const hit = detectUnexplainedLoss(clean({ levelEndLitres: 700 }));
    expect(hit).not.toBeNull();
    expect(hit!.unexplainedLitres).toBeCloseTo(180, 1);
    expect(hit!.significance).toBeGreaterThan(1);
  });

  test("reports the evidence needed to reconstruct the finding", () => {
    // An accusation with no numbers is unactionable and unauditable.
    const hit = detectUnexplainedLoss(clean({ levelEndLitres: 700 }))!;
    expect(hit.expectedLitres).toBe(120);
    expect(hit.measuredLitres).toBe(300);
    expect(hit.toleranceLitres).toBeGreaterThan(0);
    expect(hit.tankId).toBe("tank-1");
    expect(hit.siteId).toBe("site-1");
  });

  test("a bigger discrepancy gets a higher significance", () => {
    const modest = detectUnexplainedLoss(clean({ levelEndLitres: 750 }))!;
    const severe = detectUnexplainedLoss(clean({ levelEndLitres: 500 }))!;
    expect(severe.significance).toBeGreaterThan(modest.significance);
  });
});

describe("detectUnexplainedLoss — FALSE POSITIVES, which matter more", () => {
  test("exact expected consumption is NOT a detection", () => {
    expect(detectUnexplainedLoss(clean())).toBeNull();
  });

  test("a gap inside the error budget is NOT a detection", () => {
    // 1 L of unexplained loss on a 2000 L tank with ±2% sensor accuracy is
    // noise, not theft.
    expect(detectUnexplainedLoss(clean({ levelEndLitres: 879 }))).toBeNull();
  });

  test("a RISING level is NOT theft", () => {
    // A delivery, a temperature correction, or a stuck sensor. Reporting this
    // as theft is the fastest way to make an operator disable the detector.
    expect(detectUnexplainedLoss(clean({ levelEndLitres: 1200 }))).toBeNull();
  });

  test("a stationary tank with a stopped engine is NOT theft", () => {
    // Nothing burned, nothing went missing.
    expect(
      detectUnexplainedLoss(
        clean({ levelEndLitres: 1000, expectedConsumptionLitres: 0 }),
      ),
    ).toBeNull();
  });

  test("a very short window is refused outright", () => {
    // Thirty seconds of runtime is not enough to distinguish a leak from noise.
    expect(
      detectUnexplainedLoss(clean({ levelEndLitres: 500, windowHours: 0.5 })),
    ).toBeNull();
  });

  test("poor sensor accuracy suppresses small losses rather than raising them", () => {
    const evidence = clean({ levelEndLitres: 860, sensorAccuracyFraction: 0.10 });
    // ±10% of 2000 L is a 200 L budget, so a 40 L gap is not evidence.
    expect(detectUnexplainedLoss(evidence)).toBeNull();
  });

  test("the same 40 L gap IS a detection on an accurate small tank", () => {
    const hit = detectUnexplainedLoss(
      clean({
        levelStartLitres: 500,
        levelEndLitres: 440,
        expectedConsumptionLitres: 20,
        capacityLitres: 500,
        sensorAccuracyFraction: 0.005,
        windowHours: 2,
      }),
    );
    // 60 L unexplained against a ~7 L budget.
    expect(hit).not.toBeNull();
    expect(hit!.significance).toBeGreaterThan(5);
  });
});

describe("burnRateLitresPerHour", () => {
  test("scales linearly with rated power", () => {
    const a = burnRateLitresPerHour(100);
    const b = burnRateLitresPerHour(200);
    expect(b).toBeCloseTo(a * 2, 6);
  });

  test("a 100 kW set burns a physically plausible rate", () => {
    // 100 kW / 0.35 = 285.7 kWh/h of fuel energy = 1028.6 MJ/h.
    // / 35.8 MJ/kg = 28.7 kg/h. / 0.84 kg/L = ~34.2 L/h.
    //
    // That is roughly 800 L/day, which sounds alarming and is correct. The
    // bound exists so a constant error is caught: this module's whole value is
    // that it is derived rather than guessed, and a derived number that is an
    // order of magnitude off would silently corrupt every detection.
    const rate = burnRateLitresPerHour(100);
    expect(rate).toBeCloseTo(34.2, 0);
    expect(rate).toBeGreaterThan(25);
    expect(rate).toBeLessThan(45);
  });

  test("higher efficiency means less fuel for the same power", () => {
    expect(burnRateLitresPerHour(100, 0.45)).toBeLessThan(burnRateLitresPerHour(100, 0.30));
  });

  test("zero or negative power yields zero, not a negative rate", () => {
    expect(burnRateLitresPerHour(0)).toBe(0);
    expect(burnRateLitresPerHour(-50)).toBe(0);
  });
});

describe("expectedConsumption", () => {
  test("is the burn rate times the runtime DELTA", () => {
    const rate = burnRateLitresPerHour(100);
    expect(expectedConsumption(100, 4)).toBeCloseTo(rate * 4, 6);
  });

  test("a negative runtime delta cannot produce negative consumption", () => {
    // Clock skew between the generator controller and the server would do this.
    expect(expectedConsumption(100, -3)).toBe(0);
  });
});

describe("severityFor — ranking, not a binary", () => {
  test("a marginal finding stays below the alert floor", () => {
    const marginal = {
      tankId: "t", siteId: "s", unexplainedLitres: 5, significance: 1.2,
      toleranceLitres: 4, expectedLitres: 0, measuredLitres: 5,
    };
    // Below the warn threshold it must not page anyone. A detector that fires
    // constantly is worse than none.
    expect(severityFor(marginal)).toBeNull();
  });

  test("a solid finding warns", () => {
    const warn = {
      tankId: "t", siteId: "s", unexplainedLitres: 60, significance: 3,
      toleranceLitres: 20, expectedLitres: 0, measuredLitres: 60,
    };
    expect(severityFor(warn)).toBe("WARNING");
  });

  test("a large, far-out-of-budget finding is CRITICAL", () => {
    const crit = {
      tankId: "t", siteId: "s", unexplainedLitres: 800, significance: 25,
      toleranceLitres: 32, expectedLitres: 0, measuredLitres: 800,
    };
    expect(severityFor(crit)).toBe("CRITICAL");
  });

  test("high significance alone is NOT enough if the volume is trivial", () => {
    // 40 L out of budget but tiny in absolute terms — a siphon-scale event on a
    // large site. Both conditions must hold for CRITICAL.
    const smallButFar = {
      tankId: "t", siteId: "s", unexplainedLitres: 8, significance: 30,
      toleranceLitres: 0.27, expectedLitres: 0, measuredLitres: 8,
    };
    expect(severityFor(smallButFar)).toBe("WARNING");
  });
});

describe("end-to-end: the injected-theft scenario the detector must still catch", () => {
  test("a 180 L drop with only 120 L burned is caught", () => {
    // The scenario the old code FABRICATED — but now it has to be derived from
    // the measurements rather than announced by the thing that caused it.
    const hit = detectUnexplainedLoss(
      clean({
        levelStartLitres: 1000,
        levelEndLitres: 820,
        expectedConsumptionLitres: 120,
        windowHours: 4,
        capacityLitres: 2000,
        // A tight sensor so the 60 L gap clears the budget. With the default
        // ±2% of a 2000 L tank the budget is ~40 L and 60 L is only 1.5x
        // significance — detected, but the test should not depend on the
        // default error budget to pass.
        sensorAccuracyFraction: 0.005,
      }),
    );
    expect(hit).not.toBeNull();
    expect(hit!.unexplainedLitres).toBeCloseTo(60, 1);
    expect(severityFor(hit!)).not.toBeNull();
  });
});
