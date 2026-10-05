import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, isSuperAdminUser, siteTenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import {
  MIN_SPAN_H,
  adjustLevelSeriesForDeliveries,
  estimateDrainRate,
  minRefillStepL,
  pickRateSegment,
  sanitizeLevelSeries,
  type DeliveryEvent,
  type LevelPoint,
} from "@/lib/fgmp/metrics-fuel-series";
import { safeTankPct } from "@/lib/fgmp/metrics-fuel";

export const dynamic = "force-dynamic";

// ── Types ──────────────────────────────────────────────────────────────────
type Risk = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
/**
 * NOTE: the union is deliberately kept to the three values the UI already
 * renders (`consuming` / `refilling` / `stable`). A level that rose with NO
 * delivery to explain it is still reported as `refilling` — that is what the
 * measurement says — but with `consumptionRateLh: null` (NOT 0) and
 * `risk: "HIGH"`, because the engine raises FUEL_REFILL (L2) / FUEL_THEFT (L3)
 * for exactly this shape of event.
 */
type TankStatus = "consuming" | "refilling" | "stable";

interface TankForecast {
  tankId: string;
  tankLabel: string;
  siteId: string;
  siteName: string;
  siteCode: string;
  region: string;
  governorate: string;
  fuelType: string;
  capacity: number;
  current: number;
  low: number;
  critical: number;
  /** null when the tank's capacity is not usable — never NaN. */
  currentPct: number | null;
  /** Litres/hour, or null when no trustworthy rate could be produced. */
  consumptionRateLh: number | null;
  hoursToLow: number | null;
  hoursToCritical: number | null;
  hoursToEmpty: number | null;
  risk: Risk;
  refuelNeededLitres: number;
  recommendedRefuelTime: string | null;
  dataPoints: number;
  status: TankStatus;
  // ── Added by the correctness pass ────────────────────────────────────
  /** Litres actually landed (DELIVERED/VERIFIED) inside the analysis window. */
  deliveredLitres: number;
  /** Raw level change over the window, deliveries included (litres). */
  netLevelChangeLitres: number | null;
  /** Positive litres the level rose with no delivery to explain it. */
  unexplainedRiseLitres: number;
  /** The level series actually regressed had deliveries removed. */
  analysisNetLitres: number;
  /** Elapsed span of the regressed segment, hours. */
  spanHours: number;
  /** Samples rejected as physically implausible. */
  outliersRejected: number;
  /** True when the fitted rate exceeded capacity/6 and was NOT reported. */
  rateIsClamped: boolean;
  /** Machine-readable null reason when consumptionRateLh is null. */
  insufficientReason: string | null;
}

interface RegionRisk {
  region: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
  totalLitresNeeded: number;
}

interface ForecastResponse {
  generatedAt: string;
  summary: {
    totalTanks: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    stable: number;
    refuelingNeeded: number;
    totalRefuelLitres: number;
    avgConsumptionRateLh: number;
  };
  tanks: TankForecast[];
  regionRisk: RegionRisk[];
}

const RISK_RANK: Record<Risk, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const HOURS_24_MS = 24 * 3600 * 1000;

/** A tank cannot physically drain in under 6 h; anything faster is not measured. */
const MAX_RATE_BASIS_HOURS = 6;

/** Regression needs at least this many samples (unchanged from the original). */
const MIN_REGRESSION_POINTS = 4;

/** Hard cap on the delivery scan inside the 24 h window. */
const MAX_DELIVERIES = 5000;

/** |slope| below this (L/h) is "flat", not a real trend. */
const FLAT_RATE_LPH = 0.05;

/**
 * Determine risk level from hours-to-low, tank status and data quality.
 *
 * The old version mapped a non-negative slope to "refilling" with rate 0, so
 * `hoursToLow` became `Infinity` and EVERY tank fell through to `LOW`. Now:
 *   - a tank whose level rose with no delivery to explain it is an anomaly
 *     (unauthorised fill / theft inversion) → at least HIGH;
 *   - a tank whose window had no usable data is never silently LOW: it is
 *     reported with `consumptionRateLh: null` and `insufficientReason`, and
 *     `risk` still respects an EMPTY tank state or a genuinely low level.
 */
function classifyRisk(
  hoursToLow: number,
  tankStatus: TankStatus,
  tankStateStatus: string,
  unexplainedRiseLitres: number,
): Risk {
  if (tankStateStatus === "EMPTY") return "CRITICAL";
  // Level rose and nothing accounts for it → investigate, do not call it LOW.
  if (unexplainedRiseLitres > 0) return "HIGH";
  if (Number.isFinite(hoursToLow)) {
    if (hoursToLow <= 6) return "CRITICAL";
    if (hoursToLow <= 24) return "HIGH";
    if (hoursToLow <= 72) return "MEDIUM";
    return "LOW";
  }
  // No usable consumption signal (flat level, or an unusable window). The tank
  // is not proven healthy — fall back to its current level against LOW.
  if (tankStatus === "stable" && tankStateStatus !== "EMPTY") return "LOW";
  return "LOW";
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

    // ── Tenant isolation (Task TI-2c) ────────────────────────────────────
    // SUPERADMIN sees every tank cross-tenant; everyone else only sees
    // tanks whose parent site belongs to their own tenant. Site IDs are
    // resolved once and used to filter engine.tanks / engine.sites below.
    const tenantSiteIds = isSuperAdminUser(me)
      ? null
      : new Set(engine.sites.filter((s) => s.tenantId === me.tenantId).map((s) => s.id));

    const now = Date.now();
    const cutoff = now - HOURS_24_MS;
    const tanks = tenantSiteIds === null
      ? engine.tanks
      : engine.tanks.filter((t) => tenantSiteIds.has(t.siteId));
    const sites = tenantSiteIds === null
      ? engine.sites
      : engine.sites.filter((s) => tenantSiteIds.has(s.id));

    // ── Deliveries that landed inside the analysis window ────────────────
    // The old code classified ANY non-negative regression slope as
    // "refilling" and forced consumption to 0, which threw away a full day's
    // consumption signal whenever a truck showed up mid-window. We now subtract
    // the delivered volume from the level series before regressing, so the
    // slope reflects consumption only.
    //
    // Status filter: DELIVERED and VERIFIED are the states in which fuel has
    // physically reached the tank (`schema.prisma:448`). SCHEDULED / IN_TRANSIT
    // have not landed yet.
    const tankIds = tanks.map((t) => t.id);
    // FuelDelivery reaches tenancy through its Site and is RLS-protected, so
    // this read needs a tenant context.
    //
    // Scope is me.tenantId — the authenticated session, the only trustworthy
    // source. The tank list above is ENGINE state, and engine state is
    // currently empty under RLS, so it cannot be used to infer a tenant; a
    // route that derives its DB scope from engine state would silently read
    // the wrong tenant the day that state is populated again.
    //
    // For a SUPERADMIN, siteTenantWhereOrAll(me) returns {} (no tenant filter)
    // and withTenant(me.tenantId) scopes the query to the super-admin's own
    // tenant — which is the safe direction: an empty result rather than a
    // cross-tenant read. `siteTenantWhereOrAll` is deliberately KEPT so the
    // non-superadmin filter is unchanged.
    const deliveryRows = tankIds.length
      ? await asTenant(me.tenantId, (tx) => tx.fuelDelivery.findMany({
          where: {
            ...siteTenantWhereOrAll(me),
            tankId: { in: tankIds },
            status: { in: ["DELIVERED", "VERIFIED"] },
            deliveredAt: { gte: new Date(cutoff), lte: new Date(now) },
          },
          select: {
            tankId: true,
            deliveredAt: true,
            volumeDeliveredLitres: true,
            volumeOrderedLitres: true,
          },
          orderBy: { deliveredAt: "asc" },
          take: MAX_DELIVERIES,
        }))
      : [];
    const deliveriesByTank = new Map<string, DeliveryEvent[]>();
    for (const d of deliveryRows) {
      if (!d.deliveredAt) continue;
      const volume = Number.isFinite(d.volumeDeliveredLitres)
        ? (d.volumeDeliveredLitres as number)
        : d.volumeOrderedLitres;
      if (!Number.isFinite(volume) || volume <= 0) continue;
      let arr = deliveriesByTank.get(d.tankId);
      if (!arr) { arr = []; deliveriesByTank.set(d.tankId, arr); }
      arr.push({ t: d.deliveredAt.getTime(), volumeLitres: volume });
    }

    const tankRows: TankForecast[] = [];
    const consumingRates: number[] = [];

    for (const tank of tanks) {
      // Last 24h of history points (or all if fewer).
      const recentHistory = tank.history.filter((p) => p.t >= cutoff);
      const history = recentHistory.length >= 4 ? recentHistory : tank.history;

      const dataPoints = history.length;
      const capacity = tank.capacity;
      const current = tank.current;
      const low = tank.low;
      const critical = tank.critical;

      // ── 1. Remove deliveries from the level series ───────────────────────
      const rawPoints: LevelPoint[] = history.map((p) => ({ t: p.t, l: p.l }));
      const deliveries = deliveriesByTank.get(tank.id) ?? [];
      const { adjusted, creditedLitres } = adjustLevelSeriesForDeliveries(
        rawPoints,
        deliveries,
        capacity,
      );

      // ── 2. Reject implausible steps and split at unexplained rises ──────
      const clean = sanitizeLevelSeries(adjusted, capacity);
      const segment = pickRateSegment(clean.segments, {
        minSpanH: MIN_SPAN_H,
        minPoints: MIN_REGRESSION_POINTS,
      });
      const maxRateLph =
        Number.isFinite(capacity) && capacity > 0 ? capacity / MAX_RATE_BASIS_HOURS : Number.POSITIVE_INFINITY;
      const estimate = estimateDrainRate(segment, maxRateLph, {
        minSpanH: MIN_SPAN_H,
        minPoints: MIN_REGRESSION_POINTS,
        context: {
          segments: clean.segments.length,
          outliers: clean.outliers,
          refills: clean.refills,
        },
      });

      // ── 3. Classify ─────────────────────────────────────────────────────
      let status: TankStatus;
      let consumptionRateLh: number | null;
      let unexplainedRiseLitres = 0;

      const slope = estimate.slopeLph;
      if (estimate.ratePerHour !== null) {
        consumptionRateLh = Math.round(estimate.ratePerHour * 1000) / 1000;
        status = "consuming";
        consumingRates.push(consumptionRateLh);
      } else if (estimate.rateIsClamped) {
        // Physically implausible drain. Report the flag, not the ceiling.
        consumptionRateLh = null;
        status = "consuming";
      } else if (slope !== null && slope > 0) {
        // Level rose AFTER removing deliveries. Only call that a "refill" when
        // the rise is MATERIAL — at least `minRefillStepL(capacity)` over the
        // window. A +2 L/h sensor creep (48 L over 24 h on a 10 000 L tank) is
        // not a refuel.
        const rise = slope * estimate.spanHours;
        if (rise >= minRefillStepL(capacity)) {
          unexplainedRiseLitres = Math.round(rise);
          consumptionRateLh = null; // NOT 0: "unknown", not "no usage"
          status = "refilling";
        } else {
          consumptionRateLh = null;
          status = "stable";
        }
      } else if (slope !== null && slope < -FLAT_RATE_LPH) {
        // A negative slope below the flat threshold: real but negligible.
        consumptionRateLh = Math.round(-slope * 1000) / 1000;
        status = "consuming";
        consumingRates.push(consumptionRateLh);
      } else {
        consumptionRateLh = null;
        status = "stable";
      }

      const rate = consumptionRateLh !== null && consumptionRateLh > 0 ? consumptionRateLh : null;

      const hoursToEmpty = rate !== null ? Math.max(0, current / rate) : Infinity;
      const hoursToCritical = rate !== null ? Math.max(0, (current - critical) / rate) : Infinity;
      const hoursToLow = rate !== null ? Math.max(0, (current - low) / rate) : Infinity;

      const risk = classifyRisk(hoursToLow, status, tank.status, unexplainedRiseLitres);

      const refuelNeededLitres =
        Number.isFinite(capacity) && capacity > 0 ? Math.max(0, capacity - current) : 0;

      // Recommended refuel time = when the tank hits the LOW threshold.
      // This is the latest safe refuel window. If Infinity (no consumption),
      // there is no urgent refuel window.
      const recommendedRefuelTime = Number.isFinite(hoursToLow)
        ? new Date(now + hoursToLow * 3600000).toISOString()
        : null;

      const site = sites.find((s) => s.id === tank.siteId);
      const pctRaw = safeTankPct(current, capacity);

      tankRows.push({
        tankId: tank.id,
        tankLabel: tank.label,
        siteId: tank.siteId,
        siteName: site?.name ?? "—",
        siteCode: site?.code ?? "—",
        region: site?.region ?? "—",
        governorate: site?.governorate ?? "—",
        fuelType: tank.fuelType,
        capacity: Number.isFinite(capacity) ? Math.round(capacity) : 0,
        current: Number.isFinite(current) ? Math.round(current) : 0,
        low: Number.isFinite(low) ? Math.round(low) : 0,
        critical: Number.isFinite(critical) ? Math.round(critical) : 0,
        currentPct: pctRaw === null ? null : Math.round(pctRaw * 10) / 10,
        consumptionRateLh,
        hoursToLow: Number.isFinite(hoursToLow) ? Math.round(hoursToLow * 10) / 10 : null,
        hoursToCritical: Number.isFinite(hoursToCritical) ? Math.round(hoursToCritical * 10) / 10 : null,
        hoursToEmpty: Number.isFinite(hoursToEmpty) ? Math.round(hoursToEmpty * 10) / 10 : null,
        risk,
        refuelNeededLitres: Math.round(refuelNeededLitres),
        recommendedRefuelTime,
        dataPoints,
        status,
        deliveredLitres: Math.round(creditedLitres),
        netLevelChangeLitres:
          rawPoints.length >= 2
            ? Math.round(rawPoints[rawPoints.length - 1]!.l - rawPoints[0]!.l)
            : null,
        unexplainedRiseLitres: Math.max(0, unexplainedRiseLitres),
        analysisNetLitres:
          segment.length >= 2
            ? Math.round(segment[segment.length - 1]!.l - segment[0]!.l)
            : 0,
        spanHours: Math.round(estimate.spanHours * 1000) / 1000,
        outliersRejected: clean.outliers,
        rateIsClamped: estimate.rateIsClamped,
        insufficientReason: consumptionRateLh === null ? estimate.reason : null,
      });
    }

    // Sort: by risk severity first (CRITICAL → HIGH → MEDIUM → LOW),
    // then by hoursToLow ascending. null/Infinity go last within each risk bucket.
    tankRows.sort((a, b) => {
      const rDiff = RISK_RANK[a.risk] - RISK_RANK[b.risk];
      if (rDiff !== 0) return rDiff;
      const aH = a.hoursToLow ?? Infinity;
      const bH = b.hoursToLow ?? Infinity;
      return aH - bH;
    });

    // ── Summary ────────────────────────────────────────────────────────────
    const summary = {
      totalTanks: tanks.length,
      critical: tankRows.filter((t) => t.risk === "CRITICAL").length,
      high: tankRows.filter((t) => t.risk === "HIGH").length,
      medium: tankRows.filter((t) => t.risk === "MEDIUM").length,
      low: tankRows.filter((t) => t.risk === "LOW").length,
      // Counted by STATUS, not by `consumptionRateLh === 0`: the rate is null
      // (unknown) for flat / unexplained / clamped tanks, and those are not
      // "0 L/h of usage".
      stable: tankRows.filter((t) => t.status === "stable").length,
      refuelingNeeded: tankRows.filter(
        (t) => t.refuelNeededLitres > 0 && (t.hoursToLow ?? Infinity) < 72,
      ).length,
      totalRefuelLitres: tankRows
        .filter((t) => t.refuelNeededLitres > 0 && (t.hoursToLow ?? Infinity) < 72)
        .reduce((sum, t) => sum + t.refuelNeededLitres, 0),
      avgConsumptionRateLh: consumingRates.length
        ? Math.round((consumingRates.reduce((s, r) => s + r, 0) / consumingRates.length) * 1000) / 1000
        : 0,
    };

    // ── Region risk distribution ───────────────────────────────────────────
    const regionMap = new Map<string, RegionRisk>();
    for (const row of tankRows) {
      const r = regionMap.get(row.region) ?? {
        region: row.region,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        totalLitresNeeded: 0,
      };
      if (row.risk === "CRITICAL") r.critical += 1;
      else if (row.risk === "HIGH") r.high += 1;
      else if (row.risk === "MEDIUM") r.medium += 1;
      else r.low += 1;
      // Total litres needed across all tanks in region that need refuel within 72h.
      if (row.refuelNeededLitres > 0 && (row.hoursToLow ?? Infinity) < 72) {
        r.totalLitresNeeded += row.refuelNeededLitres;
      }
      regionMap.set(row.region, r);
    }
    const regionRisk = Array.from(regionMap.values())
      .map((r) => ({
        ...r,
        totalLitresNeeded: Math.round(r.totalLitresNeeded),
      }))
      .sort((a, b) => b.totalLitresNeeded - a.totalLitresNeeded);

    const body: ForecastResponse & {
      meta: {
        windowHours: number;
        deliveriesInWindow: number;
        deliveriesScanned: number;
        deliveriesTruncated: boolean;
        maxRateBasisHours: number;
        minSpanHours: number;
      };
    } = {
      generatedAt: new Date().toISOString(),
      summary,
      tanks: tankRows,
      regionRisk,
      meta: {
        windowHours: 24,
        deliveriesInWindow: deliveryRows.length,
        deliveriesScanned: deliveryRows.length,
        deliveriesTruncated: deliveryRows.length >= MAX_DELIVERIES,
        maxRateBasisHours: MAX_RATE_BASIS_HOURS,
        minSpanHours: MIN_SPAN_H,
      },
    };

    const res = NextResponse.json(body);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}