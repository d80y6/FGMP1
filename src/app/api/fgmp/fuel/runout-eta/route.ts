import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";
import { resolvePlatformTimezone } from "@/lib/fgmp/thresholds-time";
import {
  MAX_DRAIN_LPH_ABS,
  MAX_DRAIN_PCT_PER_HOUR,
  MIN_SPAN_H,
  MIN_SEGMENT_POINTS,
  estimateDrainRate,
  pickRateSegment,
  sanitizeLevelSeries,
  type LevelPoint,
  type RateReason,
} from "@/lib/fgmp/metrics-fuel-series";

export const dynamic = "force-dynamic";

/**
 * Fuel Runout ETA predictor (#41-A)
 * ────────────────────────────────────────────────────────────────────────────
 * For each fuel tank, estimate when it will run dry based on the recent
 * consumption rate. Surfaces the most urgent tanks so operators can schedule
 * refills before sites go dark.
 *
 * WHAT CHANGED (correctness pass)
 *
 * 1. The clamp is no longer reported as a measurement.
 *    `etaHours = current / (capacity / 6)` = `6 × (pct / 100)`, so a
 *    90%-full tank was "critical in 5.4 h" and a 20%-full tank "1.2 h" —
 *    every tank read critical because the data producer
 *    (`mini-services/iot-bridge/index.ts`) emits an i.i.d. uniform draw
 *    `200 + Math.random() * 4800` per cycle, not a decrement. When the fitted
 *    rate exceeds the physical ceiling the endpoint now returns
 *    `rateIsClamped: true` with a `null` rate so the caller can render
 *    "insufficient data" instead of a fabricated ETA.
 *
 * 2. Physically impossible step changes are rejected as outliers
 *    (`sanitizeLevelSeries`) and level INCREASES are treated as refills
 *    (segment boundaries), so a delivery inside the window cannot bias the
 *    slope.
 *
 * 3. A tank is never silently dropped. When the persisted series spans less
 *    than MIN_SPAN_H the engine's in-memory history is used as a fallback; if
 *    that also fails the tank is returned in `insufficientData` with a
 *    machine-readable `reason` — it is no longer `continue`d out of the
 *    response.
 *
 * 4. The `SensorReading` scan is bounded by time AND by `take` (the old query
 *    had a 24 h `ts` lower bound but no upper bound on rows).
 *
 * Response shape:
 *   tanks[]           — at-risk tanks with a TRUSTWORTHY measured rate
 *                       (`ratePerHour` is always a number here).
 *   insufficientData[] — tanks we refused to put an ETA on, each with a reason.
 *   meta              — scan/coverage counters, timezone, and the thresholds
 *                       actually used, so a caller can reproduce the numbers.
 *
 * Urgency buckets (unchanged):
 *   critical : ETA < 12h
 *   urgent   : ETA < 24h
 *   soon     : ETA < 72h
 *   ok       : ETA >= 72h (not returned in `tanks`)
 */

const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const FULL_THRESHOLD_PCT = 95; // tanks >95% full are considered "won't run out soon"
const CRITICAL_ETA_H = 12;
const URGENT_ETA_H = 24;
const SOON_ETA_H = 72;
const MAX_TANKS = 20;

/**
 * Hard row cap for the FUEL_LEVEL scan. At the configured 5 s polling interval
 * a single tank produces 17 280 readings/day, so without a `take` this query
 * is a full-table scan of an unbounded table. The newest rows win; `meta
 * .readingsTruncated` tells the caller when the cap bound.
 */
const MAX_DB_READINGS = 20_000;

/** Physical drain ceiling for a tank: it cannot empty faster than 6 h. */
const MAX_RATE_BASIS_HOURS = 6;

type Urgency = "critical" | "urgent" | "soon" | "ok";

interface RunoutTank {
  tankId: string;
  label: string;
  siteId: string;
  siteName: string;
  region: string;
  currentLitres: number;
  capacityLitres: number;
  pct: number;
  /** Litres/hour. Always a measured number in this array. */
  ratePerHour: number;
  etaHours: number | null;
  etaIso: string | null;
  urgency: Urgency;
  /** Samples in the segment the rate was fitted on. */
  sampleCount: number;
  /** Elapsed span of that segment, hours. */
  spanHours: number;
  /** Which series produced the rate. */
  source: SeriesSource;
}

interface InsufficientTank {
  tankId: string;
  label: string;
  siteId: string;
  siteName: string;
  region: string;
  currentLitres: number;
  capacityLitres: number;
  pct: number | null;
  /** Always null — we have no defensible rate. */
  ratePerHour: null;
  /** True when the physical ceiling bound and we refused to report it. */
  rateIsClamped: boolean;
  /** The UNCLAMPED fitted rate, so the caller can see how implausible it was. */
  rawRatePerHour: number | null;
  etaHours: null;
  etaIso: null;
  reason: RateReason;
  sampleCount: number;
  pointsUsed: number;
  outliersRejected: number;
  refillsDetected: number;
  spanHours: number;
  source: SeriesSource;
}

type SeriesSource = "db" | "engine";

function classifyUrgency(etaHours: number | null): Urgency {
  if (etaHours === null) return "ok";
  if (etaHours < CRITICAL_ETA_H) return "critical";
  if (etaHours < URGENT_ETA_H) return "urgent";
  if (etaHours < SOON_ETA_H) return "soon";
  return "ok";
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const timezone = await resolvePlatformTimezone();

    // ── Tenant isolation (Task TI-2c) ────────────────────────────────────
    // SUPERADMIN sees every tank cross-tenant; everyone else only sees
    // tanks whose parent site belongs to their own tenant.
    const tanks = isSuperAdminUser(me)
      ? engine.tanks
      : engine.tanks.filter((t) => {
          const site = engine.sites.find((s) => s.id === t.siteId);
          return site?.tenantId === me.tenantId;
        });
    if (tanks.length === 0) {
      const res = NextResponse.json({
        tanks: [],
        insufficientData: [],
        meta: { timezone, tanksEvaluated: 0, tanksAtRisk: 0, tanksInsufficientData: 0 },
      });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── Load persisted FUEL_LEVEL readings from the last 24h in ONE query ──
    // Grouped by entityId client-side to avoid N+1 per-tank queries.
    // Tenant-scoped: only readings for sites owned by the caller's tenant.
    // (SensorReading has a bare siteId column — no site relation — so we
    // filter by siteId IN tenantSites instead of `site: { tenantId }`.)
    // SUPERADMIN bypasses (null set → no IN filter → all sites).
    // `take` bounds the row count; newest rows are the ones worth keeping.
    const cutoff = new Date(Date.now() - HISTORY_WINDOW_MS);
    const tenantSiteIds = isSuperAdminUser(me)
      ? null
      : engine.sites
          .filter((s) => s.tenantId === me.tenantId)
          .map((s) => s.id);
    const readings = await db.sensorReading.findMany({
      where: {
        metric: "FUEL_LEVEL",
        entityKind: "TANK",
        ts: { gte: cutoff },
        ...(tenantSiteIds ? { siteId: { in: tenantSiteIds } } : {}),
      },
      select: { entityId: true, value: true, ts: true },
      orderBy: { ts: "desc" },
      take: MAX_DB_READINGS,
    });

    // Group readings by tank id, then re-sort each group ascending by ts.
    const readingsByTank = new Map<string, LevelPoint[]>();
    for (const r of readings) {
      let arr = readingsByTank.get(r.entityId);
      if (!arr) { arr = []; readingsByTank.set(r.entityId, arr); }
      arr.push({ t: r.ts.getTime(), l: r.value });
    }
    for (const arr of readingsByTank.values()) arr.sort((a, b) => a.t - b.t);

    // Site lookup for name + region (in-memory, fast).
    const siteOf = (id: string) => engine.sites.find((s) => s.id === id);

    const now = Date.now();
    const windowStart = now - HISTORY_WINDOW_MS;
    const out: RunoutTank[] = [];
    const insufficient: InsufficientTank[] = [];
    let tanksSkippedFull = 0;
    let tanksSkippedInvalidCapacity = 0;
    let tanksNotConsuming = 0;

    /**
     * Sanitise a candidate series and estimate its drain rate.
     * Returns the estimate plus the counters needed to explain a null.
     */
    const evaluate = (points: LevelPoint[], capacity: number) => {
      const clean = sanitizeLevelSeries(points, capacity);
      const maxRate = capacity / MAX_RATE_BASIS_HOURS; // physical ceiling
      const segment = pickRateSegment(clean.segments, {
        minSpanH: MIN_SPAN_H,
        minPoints: MIN_SEGMENT_POINTS,
      });
      const estimate = estimateDrainRate(segment, maxRate, {
        minSpanH: MIN_SPAN_H,
        minPoints: MIN_SEGMENT_POINTS,
        context: {
          segments: clean.segments.length,
          outliers: clean.outliers,
          refills: clean.refills,
        },
      });
      return {
        estimate,
        outliers: clean.outliers,
        refills: clean.refills,
        samples: clean.sampleCount,
      };
    };

    for (const tk of tanks) {
      const capacity = tk.capacity;
      if (!Number.isFinite(capacity) || capacity <= 0) {
        // No usable capacity → we cannot express litres, %, or a physical
        // ceiling. Never divide by it.
        tanksSkippedInvalidCapacity++;
        continue;
      }
      const current = tk.current;
      if (!Number.isFinite(current)) {
        tanksSkippedInvalidCapacity++;
        continue;
      }
      const pct = (current / capacity) * 100;

      // Full tanks won't run out soon — skip to keep the payload focused.
      if (pct > FULL_THRESHOLD_PCT) {
        tanksSkippedFull++;
        continue;
      }

      const dbPoints = readingsByTank.get(tk.id) ?? [];
      const enginePoints: LevelPoint[] = tk.history
        .filter((p) => p.t >= windowStart)
        .map((p) => ({ t: p.t, l: p.l }));

      // Primary: persisted readings. Fallback: engine in-memory 24h history
      // whenever the DB series cannot produce a defensible number.
      let source: SeriesSource = "db";
      let evalResult = evaluate(dbPoints, capacity);
      const dataGapReasons: RateReason[] = [
        "too-few-points",
        "all-points-rejected",
        "no-coherent-segment",
        "span-too-short",
        "degenerate-regression",
      ];
      if (
        evalResult.estimate.ratePerHour === null &&
        dataGapReasons.includes(evalResult.estimate.reason ?? "too-few-points") &&
        enginePoints.length >= 2
      ) {
        source = "engine";
        evalResult = evaluate(enginePoints, capacity);
      }

      const { estimate, outliers, refills, samples } = evalResult;
      const site = siteOf(tk.siteId);
      const identity = {
        tankId: tk.id,
        label: tk.label,
        siteId: tk.siteId,
        siteName: site?.name ?? "—",
        region: site?.region ?? "—",
        currentLitres: Math.round(current),
        capacityLitres: Math.round(capacity),
      };

      if (estimate.reason === "not-consuming") {
        // A TRUSTWORTHY "the level is flat or rising over the window" answer —
        // the tank is not draining. `estimateDrainRate` reports this with a
        // null rate (there is no consumption rate to report), but it is NOT a
        // data gap, so it must be checked before the `ratePerHour === null`
        // branch below. Counted in meta, not listed (unchanged behaviour).
        tanksNotConsuming++;
        continue;
      }

      if (estimate.ratePerHour === null) {
        // ── We do not have a defensible rate. Say so, loudly. ────────────
        insufficient.push({
          ...identity,
          pct: Math.round(pct * 10) / 10,
          ratePerHour: null,
          rateIsClamped: estimate.rateIsClamped,
          rawRatePerHour:
            estimate.slopeLph !== null && estimate.slopeLph < 0
              ? Math.round(-estimate.slopeLph * 100) / 100
              : null,
          etaHours: null,
          etaIso: null,
          reason: estimate.reason ?? "too-few-points",
          sampleCount: samples,
          pointsUsed: estimate.pointsUsed,
          outliersRejected: outliers,
          refillsDetected: refills,
          spanHours: Math.round(estimate.spanHours * 1000) / 1000,
          source,
        });
        continue;
      }

      const ratePerHour = estimate.ratePerHour;
      const etaHours = current / ratePerHour;
      const urgency = classifyUrgency(etaHours);
      if (urgency === "ok") continue; // ETA >= 72h → not urgent enough to surface

      out.push({
        ...identity,
        pct: Math.round(pct * 10) / 10,
        ratePerHour: Math.round(ratePerHour * 100) / 100,
        etaHours: Math.round(etaHours * 10) / 10,
        etaIso: new Date(now + etaHours * 3_600_000).toISOString(),
        urgency,
        sampleCount: estimate.pointsUsed,
        spanHours: Math.round(estimate.spanHours * 1000) / 1000,
        source,
      });
    }

    // Sort by etaHours ascending (most urgent first), cap to top 20.
    out.sort((a, b) => (a.etaHours ?? Infinity) - (b.etaHours ?? Infinity));
    const capped = out.slice(0, MAX_TANKS);
    insufficient.sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));
    const cappedInsufficient = insufficient.slice(0, MAX_TANKS);

    const res = NextResponse.json({
      tanks: capped,
      insufficientData: cappedInsufficient,
      meta: {
        timezone,
        windowHours: HISTORY_WINDOW_MS / 3_600_000,
        minSpanHours: MIN_SPAN_H,
        minSegmentPoints: MIN_SEGMENT_POINTS,
        maxDrainLphAbsolute: MAX_DRAIN_LPH_ABS,
        maxDrainPctPerHour: MAX_DRAIN_PCT_PER_HOUR,
        maxRateBasisHours: MAX_RATE_BASIS_HOURS,
        readingsScanned: readings.length,
        readingsTruncated: readings.length >= MAX_DB_READINGS,
        maxDbReadings: MAX_DB_READINGS,
        tanksEvaluated: out.length + insufficient.length + tanksNotConsuming,
        tanksAtRisk: out.length,
        tanksInsufficientData: insufficient.length,
        tanksNotConsuming,
        tanksSkippedFull,
        tanksSkippedInvalidCapacity,
        /** Guard used for outlier rejection, per tank. */
        maxPlausibleDrainLphRule: "max(500 L/h, 30% of capacity per hour)",
      },
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}