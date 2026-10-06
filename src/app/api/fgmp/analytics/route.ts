import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import type { SessionUser } from "@/lib/auth";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireAuth,
  isSuperAdminUser,
  tenantWhereOrAll,
  siteTenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";
import {
  resolvePlatformTimezone,
  startOfZonedDay,
  startOfZonedHour,
  zonedDateKey,
  zonedHourLabel,
  zonedWeekdayLabel,
} from "@/lib/fgmp/thresholds-time";
import {
  battLowVoltageTripVolts,
  fleetBatteryHealthPct,
  resolveBattLowVoltagePct,
} from "@/lib/fgmp/thresholds-battery";
import { capacityWeightedFuelPct, resolveFuelPrice } from "@/lib/fgmp/metrics-fuel";
import { hoursWhereRunning, kwhFromPoints } from "@/lib/fgmp/metrics-duration";
import { sumPlausibleDecreases, type LevelPoint } from "@/lib/fgmp/metrics-fuel-series";

export const dynamic = "force-dynamic";

// ── Tunables ───────────────────────────────────────────────────────────────

/**
 * Site-health weight vector — the ONLY definition of the composite:
 * `overall = Σ (weight × factor)`. Weights sum to exactly 1.00 and every
 * factor that is rendered is included.
 *
 * Before the correctness pass the formula was
 *   onlinePct×0.30 + fuel×0.25 + gen×0.20 + batt×0.15 − alarmPenalty + 15
 * which (a) subtracted the alarm penalty a second time while ALSO rendering an
 * "Alarm Load" factor card (weight 0.1) that never entered the maths, and
 * (b) added an unexplained `+15`. For a 10-site fleet at 100% uptime, 82.7%
 * fuel, no generator faults and no alarms the displayed cards weighted-sum to
 * 85 while the headline read 89 — the number contradicted its own breakdown.
 */
const HEALTH_WEIGHTS = {
  uptime: 0.30,
  fuel: 0.25,
  generator: 0.20,
  battery: 0.15,
  alarm: 0.10,
} as const;

/** Penalty (points) per open alarm per site in the "Alarm Load" factor. */
const ALARM_PENALTY_PER_SITE = 2;
const ALARM_PENALTY_CAP = 25;

/** Days shown by the `dailyCost` series and the `range=7d` chart. */
const TREND_DAYS = 7;

/** Hours in the fixed derived-metric window (totalConsumed, forecast, …). */
const DERIVED_WINDOW_H = 24;

/**
 * Hard row cap for the 7-day FUEL_LEVEL scan. At a 5 s polling interval the
 * table grows by millions of rows a day, so an unbounded `findMany` is a
 * full-table scan (the only indexes are `(siteId, ts)` and
 * `(entityId, metric, ts)`, neither leading with `metric`). Newest rows win;
 * `meta.dailyCostReadingsTruncated` reports when the cap bound.
 */
const MAX_DAILY_READINGS = 20_000;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

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
    const { searchParams } = new URL(req.url);
    const scope = searchParams.get("scope") ?? "national"; // national | region:<id> | site:<id>
    // Optional time range for the consumption-trend chart. Defaults to 24h so
    // existing callers (analytics-view, fuel-view) are unaffected.
    const range = searchParams.get("range") ?? "24h"; // 1h | 24h | 7d

    // ONE configurable fuel price (metrics-fuel.ts). This route used to
    // hardcode 1.85 USD/L while engine.ts hardcodes 520 YER/L.
    const price = await resolveFuelPrice();
    const battLowPct = await resolveBattLowVoltagePct();
    const timezone = await resolvePlatformTimezone();

    // ── Tenant isolation (Task TI-2c) ────────────────────────────────────
    // SUPERADMIN sees every site cross-tenant. Every other role sees only the
    // sites (and child tanks/generators/batteries/events) owned by their own
    // tenant. We resolve a Set of allowed site IDs once and use it to filter
    // the in-memory engine arrays below.
    const tenantSiteIds = isSuperAdminUser(me)
      ? null
      : new Set(engine.sites.filter((s) => s.tenantId === me.tenantId).map((s) => s.id));

    const sites = tenantSiteIds === null
      ? engine.sites
      : engine.sites.filter((s) => tenantSiteIds.has(s.id));
    const tanks = tenantSiteIds === null
      ? engine.tanks
      : engine.tanks.filter((t) => tenantSiteIds.has(t.siteId));
    const generators = tenantSiteIds === null
      ? engine.generators
      : engine.generators.filter((g) => tenantSiteIds.has(g.siteId));
    const batteries = tenantSiteIds === null
      ? engine.batteries
      : engine.batteries.filter((b) => tenantSiteIds.has(b.siteId));
    const events = tenantSiteIds === null
      ? engine.events
      : engine.events.filter((e) => tenantSiteIds.has(e.siteId));

    const now = Date.now();

    // Fixed trailing 24-hour window, ALIGNED to platform-local hour
    // boundaries. Everything derived below uses this same window so the totals
    // and the chart cannot disagree.
    const windowEnd = startOfZonedHour(now, timezone);
    const windowStart = windowEnd - DERIVED_WINDOW_H * 3600000;

    /** Consumption (litres) in [start, end) for one tank. */
    const tankConsumption = (
      history: readonly { t: number; l: number }[],
      capacity: number,
      start: number,
      end: number,
    ) => {
      const pts: LevelPoint[] = [];
      for (const p of history) if (p.t >= start && p.t < end) pts.push({ t: p.t, l: p.l });
      return pts.length >= 2 ? sumPlausibleDecreases(pts, capacity) : 0;
    };

    /** Consumption (litres) in [start, end) across the tenant's tanks. */
    const fleetConsumption = (start: number, end: number) =>
      tanks.reduce(
        (sum, t) => sum + tankConsumption(t.history, t.capacity, start, end),
        0,
      );

    /**
     * Generator running-hours in [start, end), integrated from the ACTUAL Δt
     * between consecutive history points.
     *
     * The old code did `pts.filter(p => p.rate > 0).length * (5 / 60)`, i.e. it
     * multiplied a point COUNT by a hardcoded sample interval. `history` mixes
     * the 288-point 5-minute backfill with live `tick()` points written at the
     * polling interval (5 s by default), so the figure moved with the tick
     * rate: 288 live points 60 s apart reported 288 × 5/60 = 24.0
     * generator-hours against a true elapsed 288 × 60 s = 4.8 h — 5× too high.
     */
    const runningHoursBetween = (start: number, end: number) => {
      let hours = 0;
      let intervals = 0;
      let clamped = 0;
      let coverage = 0;
      for (const g of generators) {
        const pts = g.history.filter((p) => p.t >= start && p.t < end);
        if (pts.length < 2) continue;
        const r = hoursWhereRunning(pts, (p) => p.rate > 0);
        hours += r.hours;
        intervals += r.intervals;
        clamped += r.clampedIntervals;
        if (r.wallClockHours > coverage) coverage = r.wallClockHours;
      }
      return { hours, intervals, clamped, coverageHours: coverage };
    };

    // ── Consumption trend (trailing 24h, one bucket per platform-local hour)
    const hourBuckets: { t: string; litres: number; running: number }[] = [];
    for (let k = DERIVED_WINDOW_H - 1; k >= 0; k--) {
      const end = windowEnd - k * 3600000;
      const start = end - 3600000;
      hourBuckets.push({
        // Platform-local label. Was `.toISOString().slice(11, 16)`, i.e. UTC,
        // which put the 00:00–03:00 Aden window on the wrong row.
        t: zonedHourLabel(start, timezone),
        litres: Math.round(fleetConsumption(start, end)),
        running: round1(runningHoursBetween(start, end).hours),
      });
    }

    // Range-aware consumption trend for the chart display.
    //   1h  → 12 buckets × 5 min  (label HH:MM, platform-local)
    //   24h → 24 buckets × 1 h    (label HH:MM, platform-local)
    //   7d  → 7 platform-local calendar days (label weekday), sourced from the
    //          persisted SensorReading table because the engine retains only
    //          ~24h of in-memory history (which rendered as 0 for 6 of 7 days).
    const trendBuckets: { t: string; litres: number; running: number }[] = [];
    const dayStarts: number[] = [];
    for (let d = TREND_DAYS - 1; d >= 0; d--) {
      dayStarts.push(startOfZonedDay(now, timezone) - d * 86400000);
    }
    const needsDailyReadings = range === "7d";
    const dailyReadings = needsDailyReadings
      ? await loadFuelLevelReadings({
          user: me,
          tenantSiteIds: tenantSiteIds === null ? null : Array.from(tenantSiteIds),
          startMs: dayStarts[0]!,
        })
      : null;

    if (range === "1h") {
      for (let i = 11; i >= 0; i--) {
        const end = now - i * 5 * 60000;
        const start = end - 5 * 60000;
        trendBuckets.push({
          t: zonedHourLabel(start, timezone),
          litres: Math.round(fleetConsumption(start, end)),
          running: round1(runningHoursBetween(start, end).hours),
        });
      }
    } else if (dailyReadings) {
      const perDay = bucketReadingsByZonedDay(dailyReadings.rows, tanks, timezone);
      for (const dayStart of dayStarts) {
        const bucket = perDay.get(zonedWeekdayLabel(dayStart, timezone) + "|" + dayStart);
        trendBuckets.push({
          t: zonedWeekdayLabel(dayStart, timezone),
          litres: bucket ? Math.round(bucket.litres) : 0,
          // SensorReading carries no generator cadence, so a daily
          // generator-hours figure is not derivable from it. 0 means
          // "not measured from this source", and `meta` says so.
          running: 0,
        });
      }
    } else {
      // 24h (default) — reuse the fixed hourly buckets.
      trendBuckets.push(...hourBuckets);
    }

    // Site efficiency: litres consumed per kWh delivered (proxy), over the same
    // fixed 24h window as the trend.
    const siteEfficiency = sites.map((s) => {
      const siteTanks = tanks.filter((t) => t.siteId === s.id);
      const siteGens = generators.filter((g) => g.siteId === s.id);
      const consumed = siteTanks.reduce(
        (sum, t) => sum + tankConsumption(t.history, t.capacity, windowStart, windowEnd),
        0,
      );
      // kWh integrated over Δt, not `load × (5/60)` per sample.
      const kwh = siteGens.reduce(
        (sum, g) =>
          sum + kwhFromPoints(
            g.history
              .filter((p) => p.t >= windowStart && p.t < windowEnd)
              .map((p) => ({ t: p.t, load: p.load })),
          ),
        0,
      );
      const efficiency = kwh > 0 ? round2(consumed / kwh) : 0;
      // Capacity-WEIGHTED litres, not a mean of ratios (see metrics-fuel.ts).
      const weighted = capacityWeightedFuelPct(siteTanks);
      return {
        siteId: s.id,
        site: s.name,
        code: s.code,
        region: s.region,
        consumed: Math.round(consumed),
        kwh: Math.round(kwh),
        efficiency,
        // 0 when the site has no tank with usable capacity — never NaN.
        fuelPct: weighted.pct === null ? 0 : round1(weighted.pct),
      };
    }).sort((a, b) => b.consumed - a.consumed);

    // Theft / anomaly events (already tenant-filtered above)
    const theftEvents = events.filter((e) => e.kind === "CRITICAL" && /theft/i.test(e.message)).slice(0, 20);
    const refillEvents = events.filter((e) => /refill|increase/i.test(e.message)).slice(0, 20);

    // Forecast: flat projection of the trailing 24 h consumption over 7 days.
    // The previous version multiplied by `(0.9 + Math.random() * 0.2)`, so the
    // "forecast" redrew ±10% differently on every 15 s poll.
    const dailyAvg = Math.round(hourBuckets.reduce((a, b) => a + b.litres, 0));
    const forecast = Array.from({ length: 7 }, (_, i) => ({ day: `D+${i + 1}`, litres: dailyAvg }));

    // Region breakdown
    interface RegionRow {
      region: string;
      sites: number;
      fuel: number;
      fuelCapacity: number;
      consumed: number;
      alarms: number;
      running: number;
    }
    const regionMap = new Map<string, RegionRow>();
    for (const s of sites) {
      const r: RegionRow =
        regionMap.get(s.region) ??
        { region: s.region, sites: 0, fuel: 0, fuelCapacity: 0, consumed: 0, alarms: 0, running: 0 };
      r.sites++;
      for (const t of tanks) {
        if (t.siteId !== s.id) continue;
        if (Number.isFinite(t.current)) r.fuel += t.current;
        if (Number.isFinite(t.capacity) && t.capacity > 0) r.fuelCapacity += t.capacity;
        r.consumed += tankConsumption(t.history, t.capacity, windowStart, windowEnd);
      }
      r.running += generators.filter((g) => g.siteId === s.id && g.status === "RUNNING").length;
      regionMap.set(s.region, r);
    }
    // groupBy / aggregate / count are scoped by the policy exactly as a
    // findMany is — an unscoped aggregate silently returns zero rows rather
    // than erroring, so a revenue or alarm count reads as "no activity".
    const alarmsByRegion = await asTenant(me, (tx) =>
      tx.alarm.groupBy({
        by: ["siteId"],
        where: { ...tenantWhereOrAll(me), status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } },
        _count: true,
      }),
    );
    for (const a of alarmsByRegion) {
      const s = sites.find((x) => x.id === a.siteId);
      if (s) { const r = regionMap.get(s.region); if (r) r.alarms += a._count; }
    }
    const regionBreakdown = Array.from(regionMap.values()).map(({ fuelCapacity, ...rest }) => ({
      ...rest,
      fuel: Math.round(rest.fuel),
      // Capacity-weighted litres-on-hand %, matching the engine KPI.
      fuelPct: fuelCapacity > 0 ? round1((rest.fuel / fuelCapacity) * 100) : null,
      consumed: Math.round(rest.consumed),
    }));

    void scope;

    const totalConsumed = hourBuckets.reduce((s, b) => s + b.litres, 0);

    // ── Generator hours ───────────────────────────────────────────────────
    // The basis is a DELIBERATE choice and is now stated in the payload: the
    // figure is the sum of generator operating hours across the whole fleet.
    // A site with two generators running contributes up to 2 h per wall-clock
    // hour — correct for a maintenance / fuel-budget metric, wrong for an
    // availability metric. `perGenerator` and the stated basis let the caller
    // use whichever it needs.
    const dayStart = startOfZonedDay(now, timezone);
    const genToday = runningHoursBetween(dayStart, now + 1);
    const generatorHours = {
      basis: "fleet-sum-of-generator-hours" as const,
      note:
        "Sum of per-generator operating hours across the fleet, computed as " +
        "Σ min(Δt, 15 min) over consecutive history points whose successor had " +
        "rate > 0. Never derived from a point count. A site with two generators " +
        "running contributes up to 2 h per wall-clock hour.",
      windowStart: new Date(dayStart).toISOString(),
      windowEnd: new Date(now).toISOString(),
      /** Wall-clock hours the retained in-memory history actually covers. */
      coverageHours: round2(genToday.coverageHours),
      fleetTotalHours: round2(genToday.hours),
      intervalsCredited: genToday.intervals,
      intervalsClamped: genToday.clamped,
      perGenerator: generators.map((g) => {
        const r = hoursWhereRunning(g.history, (p) => p.rate > 0);
        return {
          generatorId: g.id,
          siteId: g.siteId,
          label: g.label,
          hours: round2(r.hours),
          intervals: r.intervals,
          clampedIntervals: r.clampedIntervals,
          coverageHours: round2(r.wallClockHours),
        };
      }),
    };

    // Fuel cost analytics (computed from consumption + deliveries)
    const theftLitres = theftEvents.reduce((sum, e) => {
      const m = e.message.match(/theft of (\d+)L/i);
      return sum + (m ? parseInt(m[1], 10) : 0);
    }, 0);
    const totalDelivered = await asTenant(me, (tx) => tx.fuelDelivery.aggregate({
      _sum: { volumeDeliveredLitres: true },
      where: { ...siteTenantWhereOrAll(me), status: "VERIFIED" },
    }),
    );
    const deliveredLitres = Number.isFinite(totalDelivered._sum.volumeDeliveredLitres)
      ? (totalDelivered._sum.volumeDeliveredLitres as number)
      : 0;

    // ── dailyCost: a real 7-bucket series ────────────────────────────────
    // The old code reduced over `hourBuckets` (always 24 entries) testing
    // `i % 24 === 0`, which is true only at i = 0 — so the "last 7 days" chart
    // always contained exactly one bar labelled D-7 with `day1` hardcoded to 0.
    const dailyReadingsForCost =
      dailyReadings ??
      (await loadFuelLevelReadings({
        user: me,
        tenantSiteIds: tenantSiteIds === null ? null : Array.from(tenantSiteIds),
        startMs: dayStarts[0]!,
      }));
    const perDayCost = bucketReadingsByZonedDay(dailyReadingsForCost.rows, tanks, timezone);
    const dailyCost = dayStarts.map((dayStartMs, i) => {
      const bucket = perDayCost.get(zonedWeekdayLabel(dayStartMs, timezone) + "|" + dayStartMs);
      // `litres: null` marks a day with NO readings at all. A fabricated 0 would
      // render as "no fuel burned that day", which is a different statement.
      const litres = bucket ? Math.round(bucket.litres) : null;
      return {
        day: `D-${dayStarts.length - 1 - i}`,
        dateKey: bucket?.dateKey ?? null,
        litres,
        cost: litres === null ? null : round2(litres * price.usdPerLitre),
        samples: bucket?.samples ?? 0,
      };
    });

    const fuelCost = {
      /** Kept numeric: analytics-view.tsx calls `.toFixed(2)` on it. */
      pricePerLitre: price.usdPerLitre,
      currency: "USD" as const,
      /** The same physical quantity the engine's UNIT_PRICE_YER_PER_L states. */
      pricePerLitreYer: price.yerPerLitre,
      fxYerPerUsd: price.fxYerPerUsd,
      priceSource: price.source,
      priceFxSource: price.fxSource,
      consumedTodayUsd: round2(totalConsumed * price.usdPerLitre),
      stolenValueUsd: round2(theftLitres * price.usdPerLitre),
      deliveredValueUsd: round2(deliveredLitres * price.usdPerLitre),
      theftLitres,
      forecastCostUsd: round2(forecast.reduce((s, f) => s + f.litres, 0) * price.usdPerLitre),
      /**
       * Cost by region. `costUsd` values the fuel STOCK ON HAND (which is what
       * this always was); `consumedCostUsd` values what was actually burned in
       * the trailing 24 h window. Both are labelled so neither is misread.
       */
      costByRegion: regionBreakdown.map((r) => ({
        region: r.region,
        costUsd: round2(r.fuel * price.usdPerLitre),
        fuelStockOnHandPct: r.fuelPct,
        consumedLitres: r.consumed,
        consumedCostUsd: round2(r.consumed * price.usdPerLitre),
        sites: r.sites,
      })),
      /** Real 7-bucket series, oldest → newest. */
      dailyCost,
      dailyCostBasis: "litres consumed per platform-local calendar day",
      dailyCostDays: TREND_DAYS,
    };

    // Site health score breakdown (national aggregate factors)
    const onlineCount = sites.filter((s) => s.status === "ONLINE").length;
    const alarmCount = await asTenant(me, (tx) =>
      tx.alarm.count({ where: { ...tenantWhereOrAll(me), status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } } }),
    );
    const onlinePct = sites.length ? (onlineCount / sites.length) * 100 : 100;
    const weightedFuel = capacityWeightedFuelPct(tanks);
    // Capacity-weighted litres — the same statistic as the engine KPI
    // (Σcurrent / Σcapacity) — so analytics and the dashboard KPI agree.
    const fuelHealthPct = weightedFuel.pct ?? 100;
    const genHealthPct = generators.length ? (generators.filter((g) => g.status !== "FAULT").length / generators.length) * 100 : 100;
    // Relative-to-nominal trip point (thresholds-battery.ts): a 48 V bank trips
    // at 0.88 × 48 = 42.24 V, a 24 V bank at 0.88 × 24 = 21.12 V. The old
    // absolute `b.voltage > 46` scored EVERY 24 V bank 0% for the whole fleet.
    const battery = fleetBatteryHealthPct(
      batteries.map((b) => ({ voltage: b.voltage, nominalVoltage: b.nominalVoltage })),
      battLowPct,
    );
    const battHealthPct = battery.healthPct;
    const alarmsPerSite = sites.length ? alarmCount / sites.length : 0;
    const alarmPenalty = Math.min(ALARM_PENALTY_CAP, alarmsPerSite * ALARM_PENALTY_PER_SITE);
    const alarmLoadPct = Math.max(0, 100 - alarmPenalty);

    const factors = [
      { label: "Site Uptime", value: Math.round(onlinePct), weight: HEALTH_WEIGHTS.uptime, icon: "uptime", good: onlinePct > 90 },
      { label: "Fuel Reserves", value: Math.round(fuelHealthPct), weight: HEALTH_WEIGHTS.fuel, icon: "fuel", good: fuelHealthPct > 50 },
      { label: "Generator Health", value: Math.round(genHealthPct), weight: HEALTH_WEIGHTS.generator, icon: "generator", good: genHealthPct > 80 },
      { label: "Battery Health", value: Math.round(battHealthPct), weight: HEALTH_WEIGHTS.battery, icon: "battery", good: battHealthPct > 75 },
      { label: "Alarm Load", value: Math.round(alarmLoadPct), weight: HEALTH_WEIGHTS.alarm, icon: "alarm", good: alarmPenalty < 15 },
    ];
    // Weighted mean of exactly the factors rendered above: no magic offset, and
    // the displayed cards always sum to the headline.
    const weightedSum = factors.reduce((s, f) => s + f.weight * f.value, 0);
    const siteHealth = {
      overall: Math.round(Math.max(0, Math.min(100, weightedSum))),
      weights: HEALTH_WEIGHTS,
      factorWeightSum: Math.round(factors.reduce((s, f) => s + f.weight, 0) * 1000) / 1000,
      factors,
      detail: {
        onlineSites: onlineCount,
        totalSites: sites.length,
        fuelPctCapacityWeighted: weightedFuel.pct === null ? null : round1(weightedFuel.pct),
        fuelLitresOnHand: Math.round(weightedFuel.currentLitres),
        fuelCapacityLitres: Math.round(weightedFuel.capacityLitres),
        tanksScoredForFuel: weightedFuel.scoredTanks,
        tanksUnscoredForFuel: weightedFuel.unscoredTanks,
        batteriesScored: battery.total,
        batteriesUnscored: battery.unscored,
        battLowVoltagePct: battLowPct,
        /** Trip points actually used, so the four threshold sites can be compared. */
        battLowVoltageTripVolts: {
          for24V: battLowVoltageTripVolts(24, battLowPct),
          for48V: battLowVoltageTripVolts(48, battLowPct),
        },
        openAlarms: alarmCount,
        alarmsPerSite: round2(alarmsPerSite),
        alarmPenaltyPoints: round2(alarmPenalty),
      },
    };

    const res = NextResponse.json({
      consumptionTrend: trendBuckets,
      siteEfficiency,
      theftEvents,
      refillEvents,
      forecast,
      regionBreakdown,
      fuelCost,
      siteHealth,
      generatorHours,
      meta: {
        timezone,
        derivedWindowStart: new Date(windowStart).toISOString(),
        derivedWindowEnd: new Date(windowEnd).toISOString(),
        derivedWindowHours: DERIVED_WINDOW_H,
        consumptionTrendBasis:
          "litres = Σ plausible per-sample decreases; running = Σ min(Δt, 15 min) over consecutive generator history points where the successor had rate > 0",
        fuelPctBasis: "capacity-weighted (Σcurrent / Σcapacity)",
        dailyRunningHoursFor7d: false,
        dailyCostReadingsScanned: dailyReadingsForCost.rows.length,
        dailyCostReadingsTruncated: dailyReadingsForCost.truncated,
        maxDailyReadings: MAX_DAILY_READINGS,
      },
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Local helpers ──────────────────────────────────────────────────────────

interface ReadingRow {
  entityId: string;
  value: number;
  ts: number;
}

/**
 * Load persisted FUEL_LEVEL readings over an explicit time window, bounded by
 * `take` (newest first). The unbounded variant of this query scanned the whole
 * SensorReading table.
 *
 * Results are cached in-process for `DAILY_READINGS_TTL_MS` and keyed by the
 * tenant site-set + window start. Without this, every 15 s poll from the
 * dashboard, inventory, fuel and analytics views would re-run the same
 * 7-day scan to rebuild the same daily bars. The cache key includes the
 * tenant's site ids, so a tenant switch cannot serve another tenant's rows.
 */
const DAILY_READINGS_TTL_MS = 5 * 60 * 1000;
const dailyReadingsCache = new Map<string, { at: number; value: { rows: ReadingRow[]; truncated: boolean } }>();

async function loadFuelLevelReadings({
  user,
  tenantSiteIds,
  startMs,
}: {
  user: Pick<SessionUser, "tenantId">;
  tenantSiteIds: string[] | null;
  startMs: number;
}): Promise<{ rows: ReadingRow[]; truncated: boolean }> {
  // The tenant id is part of the cache key: two tenants can both pass
  // `tenantSiteIds: null` (a superadmin view), and without this the first
  // result would be served to the second.
  const key = `${user.tenantId}|${startMs}|${tenantSiteIds ? tenantSiteIds.slice().sort().join(",") : "*"}`;
  const hit = dailyReadingsCache.get(key);
  if (hit && Date.now() - hit.at < DAILY_READINGS_TTL_MS) return hit.value;

  // SensorReading has no tenantId of its own — tenancy reaches it through
  // Site — so the context comes from the session and the existing siteId filter
  // is kept as defence in depth.
  const rows = await asTenant(user, (tx) =>
    tx.sensorReading.findMany({
      where: {
        metric: "FUEL_LEVEL",
        entityKind: "TANK",
        ts: { gte: new Date(startMs) },
        ...(tenantSiteIds ? { siteId: { in: tenantSiteIds } } : {}),
      },
      select: { entityId: true, value: true, ts: true },
      orderBy: { ts: "desc" },
      take: MAX_DAILY_READINGS,
    }),
  );
  const value = {
    rows: rows.map((r) => ({ entityId: r.entityId, value: r.value, ts: r.ts.getTime() })),
    truncated: rows.length >= MAX_DAILY_READINGS,
  };
  // Keep the map from growing without bound if the window key churns.
  if (dailyReadingsCache.size > 32) dailyReadingsCache.clear();
  dailyReadingsCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Split FUEL_LEVEL readings into platform-local calendar days and sum plausible
 * decreases per day. Increases are never consumption (refills / jitter), and an
 * implausible single-sample drop is discarded as an outlier — otherwise the day
 * total is a function of the sampling noise.
 */
function bucketReadingsByZonedDay(
  rows: readonly ReadingRow[],
  tanks: readonly { id: string; capacity: number }[],
  timezone: string,
): Map<string, { litres: number; samples: number; dateKey: string }> {
  const capacityByTank = new Map(tanks.map((t) => [t.id, t.capacity]));
  const byTank = new Map<string, ReadingRow[]>();
  for (const r of rows) {
    let arr = byTank.get(r.entityId);
    if (!arr) { arr = []; byTank.set(r.entityId, arr); }
    arr.push(r);
  }

  const out = new Map<string, { litres: number; samples: number; dateKey: string }>();
  for (const [tankId, arr] of byTank) {
    const capacity = capacityByTank.get(tankId) ?? 0;
    const groups = new Map<string, LevelPoint[]>();
    for (const r of arr) {
      const start = startOfZonedDay(r.ts, timezone);
      const key = `${zonedWeekdayLabel(start, timezone)}|${start}`;
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push({ t: r.ts, l: r.value });
    }
    for (const [key, pts] of groups) {
      pts.sort((a, b) => a.t - b.t);
      const dayStart = Number(key.slice(key.indexOf("|") + 1));
      const litres = sumPlausibleDecreases(pts, capacity);
      const existing = out.get(key);
      if (existing) {
        existing.litres += litres;
        existing.samples += pts.length;
      } else {
        out.set(key, {
          litres,
          samples: pts.length,
          dateKey: zonedDateKey(dayStart, timezone),
        });
      }
    }
  }
  return out;
}