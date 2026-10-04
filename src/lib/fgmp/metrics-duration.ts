/**
 * Duration helpers for irregularly-spaced time series.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY A POINT COUNT IS NOT A DURATION
 *
 * The engine mixes two cadences into one `history` array:
 *   - the 288-point 5-minute backfill written by `backfillHistory()`
 *   - live `tick()` points, appended at whatever interval the caller uses
 *     (`pollingIntervalSec`, default 5 s) and capped at 288 entries
 *
 * So `points.length × 5/60` is only the true elapsed time when every point is
 * exactly 5 minutes apart. Measured with live-only history at 60 s spacing:
 * 288 points × 5/60 = 24.0 "hours" reported against 288 × 60 s = 4.8 h of real
 * elapsed time — a 5× overstatement that grows or shrinks with the tick
 * interval.
 *
 * The only correct method is to integrate the ACTUAL Δt between consecutive
 * samples.
 */

export interface TimedPoint {
  /** epoch millis */
  t: number;
}

/** Longest single gap credited as "running". Beyond this we assume the unit
 *  was offline/unreported rather than running, so the gap is clamped. */
export const MAX_CREDITED_GAP_MS = 15 * 60 * 1000;

export interface DurationResult {
  /** Credited hours. */
  hours: number;
  /** Number of intervals credited (length − 1 at most). */
  intervals: number;
  /** Intervals that had to be clamped to MAX_CREDITED_GAP_MS. */
  clampedIntervals: number;
  /** Last instant − first instant over the whole (unclamped) series. */
  wallClockHours: number;
  /** First and last timestamps actually present. */
  fromMs: number | null;
  toMs: number | null;
}

/**
 * Hours for which `isRunning(p)` held, computed as
 * Σ min(pᵢ.t − pᵢ₋₁.t, MAX_CREDITED_GAP_MS) over consecutive pairs where the
 * LATER point is running.
 *
 * Numeric check — 288 live points 60 s apart, all running:
 *   before: 288 × (5/60)                = 24.0 h   (5× too high)
 *   after : 287 × 60 s                  =  4.7833 h
 *   wall clock 288 × 60 s = 4.8 h; the 0.017 h difference is the interval
 *   before the first sample, which by construction cannot be attributed.
 *
 * Points are assumed sorted ascending by `t`; unsorted input is sorted first.
 */
export function hoursWhereRunning<T extends TimedPoint>(
  points: readonly T[],
  isRunning: (p: T) => boolean,
  maxGapMs: number = MAX_CREDITED_GAP_MS,
): DurationResult {
  if (points.length < 2) {
    return {
      hours: 0,
      intervals: 0,
      clampedIntervals: 0,
      wallClockHours: 0,
      fromMs: points[0]?.t ?? null,
      toMs: points[0]?.t ?? null,
    };
  }
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const fromMs = sorted[0]!.t;
  const toMs = sorted[sorted.length - 1]!.t;
  let ms = 0;
  let intervals = 0;
  let clampedIntervals = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const dt = cur.t - prev.t;
    if (dt <= 0) continue; // duplicate timestamp — no interval to credit
    if (!isRunning(cur)) continue;
    const credited = Math.min(dt, maxGapMs);
    if (credited < dt) clampedIntervals++;
    ms += credited;
    intervals++;
  }
  return {
    hours: ms / 3_600_000,
    intervals,
    clampedIntervals,
    wallClockHours: (toMs - fromMs) / 3_600_000,
    fromMs,
    toMs,
  };
}

/**
 * Litres of "running energy" (kWh) integrated over Δt, for the site-efficiency
 * proxy. Same reasoning as `hoursWhereRunning`: the old code multiplied each
 * point's load by a hardcoded 5/60 h.
 */
export function kwhFromPoints(
  points: readonly (TimedPoint & { load: number })[],
  maxGapMs: number = MAX_CREDITED_GAP_MS,
): number {
  if (points.length < 2) return 0;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let kwh = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const dt = cur.t - prev.t;
    if (dt <= 0) continue;
    const load = Number.isFinite(prev.load) ? prev.load : 0;
    if (load <= 0) continue;
    kwh += load * (Math.min(dt, maxGapMs) / 3_600_000);
  }
  return kwh;
}