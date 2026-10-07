/**
 * Tests for the consumption projection.
 *
 * Pure, no database, deterministic — same discipline as `interlocks.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  projectConsumption,
  drainDaysToEmpty,
  meanDailyRate,
  type HourBucket,
} from "./metrics-fuel-projection";

/** Build a series from a generator function of hoursAgo. */
const series = (fn: (hoursAgo: number) => number, n = 24): HourBucket[] =>
  Array.from({ length: n }, (_, i) => ({ hoursAgo: i, litres: fn(i) }));

describe("projectConsumption — empty and degenerate input", () => {
  test("no buckets produces no projection rather than throwing", () => {
    const p = projectConsumption([]);
    expect(p.daily).toHaveLength(0);
    expect(p.daily.every((d) => d === 0)).toBe(true);
    expect(p.samples).toBe(0);
    expect(p.slopeLitresPerHour).toBe(0);
  });

  test("two points cannot establish a trend, so the slope is reported as zero", () => {
    // Fitting a line through two points always produces a confident-looking
    // slope from almost no evidence. Reporting 0 with the mean is the honest
    // answer and the caller can show "not enough history".
    const p = projectConsumption([
      { hoursAgo: 0, litres: 10 },
      { hoursAgo: 1, litres: 50 },
    ]);
    expect(p.slopeLitresPerHour).toBe(0);
    expect(p.samples).toBe(2);
    expect(p.rSquared).toBe(0);
  });

  test("a single bucket projects its own rate", () => {
    const p = projectConsumption([{ hoursAgo: 0, litres: 5 }]);
    expect(p.samples).toBe(1);
    // 5 L/h × 24 h
    expect(p.daily[0]).toBe(120);
  });
});

describe("projectConsumption — the defect this replaced", () => {
  test("seven forecast days DIFFER when the trend is real", () => {
    // The old code copied one number seven times. This is the regression.
    // hoursAgo counts BACKWARDS: index 0 is the MOST RECENT hour. So
    // `100 + 5h` is old=220, recent=100 — consumption is EASING, and the
    // projection must fall away rather than climb.
    const easing = projectConsumption(series((h) => 100 + h * 5));
    expect(new Set(easing.daily).size).toBeGreaterThan(1);
    expect(easing.direction).toBe("EASING");
    expect(easing.daily[6]).toBeLessThan(easing.daily[0]);

    // The mirror: old=80, recent=200 is consumption RISING, and later days
    // must project higher.
    const rising = projectConsumption(series((h) => 200 - h * 5));
    expect(new Set(rising.daily).size).toBeGreaterThan(1);
    expect(rising.direction).toBe("INCREASING");
    expect(rising.daily[6]).toBeGreaterThan(rising.daily[0]);
  });

  test("a FLAT series genuinely produces equal days", () => {
    // Equality here is correct, not the old bug: with no slope there is
    // nothing to differentiate.
    const p = projectConsumption(series(() => 10));
    expect(p.slopeLitresPerHour).toBe(0);
    expect(new Set(p.daily).size).toBe(1);
    expect(p.daily[0]).toBe(240);
  });

  test("projected daily volume never goes negative", () => {
    // A falling trend extrapolated far enough goes below zero. Clamping to zero
    // is correct: negative consumption is not a thing.
    const p = projectConsumption(series((h) => 100 - h * 10));
    expect(p.daily.every((d) => d >= 0)).toBe(true);
  });
});

describe("projectConsumption — slope and fit quality", () => {
  test("recovers a known slope", () => {
    // y = 50 - 2*hoursAgo  ⇒  raw slope -2 L/h. Because hoursAgo counts
    // backwards, a negative raw slope means consumption RISING.
    const p = projectConsumption(series((h) => 50 - 2 * h));
    expect(p.slopeLitresPerHour).toBeCloseTo(-2, 3);
    expect(p.direction).toBe("INCREASING");
  });

  test("a perfect line has R² of 1", () => {
    const p = projectConsumption(series((h) => 20 + 3 * h));
    expect(p.rSquared).toBeCloseTo(1, 5);
  });

  test("pure noise reports a LOW R² so callers can decline to act on the slope", () => {
    // Deterministic pseudo-noise: alternating spikes. A real trend is absent,
    // and the module must say so rather than return a confident slope.
    const noisy = series((h) => 50 + ((h * 7919) % 13) - 6);
    const p = projectConsumption(noisy);
    expect(p.rSquared).toBeLessThan(0.6);
  });

  test("R² is finite and bounded for every input", () => {
    for (const n of [3, 5, 12, 24, 48]) {
      const p = projectConsumption(series((h) => 10 + Math.sin(h) * 5, n));
      expect(Number.isFinite(p.rSquared)).toBe(true);
      expect(p.rSquared).toBeGreaterThanOrEqual(0);
      expect(p.rSquared).toBeLessThanOrEqual(1);
    }
  });

  test("input order does not matter", () => {
    const forwards = series((h) => 30 - 1.5 * h);
    const a = projectConsumption(forwards);
    const b = projectConsumption([...forwards].reverse());
    expect(a.slopeLitresPerHour).toBeCloseTo(b.slopeLitresPerHour, 6);
    expect(a.rSquared).toBeCloseTo(b.rSquared, 6);
  });
});

describe("drainDaysToEmpty — refuses to invent a date", () => {
  test("returns a date when consumption is RISING", () => {
    // Consumption rising ⇒ raw slope negative ⇒ -(-5) = +5 L/h = 120 L/day.
    const p = projectConsumption(series((h) => 200 - 5 * h));
    expect(p.direction).toBe("INCREASING");
    const days = drainDaysToEmpty(600, p);
    expect(days).not.toBeNull();
    expect(days!).toBeCloseTo(5, 1); // 600 L / 120 L per day
  });

  test("returns NULL when consumption is EASING — a refilling tank has no dry-out date", () => {
    // This is the case that made the linear fit dangerous: extrapolating a
    // rising raw slope toward zero wraps and reports a date for a tank that is
    // filling. A wrong date is worse than no date.
    const p = projectConsumption(series((h) => 20 + 4 * h));
    expect(p.direction).toBe("EASING");
    expect(drainDaysToEmpty(600, p)).toBeNull();
  });

  test("never returns a negative or zero drain date", () => {
    // A negative "days until empty" is not a date; it means the sign
    // convention slipped and the value would reach an operator's screen.
    for (const fn of [(h: number) => 200 - 5 * h, (h: number) => 100 + 5 * h, () => 50]) {
      const p = projectConsumption(series(fn));
      const d = drainDaysToEmpty(600, p);
      if (d !== null) expect(d).toBeGreaterThan(0);
    }
  });

  test("returns NULL for a flat trend", () => {
    const p = projectConsumption(series(() => 30));
    expect(drainDaysToEmpty(600, p)).toBeNull();
  });

  test("returns NULL with too little history", () => {
    const p = projectConsumption([{ hoursAgo: 0, litres: 100 }]);
    expect(drainDaysToEmpty(600, p)).toBeNull();
  });

  test("returns NULL for a non-positive or non-finite level", () => {
    const p = projectConsumption(series((h) => 200 - 5 * h));
    expect(p.direction).toBe("INCREASING");
    expect(drainDaysToEmpty(0, p)).toBeNull();
    expect(drainDaysToEmpty(-100, p)).toBeNull();
    expect(drainDaysToEmpty(Number.NaN, p)).toBeNull();
  });

  test("a large tank and a small one drain proportionally", () => {
    const p = projectConsumption(series((h) => 200 - 5 * h));
    expect(p.direction).toBe("INCREASING");
    const big = drainDaysToEmpty(1200, p)!;
    const small = drainDaysToEmpty(300, p)!;
    expect(big).toBeCloseTo(small * 4, 0);
  });
});

describe("meanDailyRate", () => {
  test("scales the hourly mean to a day", () => {
    expect(meanDailyRate(series(() => 10))).toBe(240);
  });

  test("empty input is zero, not NaN", () => {
    expect(meanDailyRate([])).toBe(0);
  });
});
