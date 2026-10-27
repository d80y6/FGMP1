import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { toNum } from "@/lib/fgmp/decimal";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireAuth,
  siteTenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";
import { resolvePlatformTimezone, zonedDayOfWeek, zonedHour } from "@/lib/fgmp/thresholds-time";
import { maxPlausibleDrainLph } from "@/lib/fgmp/metrics-fuel-series";

export const dynamic = "force-dynamic";

// ── Types (mirror the API response shape) ─────────────────────────────────
interface AnomalyCell {
  day: number;
  hour: number;
  litres: number;
}

interface TopSite {
  siteId: string;
  siteName: string;
  siteCode: string;
  governorate: string;
  consumed: number;
}

interface PatternsResponse {
  generatedAt: string;
  matrix: number[][];
  hourlyAverages: number[];
  dailyTotals: number[];
  peakHour: number;
  peakDay: number;
  peakCell: { day: number; hour: number; litres: number };
  nightConsumptionPct: number;
  totalConsumed: number;
  avgPerCell: number;
  anomalyCells: AnomalyCell[];
  dayLabels: string[];
  topSites: TopSite[];
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Hours 22, 23, 0..5 are "night" (22:00 → 05:59) in the PLATFORM timezone.
const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5]);

/**
 * Explicit window for the FUEL_LEVEL scan. The previous query had NO `ts`
 * bound and NO `take`, so it was a full-table scan of SensorReading — the only
 * indexes are `(siteId, ts)` and `(entityId, metric, ts)`, neither of which
 * leads with `metric`, so the planner has no usable index for
 * `WHERE metric = 'FUEL_LEVEL'`.
 *
 * 90 days gives ~13 samples per day-of-week/hour cell, enough for the matrix to
 * be stable, while `MAX_READINGS` bounds the row count regardless of how fast
 * telemetry arrives (a 5 s polling interval is ~1.5 M rows/day).
 */
const WINDOW_DAYS = 90;
const MAX_READINGS = 60_000;

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Sum consumption (litres) from a tank's readings by counting only level
 * DECREASES that are physically plausible. Refills show up as increases and are
 * skipped; a single implausible drop is discarded as an outlier instead of
 * inflating the hour.
 *
 * Side-effect: when `matrix` is provided, the consumed litres are added to the
 * matrix cell for the platform-local day-of-week/hour of the second point.
 *
 * TIMEZONE: the matrix is bucketed with `zonedDayOfWeek` / `zonedHour`
 * (`Intl.DateTimeFormat` with `timeZone`), never with `Date#getDay()` /
 * `Date#getHours()`. Those read the SERVER's timezone — and the Docker image
 * sets no TZ, so the server is UTC while the platform is configured for
 * Asia/Aden (UTC+3). The 00:00–03:00 Aden window was therefore being placed on
 * the previous calendar day, which shifted the "night consumption %" window
 * (22:00–05:59) by three hours.
 */
function accumulateConsumption(
  readings: readonly { value: number; ts: number }[],
  capacity: number,
  timezone: string,
  matrix?: number[][],
): number {
  const sorted = [...readings].sort((a, b) => a.ts - b.ts);
  const plausible = maxPlausibleDrainLph(capacity);
  let consumed = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.value <= b.value) continue; // rise or flat — a refill, not consumption
    const dtH = (b.ts - a.ts) / 3_600_000;
    if (dtH <= 0) continue;
    const diff = a.value - b.value;
    // Outlier guard — the same bound the runout/forecast estimators use.
    if (diff / dtH > plausible) continue;
    consumed += diff;
    if (matrix) {
      const day = zonedDayOfWeek(b.ts, timezone); // 0=Sun..6=Sat
      const hour = zonedHour(b.ts, timezone);    // 0..23
      matrix[day][hour] += diff;
    }
  }
  return consumed;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant-scoped: a tenant may set its own `timezone`; otherwise the
    // platform default row applies.
    const timezone = await resolvePlatformTimezone(tenantIdOrThrow(me.tenantId));

    // ── Load persisted FUEL_LEVEL readings from the SensorReading table ──
    // We use the DB (not engine.tanks[].history) because the in-memory history
    // is capped at 288 points (~24 min of live ticks) and gets overwritten by
    // live telemetry. The SensorReading table persists every reading, giving
    // us true multi-day historical patterns for the heatmap.
    //
    // BOUNDED: explicit `ts` window + `take` (previously neither existed, so
    // this was a full-table scan on every poll — the endpoint polls every 60 s).
    //
    // SensorReading has a bare `siteId` column, so the in-memory site list
    // supplies the caller's tenant-local IDs. SUPERADMIN is not a data-scope
    // bypass; use support access for another tenant's operational records.
    const tenantId = tenantIdOrThrow(me.tenantId);
    const tenantSiteIds = engine.sites
      .filter((s) => s.tenantId === tenantId)
      .map((s) => s.id);
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000);
    // Both reads inside one transaction. The FuelTank query has a nested
    // `site: { … governorate: { … } }` traversal — two RLS-protected hops — so
    // scoping only the outer findMany would return tanks with a null site.
    const [readings, tankRows] = await asTenant(me, (tx) => Promise.all([
      tx.sensorReading.findMany({
        where: {
          metric: "FUEL_LEVEL",
          entityKind: "TANK",
          ts: { gte: cutoff },
          siteId: { in: tenantSiteIds },
        },
        select: { entityId: true, value: true, ts: true },
        // Newest first so the `take` keeps the most relevant rows; each tank's
        // series is re-sorted ascending in memory below.
        orderBy: { ts: "desc" },
        take: MAX_READINGS,
      }),
      tx.fuelTank.findMany({
        where: { ...siteTenantWhereOrAll(me) },
        select: {
          id: true,
          label: true,
          capacityLitres: true,
          site: { select: { id: true, name: true, code: true, governorate: { select: { name: true } } } },
        },
      }),
    ]));

    // Map tankId → { label, capacity, siteId, siteName, siteCode, governorate }
    const tankMeta = new Map<string, { label: string; capacity: number; siteId: string; siteName: string; siteCode: string; governorate: string }>();
    for (const tk of tankRows) {
      tankMeta.set(tk.id, {
        label: tk.label,
        // Phase 5 task 1: capacityLitres is Decimal(12,3); the analytics
        // bucket below does arithmetic on it, so convert at the read.
        capacity: toNum(tk.capacityLitres, { scale: 3 }),
        siteId: tk.site.id,
        siteName: tk.site.name,
        siteCode: tk.site.code,
        governorate: tk.site.governorate.name,
      });
    }

    // Group readings by tank (already ordered ts desc; sorted per group below).
    const readingsByTank = new Map<string, { value: number; ts: number }[]>();
    for (const r of readings) {
      let arr = readingsByTank.get(r.entityId);
      if (!arr) { arr = []; readingsByTank.set(r.entityId, arr); }
      arr.push({ value: r.value, ts: r.ts.getTime() });
    }

    // ── Build the 7×24 consumption matrix ────────────────────────────────
    // matrix[day][hour] = litres consumed during that day-of-week/hour window,
    // summed over the whole 90-day window (see `matrixBasis` in the payload).
    // Day 0=Sunday … 6=Saturday. Hour 0..23 in the platform timezone.
    const matrix: number[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => 0),
    );

    // Also track per-site consumption for the topSites panel.
    const siteConsumption = new Map<string, number>();

    for (const [tankId, pts] of readingsByTank) {
      const meta = tankMeta.get(tankId);
      if (!meta) continue;
      const consumed = accumulateConsumption(pts, meta.capacity, timezone, matrix);
      if (consumed > 0) {
        siteConsumption.set(meta.siteId, (siteConsumption.get(meta.siteId) ?? 0) + consumed);
      }
    }

    // ── Hourly averages (24 values): for each hour, average across 7 days ─
    const hourlyAverages: number[] = [];
    for (let h = 0; h < 24; h++) {
      let sum = 0;
      for (let d = 0; d < 7; d++) sum += matrix[d][h];
      hourlyAverages.push(round1(sum / 7));
    }

    // ── Daily totals (7 values): for each day, sum across 24 hours ────────
    const dailyTotals: number[] = matrix.map((row) =>
      round1(row.reduce((s, v) => s + v, 0)),
    );

    // ── Peak hour (highest hourly average) ────────────────────────────────
    let peakHour = 0;
    for (let h = 1; h < 24; h++) {
      if (hourlyAverages[h] > hourlyAverages[peakHour]) peakHour = h;
    }

    // ── Peak day (highest daily total) ────────────────────────────────────
    let peakDay = 0;
    for (let d = 1; d < 7; d++) {
      if (dailyTotals[d] > dailyTotals[peakDay]) peakDay = d;
    }

    // ── Peak cell (single highest-consumption cell) ───────────────────────
    let peakCell = { day: 0, hour: 0, litres: 0 };
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (matrix[d][h] > peakCell.litres) {
          peakCell = { day: d, hour: h, litres: matrix[d][h] };
        }
      }
    }

    // ── Total + per-cell average (non-zero cells only) ────────────────────
    let totalConsumed = 0;
    let nonZeroCells = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const v = matrix[d][h];
        if (v > 0) {
          totalConsumed += v;
          nonZeroCells++;
        }
      }
    }
    const avgPerCell = nonZeroCells > 0 ? totalConsumed / nonZeroCells : 0;

    // ── Night consumption % (22:00 → 05:59) ───────────────────────────────
    // High night consumption may indicate theft or unscheduled generator use.
    let nightConsumed = 0;
    for (let d = 0; d < 7; d++) {
      for (const h of NIGHT_HOURS) {
        nightConsumed += matrix[d][h];
      }
    }
    const nightConsumptionPct =
      totalConsumed > 0
        ? Math.round((nightConsumed / totalConsumed) * 1000) / 10
        : 0;

    // ── Anomaly cells: consumption > 2.5 × avgPerCell ─────────────────────
    // Statistically high — investigate for theft / unscheduled use.
    const threshold = avgPerCell * 2.5;
    const anomalyCells: AnomalyCell[] = [];
    if (threshold > 0) {
      for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
          const v = matrix[d][h];
          if (v > threshold) {
            anomalyCells.push({ day: d, hour: h, litres: round1(v) });
          }
        }
      }
      anomalyCells.sort((a, b) => b.litres - a.litres);
      // Limit to top 10.
      if (anomalyCells.length > 10) anomalyCells.length = 10;
    }

    // ── Top 5 sites by total consumption ──────────────────────────────────
    // Built from the per-site consumption map populated above (DB-sourced).
    const siteMeta = new Map<string, { name: string; code: string; governorate: string }>();
    for (const tk of tankRows) {
      if (!siteMeta.has(tk.site.id)) {
        siteMeta.set(tk.site.id, { name: tk.site.name, code: tk.site.code, governorate: tk.site.governorate.name });
      }
    }
    const topSites: TopSite[] = Array.from(siteConsumption.entries())
      .map(([siteId, consumed]) => {
        const m = siteMeta.get(siteId);
        return {
          siteId,
          siteName: m?.name ?? "—",
          siteCode: m?.code ?? "—",
          governorate: m?.governorate ?? "—",
          consumed: Math.round(consumed),
        };
      })
      .sort((a, b) => b.consumed - a.consumed)
      .slice(0, 5);

    // ── Round matrix cells to 1 decimal ───────────────────────────────────
    const matrixRounded = matrix.map((row) => row.map(round1));

    const body: PatternsResponse & {
      meta: {
        timezone: string;
        windowDays: number;
        readingsScanned: number;
        readingsTruncated: boolean;
        maxReadings: number;
        matrixBasis: string;
      };
    } = {
      generatedAt: new Date().toISOString(),
      matrix: matrixRounded,
      hourlyAverages,
      dailyTotals,
      peakHour,
      peakDay,
      peakCell: {
        day: peakCell.day,
        hour: peakCell.hour,
        litres: round1(peakCell.litres),
      },
      nightConsumptionPct,
      totalConsumed: Math.round(totalConsumed),
      avgPerCell: round1(avgPerCell),
      anomalyCells,
      dayLabels: DAY_LABELS,
      topSites,
      meta: {
        timezone,
        windowDays: WINDOW_DAYS,
        readingsScanned: readings.length,
        readingsTruncated: readings.length >= MAX_READINGS,
        maxReadings: MAX_READINGS,
        // The matrix holds litres summed over the WHOLE window, so a cell is
        // "one weekday-hour across every week in the window", not one day.
        matrixBasis:
          "litres summed over the whole analysis window, bucketed by platform-local day-of-week/hour",
      },
    };

    const res = NextResponse.json(body);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
