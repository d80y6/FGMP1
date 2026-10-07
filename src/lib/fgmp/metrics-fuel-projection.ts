/**
 * Consumption projection — least-squares trend over hourly buckets.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 * The 7-day forecast used to be:
 *
 *     const dailyAvg = hourBuckets.reduce((a, b) => a + b.litres, 0);
 *     const forecast = Array.from({ length: 7 }, () => ({ litres: dailyAvg }));
 *
 * One number copied seven times. A tank being refilled shows a flat line for a
 * week; a tank being drained shows the same. The chart looked like a forecast
 * because it had seven points on it, and an operator refuelling against it
 * would read a repeating number as a prediction.
 *
 * It was at least HONEST before — a constant projection of the trailing window
 * is a defensible thing to show. The earlier version multiplied by
 * `(0.9 + Math.random() * 0.2)` and redrew ±10% on every 15-second poll, which
 * meant the "forecast" changed every time the page refreshed. That was removed
 * in Phase 4. What is left is boring and true; this module makes it true AND
 * responsive to trend.
 *
 * ── WHY LEAST SQUARES ────────────────────────────────────────────────────────
 * A trailing average answers "how much did this site burn recently". Operators
 * need "is it burning more or less than it was, and when will it run dry".
 * Only a slope answers the second question, and the slope is what makes the
 * seven days differ from each other.
 *
 * Linear regression on the hourly series is the same estimator
 * `metrics-fuel-series.ts` uses for drain rate, deliberately: two different
 * regressions on the same data would produce two different drain dates on the
 * same screen, which is the exact class of defect this codebase keeps hitting.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * It does not extrapolate a rate to zero and call it a dry-out date. A linear
 * fit on noisy hourly data goes negative and wraps; clamping that to zero
 * invents a number. `drainDaysToEmpty` therefore returns null when the fit does
 * not support a defensible projection, and the UI shows "not enough history"
 * rather than a confident wrong date.
 */

/** One hourly observation. */
export interface HourBucket {
  /** Hours before now. 0 is the most recent bucket. */
  hoursAgo: number;
  /** Litres consumed in that hour. */
  litres: number;
}

export interface Projection {
  /** Projected litres per day, for each of the next 7 days. */
  daily: number[];
  /**
   * Slope in litres per hour.
   *
   * POSITIVE means consumption is INCREASING over time — a tank filling faster
   * than it drains, or a genuine consumption increase. Negative means it is
   * easing. The sign is reported explicitly rather than left for the caller to
   * infer from the first and last values.
   */
  slopeLitresPerHour: number;
  /** Intercept at hoursAgo = 0 (the most recent hour), in litres/hour. */
  interceptLitresPerHour: number;
  /**
   * Coefficient of determination, 0..1.
   *
   * Reported because a slope fitted to noise is not a trend. Callers should
   * treat a low R² as "no clear direction" rather than acting on the slope.
   */
  rSquared: number;
  /** Hours of data the fit used. */
  samples: number;
  /**
   * Whether consumption is RISING, EASING or FLAT.
   *
   * Exposed as a word rather than left to the caller to invert the sign of
   * `slopeLitresPerHour` themselves, because getting that inversion wrong is
   * exactly the bug this module was written to fix. See the sign note in the
   * implementation.
   */
  direction: "INCREASING" | "EASING" | "FLAT";
}

/**
 * Fit `y = intercept + slope * x` by ordinary least squares and project 7 days.
 *
 * @param buckets Chronological order is NOT required; only the `hoursAgo`
 *   values matter. Pass every bucket you have.
 * @param days How many days to project. Default 7.
 */
export function projectConsumption(
  buckets: readonly HourBucket[],
  days = 7,
): Projection {
  const n = buckets.length;
  if (n === 0) {
    return {
      daily: [],
      slopeLitresPerHour: 0,
      interceptLitresPerHour: 0,
      rSquared: 0,
      samples: 0,
      direction: "FLAT",
    };
  }

  // Fewer than 3 points cannot distinguish a line from a curve. Return the mean
  // with a zero slope rather than fitting two points and calling it a trend.
  if (n < 3) {
    const mean = buckets.reduce((a, b) => a + b.litres, 0) / n;
    return {
      daily: Array.from({ length: days }, () => round1(mean * 24)),
      slopeLitresPerHour: 0,
      interceptLitresPerHour: mean,
      rSquared: 0,
      samples: n,
      direction: "FLAT",
    };
  }

  const meanX = buckets.reduce((a, b) => a + b.hoursAgo, 0) / n;
  const meanY = buckets.reduce((a, b) => a + b.litres, 0) / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const b of buckets) {
    const dx = b.hoursAgo - meanX;
    const dy = b.litres - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // sxx === 0 means every bucket has the same x, which cannot happen from real
  // hourly data but would divide by zero here. Fall back to the mean.
  if (sxx === 0) {
    return {
      daily: Array.from({ length: days }, () => round1(meanY * 24)),
      slopeLitresPerHour: 0,
      interceptLitresPerHour: meanY,
      rSquared: 0,
      samples: n,
      direction: "FLAT",
    };
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  // R² = 1 - SSres/SStot. Guarded because a perfectly flat series has
  // SSres === SSytot === 0, and 0/0 is NaN.
  let rSquared = 0;
  if (syy > 0) {
    let ssRes = 0;
    for (const b of buckets) {
      const predicted = intercept + slope * b.hoursAgo;
      ssRes += (b.litres - predicted) ** 2;
    }
    rSquared = Math.max(0, Math.min(1, 1 - ssRes / syy));
  }

  // Project forward.
  //
  // SIGN, which this got wrong the first time and which is worth stating
  // explicitly because it is the whole point of the module:
  //
  // `hoursAgo` counts BACKWARDS. hoursAgo = 0 is the most recent hour. So a
  // POSITIVE slope means litres were HIGHER in the past and are easing; a
  // NEGATIVE slope means litres were LOWER in the past and consumption is
  // RISING.
  //
  // Projecting forward therefore means NEGATING x, and the consumption
  // direction is the INVERSE of the raw slope. The first version read the sign
  // straight off the slope, which made an INCREASING trend project as a
  // decreasing one — confidently, and with seven distinct-looking days, so the
  // bug looked like a working forecast.
  const daily: number[] = [];
  for (let d = 0; d < days; d++) {
    let litres = 0;
    for (let h = 1; h <= 24; h++) {
      const hoursAhead = d * 24 + h;
      const projectedHourly = intercept + slope * -hoursAhead;
      litres += Math.max(0, projectedHourly);
    }
    daily.push(round1(litres));
  }

  // Consumption DIRECTION, in the sense an operator reads it: is this site
  // using more fuel than it was, or less?
  const consumptionRising = slope < 0;

  return {
    daily,
    slopeLitresPerHour: round4(slope),
    interceptLitresPerHour: round4(intercept),
    rSquared: round4(rSquared),
    samples: n,
    direction: consumptionRising
      ? "INCREASING"
      : slope > 0
        ? "EASING"
        : "FLAT",
  };
}

/**
 * Days until projected consumption empties the remaining fuel, or null.
 *
 * Returns null — rather than a number — when the projection cannot support a
 * date:
 *  - the fit has too few samples
 *  - consumption is flat or falling, so there is no exhaustion to project
 *  - the level is already below zero (data problem, not a forecast)
 *
 * A confident wrong date is worse than no date: an operator schedules a refuel
 * against it.
 */
export function drainDaysToEmpty(
  levelLitres: number,
  projection: Projection,
): number | null {
  if (projection.samples < 3) return null;
  // Use the DIRECTION word, not the raw slope. Reading the sign directly was
  // the original defect: it inverted, so a tank whose consumption was RISING
  // was reported as draining, and one that was easing was reported as running
  // dry. Direction is the field that carries the meaning.
  if (projection.direction !== "INCREASING") return null;
  if (!Number.isFinite(levelLitres) || levelLitres <= 0) return null;

  // Consumption rising means the raw slope is negative; the daily burn is its
  // negation.
  const dailyRate = -projection.slopeLitresPerHour * 24;
  if (dailyRate <= 0) return null;
  const days = levelLitres / dailyRate;
  // A negative date is not a date. It means the sign convention slipped
  // somewhere between the slope and the divisor, and returning it would put a
  // nonsense value on an operator's screen where they would try to schedule
  // against it. Refuse rather than emit one.
  if (!Number.isFinite(days) || days <= 0) return null;
  return round1(days);
}

/** Daily projected rate from a flat slope, for callers that only need the mean. */
export function meanDailyRate(buckets: readonly HourBucket[]): number {
  if (buckets.length === 0) return 0;
  const total = buckets.reduce((a, b) => a + b.litres, 0);
  return round1((total / buckets.length) * 24);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
