/**
 * Tank-level time-series sanitation and rate estimation.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE OLD LEAST-SQUARES RATE WAS PURE NOISE
 *
 * The producer of `SensorReading` FUEL_LEVEL rows is
 * `mini-services/iot-bridge/index.ts`:
 *
 *   const base = 200 + Math.random() * 4800;
 *   r.tankLevel = Math.max(0, Math.round(base - 5));
 *
 * i.e. an i.i.d. uniform draw on [195, 5000] litres on EVERY cycle — not a
 * decrement from the previous level. `/api/fgmp/iot/ingest` persists each draw
 * as a reading and sets the engine's live level to it, so the "series" a
 * regression sees is pure noise.
 *
 * `computeRate()` regressed that noise and then clamped the slope with
 * `Math.min(rate, capacity / 6)`. Because `etaHours = current / (capacity / 6)`
 * that makes `etaHours = 6 × (pct / 100)`: a 90%-full tank was reported
 * "critical in 5.4 h" and a 20%-full tank "1.2 h". EVERY tank read critical,
 * regardless of real usage, and the clamp constant was returned to the UI as
 * if it were a measurement.
 *
 * WHAT THIS MODULE DOES INSTEAD
 *
 *  1. Rejects physically impossible step changes (outliers), per sample.
 *  2. Splits the series at level INCREASES (refills) — a refill is a step
 *     change, not a consumption rate, so it must not bias the regression.
 *  3. Regresses only the longest continuous declining segment.
 *  4. Reports "the clamp bound is active" as a FLAG with a null rate instead of
 *     returning the clamp constant as a measurement.
 */

export interface LevelPoint {
  /** epoch millis */
  t: number;
  /** litres */
  l: number;
}

/** Require at least this much elapsed time before trusting a slope. */
export const MIN_SPAN_H = 0.5;

/** A slope fitted on fewer points than this is not a measurement. */
export const MIN_SEGMENT_POINTS = 3;

/**
 * Absolute sanity bound on tank drain rate. A 500 kW diesel genset burns
 * ≈ 0.24 L/kWh ≈ 120 L/h; even a site running three of them plus a large
 * heating load stays well under 500 L/h. Anything above this is a bad reading.
 */
export const MAX_DRAIN_LPH_ABS = 500;

/**
 * Relative sanity bound: no tank empties faster than 30% of its capacity in an
 * hour. This scales the absolute bound down for small tanks and up for large
 * ones.
 *
 * The bound used for a given tank is
 *   `max(MAX_DRAIN_LPH_ABS, capacity × MAX_DRAIN_PCT_PER_HOUR / 100)`
 * — i.e. the LOOSER of the two. That keeps genuine telemetry (whose step-to-step
 * noise scales with tank size) while still rejecting the iot-bridge's flat
 * ±4 805 L draws, which violate even the 10 000 L bound by ~96×.
 */
export const MAX_DRAIN_PCT_PER_HOUR = 30;

/**
 * A level INCREASE is only treated as a refill when it is materially larger
 * than sensor jitter; otherwise a noisy-but-declining series gets chopped into
 * hundreds of one-sample segments and the regression is meaningless.
 *
 *   threshold = max(REFILL_MIN_STEP_L_ABS, capacity × REFILL_MIN_STEP_PCT / 100)
 */
export const REFILL_MIN_STEP_L_ABS = 20;
export const REFILL_MIN_STEP_PCT = 0.5;

/** Smallest level increase (L) that counts as a refill / segment boundary. */
export function minRefillStepL(capacity: number): number {
  const cap = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  return Math.max(REFILL_MIN_STEP_L_ABS, (cap * REFILL_MIN_STEP_PCT) / 100);
}

/** Maximum drain rate considered physically possible for this tank (L/h). */
export function maxPlausibleDrainLph(capacity: number): number {
  const cap = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  return Math.max(MAX_DRAIN_LPH_ABS, (cap * MAX_DRAIN_PCT_PER_HOUR) / 100);
}

export interface DeliveryEvent {
  /** When the fuel physically landed (FuelDelivery.deliveredAt), epoch millis. */
  t: number;
  volumeLitres: number;
}

export interface AdjustedSeries {
  /** `l(t) − cumulativeCreditedDeliveries(t)` — a continuous level series. */
  adjusted: LevelPoint[];
  /** Total litres actually subtracted. */
  creditedLitres: number;
  /** Litres NOT subtracted because the tank was already near capacity. */
  cappedLitres: number;
  /** Number of deliveries that landed inside the series window. */
  applied: number;
}

/**
 * Remove deliveries from a tank level series so the regression measures
 * consumption only.
 *
 * The old forecast classified ANY non-negative regression slope as
 * "refilling" and forced `consumptionRateLh = 0`. That made a mid-window truck
 * delivery wipe out the whole day's consumption signal — and then
 * `hoursToLow = Infinity` pushed the tank to risk LOW for every other tank in
 * the fleet, which is exactly backwards: the tank just received fuel.
 *
 * `adjusted(t) = l(t) − Σ credited deliveries with deliveredAt ≤ t`
 *
 * Each delivery is credited at most the tank's actual headroom at that moment,
 * because the engine applies
 * `current = min(capacity, current + volumeOrderedLitres)` (engine.ts
 * `applyDueDeliveries`) — a 3 000 L delivery into a tank with 400 L of space
 * only raises the level by 400 L. Crediting the full 3 000 L would subtract
 * 2 600 L that never appeared and fabricate a phantom drain.
 *
 * Numeric check (10 000 L tank, 5-min cadence, 166.67 L/h for 12 h then a
 * 2 000 L delivery at t=12 h then 25 L/h for 12 h):
 *   raw levels      4 000 → 2 000 → (refill) 4 000 → 3 700
 *   credited        0 until t=12 h, then 2 000 (headroom 8 000 ≥ 2 000)
 *   adjusted        4 000 → 2 000 → 2 000 → 1 700     ← continuous
 *   slope of adjusted = −1 300 L / 24 h = 54.17 L/h
 *   WITHOUT the correction the raw least-squares slope is +28.73 L/h (RISING),
 *   so the old code said "refilling", rate 0, hoursToLow ∞, risk LOW.
 */
export function adjustLevelSeriesForDeliveries(
  points: readonly LevelPoint[],
  deliveries: readonly DeliveryEvent[],
  capacity: number,
): AdjustedSeries {
  const sorted = points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.l))
    .sort((a, b) => a.t - b.t);
  if (sorted.length === 0) {
    return { adjusted: [], creditedLitres: 0, cappedLitres: 0, applied: 0 };
  }
  const usable = deliveries
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.volumeLitres) && d.volumeLitres > 0)
    .sort((a, b) => a.t - b.t);
  if (usable.length === 0) {
    return { adjusted: sorted.map((p) => ({ t: p.t, l: p.l })), creditedLitres: 0, cappedLitres: 0, applied: 0 };
  }

  const adjusted: LevelPoint[] = [];
  let credited = 0;
  let capped = 0;
  let applied = 0;
  let di = 0;
  let prevRaw = sorted[0].l;

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    while (di < usable.length && usable[di].t <= p.t) {
      const d = usable[di];
      di++;
      const headroom =
        Number.isFinite(capacity) && capacity > 0 ? Math.max(0, capacity - prevRaw) : d.volumeLitres;
      const credit = Math.min(d.volumeLitres, headroom);
      capped += d.volumeLitres - credit;
      if (credit > 0) {
        credited += credit;
        applied++;
      }
    }
    adjusted.push({ t: p.t, l: p.l - credited });
    prevRaw = p.l;
  }

  return { adjusted, creditedLitres: credited, cappedLitres: capped, applied };
}

export interface SanitizedSeries {
  /** Longest continuous segment (by elapsed span) — the one worth regressing. */
  segment: LevelPoint[];
  /** Every segment found, longest first. */
  segments: LevelPoint[][];
  /** Samples rejected as physically impossible. */
  outliers: number;
  /** Level INCREASES treated as refills (segment boundaries). */
  refills: number;
  /** Total samples considered. */
  sampleCount: number;
  /** Elapsed span of the chosen segment, hours (0 when unknown). */
  segmentSpanH: number;
}

/**
 * Drop implausible samples and split at refills.
 *
 * Rejection rules, applied sample-by-sample against the immediately preceding
 * SAMPLE (not against the last accepted point — comparing against the anchor
 * would let a 4 805 L draw be "justified" by the 24 h gap since the last good
 * point):
 *
 *   • Δt ≤ 0                 → duplicate timestamp, dropped (no interval).
 *   • downward step implying  > maxPlausibleDrainLph(capacity)
 *                            → outlier. Fuel cannot vanish.
 *   • upward step ≥ minRefillStepL(capacity)
 *                            → refill boundary: a new segment starts here.
 *                              (A delivery can legitimately add a full tank in
 *                              one cycle — engine.applyDueDeliveries does
 *                              `min(capacity, current + volumeOrderedLitres)` —
 *                              so an increase is data, not noise.)
 *   • upward step < minRefillStepL(capacity)
 *                            → sensor jitter; kept in the current segment.
 *
 * Numeric check (10 000 L tank, iot-bridge noise 60 s apart):
 *   bound     = max(500, 10 000 × 0.30) = 3 000 L/h → 50 L allowed per 60 s
 *   observed  = 4 805 L in 60 s          = 288 050 L/h → 96× the bound → REJECTED
 *
 * Numeric check (10 000 L tank, engine 5-min backfill, per-sample noise ±100 L):
 *   bound     = 3 000 L/h → 250 L allowed per 300 s
 *   observed  = ≤ 200 L in 300 s         = 2 400 L/h → within bound → KEPT
 *   refill threshold = max(20, 50) = 50 L; per-sample noise moves are ≤ 200 L,
 *   so a rising backfill sample DOES split — which is correct, because the
 *   backfill itself drifts upward.
 *
 * Numeric check (genuine refill, 10 000 L tank, 2 000 L delivered at t):
 *   t-300s: 4 000 L      t: 6 000 L (+2 000 ≥ 50) → refill boundary
 *   segments: [4 000] and [6 000 … later points]; the later segment is
 *   regressed, so the refill does not masquerade as negative consumption.
 */
export function sanitizeLevelSeries(
  points: readonly LevelPoint[],
  capacity: number,
): SanitizedSeries {
  const bound = maxPlausibleDrainLph(capacity);
  const refillStep = minRefillStepL(capacity);
  const sampleCount = points.length;
  const outliers = { n: 0 };
  const refills = { n: 0 };

  const sorted = points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.l))
    .sort((a, b) => a.t - b.t);

  const segments: LevelPoint[][] = [];
  let current: LevelPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (i === 0) {
      current = [p];
      continue;
    }
    const prev = sorted[i - 1];
    const dtH = (p.t - prev.t) / 3_600_000;
    if (dtH <= 0) {
      outliers.n++; // duplicate timestamp
      continue;
    }
    const delta = p.l - prev.l;
    if (delta < 0) {
      const drainLph = -delta / dtH;
      if (drainLph > bound) {
        outliers.n++;
        continue; // implausible drain — keep prev as the anchor for the next test
      }
    } else if (delta >= refillStep) {
      refills.n++;
      segments.push(current);
      current = [p];
      continue;
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);

  const byLength = [...segments].sort((a, b) => {
    const sa = a.length > 1 ? a[a.length - 1].t - a[0].t : -1;
    const sb = b.length > 1 ? b[b.length - 1].t - b[0].t : -1;
    return sb - sa;
  });
  const segment = byLength[0] ?? [];

  return {
    segment,
    segments: byLength,
    outliers: outliers.n,
    refills: refills.n,
    sampleCount,
    segmentSpanH:
      segment.length > 1 ? (segment[segment.length - 1].t - segment[0].t) / 3_600_000 : 0,
  };
}

/**
 * Sum the plausible DECREASES in a level series (litres).
 *
 * Increases are never consumption (they are refills or jitter). Decreases are
 * only counted when they imply a drain rate the tank could physically achieve —
 * otherwise a single bad sample inflates the total. This replaces the
 * `first − last` telescoping used in the analytics buckets, which on
 * i.i.d.-noise input returns a number that is essentially random:
 * two uniform[195, 5000] samples 1 h apart give `first − last` uniformly
 * distributed on [−4 805, +4 805] L, so `max(0, ·)` averages ~1 200 L per
 * bucket with no relation to how much fuel was burned.
 *
 * Numeric check (10 000 L tank, 5-min samples, true drain 3.33 L/step):
 *   bound = 3 000 L/h → 250 L allowed per 300 s
 *   each −3.33 L step counted, +jitter steps ignored → 288 × 3.33 = 960 L
 *   whereas max(0, first − last) on the same data returns anywhere in
 *   [0, 40] L for a 24-point window, and hundreds of litres on noisy data.
 */
export function sumPlausibleDecreases(
  points: readonly LevelPoint[],
  capacity: number,
): number {
  const bound = maxPlausibleDrainLph(capacity);
  if (points.length < 2) return 0;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const dtH = (cur.t - prev.t) / 3_600_000;
    if (dtH <= 0) continue;
    const delta = prev.l - cur.l;
    if (delta <= 0) continue; // rise or flat — not consumption
    if (delta / dtH > bound) continue; // implausible jump — outlier
    total += delta;
  }
  return total;
}

/**
 * Choose which segment's rate should be used.
 *
 * Preference order:
 *   1. the segment that ENDS LATEST among those long enough to be trustworthy
 *      — the ETA is computed from the CURRENT level, so the rate that predicts
 *      it must come from the segment that reaches closest to "now". A segment
 *      that ended at a delivery 12 h ago describes a level the tank no longer
 *      has.
 *   2. otherwise the LONGEST segment, so `estimateDrainRate` can report the
 *      real reason (span-too-short / too-few-points) instead of silently
 *      picking a shorter but newer one.
 *
 * Numeric check (10 000 L tank, refill of 2 000 L exactly at the 12 h mark,
 * 5-min cadence): both segments span 12.000 h. Preferring "longest" picks the
 * PRE-refill segment and reports 166.67 L/h — the rate that was true before the
 * delivery, applied to a post-delivery level. Preferring "latest" picks the
 * post-refill segment and reports 25.00 L/h, which is the rate that actually
 * predicts the current level.
 */
export function pickRateSegment(
  segments: readonly LevelPoint[][],
  opts: { minSpanH?: number; minPoints?: number } = {},
): LevelPoint[] {
  if (segments.length === 0) return [];
  const minSpanH = opts.minSpanH ?? MIN_SPAN_H;
  const minPoints = opts.minPoints ?? MIN_SEGMENT_POINTS;
  const spanOf = (s: readonly LevelPoint[]) =>
    s.length > 1 ? (s[s.length - 1].t - s[0].t) / 3_600_000 : 0;
  const endOf = (s: readonly LevelPoint[]) => (s.length ? s[s.length - 1].t : 0);

  const trustworthy = segments.filter((s) => s.length >= minPoints && spanOf(s) >= minSpanH);
  if (trustworthy.length > 0) {
    return [...trustworthy].sort((a, b) => endOf(b) - endOf(a))[0];
  }
  return [...segments].sort((a, b) => spanOf(b) - spanOf(a))[0];
}

export interface RateEstimate {
  /** Positive L/h, or null when no trustworthy rate could be produced. */
  ratePerHour: number | null;
  /** Signed litres/hour from the regression (negative = draining). */
  slopeLph: number | null;
  /** True when the fitted rate exceeded `maxRateLph` — see `rateIsClamped`. */
  rateIsClamped: boolean;
  /** The bound that bound. */
  maxRateLph: number;
  /** Elapsed span of the segment used, hours. */
  spanHours: number;
  pointsUsed: number;
  /** Machine-readable null reason when `ratePerHour` is null. */
  reason: RateReason | null;
  /** True when the level fell (vs. rose / was flat) over the segment. */
  consuming: boolean;
}

export type RateReason =
  | "too-few-points"
  | "all-points-rejected"
  | "no-coherent-segment"
  | "span-too-short"
  | "not-consuming"
  | "rate-exceeds-physical-max"
  | "degenerate-regression";

export interface RateContext {
  /** Number of contiguous segments the sanitiser produced. */
  segments?: number;
  /** Samples rejected as implausible. */
  outliers?: number;
  /** Refill boundaries detected. */
  refills?: number;
}

/**
 * Least-squares slope of litres vs hours over an already-sanitised segment,
 * with the clamp reported as a flag rather than silently substituted.
 *
 * `maxRateLph` is the physical ceiling (`capacity / 6`: a telecom diesel tank
 * cannot realistically drain in under 6 h even at peak load). When the fitted
 * rate is ABOVE that ceiling the old code returned `capacity / 6`, which is
 * what made every tank read "critical". Now the caller gets
 * `rateIsClamped: true` and `ratePerHour: null` so it can render
 * "insufficient data / implausible rate" instead of a fabricated ETA.
 *
 * `context` is used only to pick the most specific `reason` — it never changes
 * the maths.
 */
export function estimateDrainRate(
  segment: readonly LevelPoint[],
  maxRateLph: number,
  opts: { minSpanH?: number; minPoints?: number; context?: RateContext } = {},
): RateEstimate {
  const minSpanH = opts.minSpanH ?? MIN_SPAN_H;
  const minPoints = opts.minPoints ?? MIN_SEGMENT_POINTS;
  const ctx = opts.context ?? {};
  const base: RateEstimate = {
    ratePerHour: null,
    slopeLph: null,
    rateIsClamped: false,
    maxRateLph,
    spanHours: 0,
    pointsUsed: segment.length,
    reason: null,
    consuming: false,
  };

  if (segment.length < 2) {
    // Nothing survived sanitation → say that, not merely "too few points".
    const rejected = (ctx.outliers ?? 0) + (ctx.refills ?? 0);
    return {
      ...base,
      reason: rejected > 0 ? "all-points-rejected" : "too-few-points",
    };
  }
  const spanH = (segment[segment.length - 1].t - segment[0].t) / 3_600_000;
  if (spanH < minSpanH) {
    // The longest run of plausible samples is shorter than MIN_SPAN_H. If the
    // series was cut up by outliers/refills, that is the real story.
    const fragmented = (ctx.segments ?? 1) > 1 && ((ctx.outliers ?? 0) + (ctx.refills ?? 0)) > 0;
    return {
      ...base,
      spanHours: spanH,
      reason: fragmented ? "no-coherent-segment" : "span-too-short",
    };
  }
  if (segment.length < minPoints) return { ...base, spanHours: spanH, reason: "too-few-points" };

  const n = segment.length;
  const t0 = segment[0].t;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of segment) {
    const x = (p.t - t0) / 3_600_000;
    const y = p.l;
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { ...base, spanHours: spanH, reason: "degenerate-regression" };

  const slope = (n * sumXY - sumX * sumY) / denom; // litres per hour (negative = draining)
  const common = { ...base, slopeLph: slope, spanHours: spanH, pointsUsed: n };

  if (slope >= 0) {
    // Level stable or rising over the segment → not consuming. This is a real
    // answer ("the tank is not draining"), not missing data.
    return { ...common, reason: "not-consuming", consuming: false };
  }
  const raw = -slope;
  if (raw > maxRateLph) {
    // Clamp is BINDING. Say so; do not pass the constant off as a measurement.
    return { ...common, rateIsClamped: true, reason: "rate-exceeds-physical-max", consuming: true };
  }
  return { ...common, ratePerHour: raw, reason: null, consuming: true };
}