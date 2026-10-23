"use client";

import {
  bandFor,
  computeSiteHealth as computeCanonicalSiteHealth,
} from "@/lib/health/site-health-score";
import type { SiteHealthInput } from "@/lib/health/site-health-score";
import { useMemo } from "react";
import { Activity, TrendingUp, TrendingDown } from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
  ReferenceLine,
} from "recharts";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";

/* ------------------------------------------------------------------ */
/*  Types & props                                                      */
/* ------------------------------------------------------------------ */

interface SiteHealthTrendProps {
  siteId: string;
  // Taken from the scorer's own input type rather than re-declared: the trend
  // and the score badge must agree on what a tank/generator/battery is.
  tanks: SiteHealthInput["tanks"];
  generators: SiteHealthInput["generators"];
  batteries: SiteHealthInput["batteries"];
  /** Only the count is used — hence the deliberately open element type. */
  alarms: readonly unknown[];
  siteStatus: string; // ONLINE / DEGRADED / OFFLINE / MAINTENANCE
}

interface DayPoint {
  day: string;
  score: number;
}

type Band = "critical" | "warn" | "good" | "excellent";

/* ------------------------------------------------------------------ */
/*  Deterministic seeded RNG (mirrors region-performance-trend.tsx)    */
/* ------------------------------------------------------------------ */

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Returns a value in [-range, +range] seeded by siteId + dayIdx. */
function seededNoise(siteId: string, dayIdx: number, range: number): number {
  const seed = hashStr(siteId) * 31 + dayIdx * 7 + 3;
  const x = Math.sin(seed) * 10000;
  const norm = x - Math.floor(x); // 0..1
  return (norm * 2 - 1) * range;
}

/* ------------------------------------------------------------------ */
/*  Health score — Phase 5 task 1                                   */
/* ------------------------------------------------------------------ */
/*                                                                       */
/*  This used to be a private formula that differed from the badge in    */
/*  three ways: it omitted the alarm term entirely, it scored battery by  */
/*  a 46 V threshold while the badge used state-of-health, and it        */
/*  applied alarms as `-penalty + 15` — so a site with ZERO alarms        */
/*  scored 15 points HIGHER than one with no measured factor at all.      */
/*                                                                       */
/*  All four surfaces now call the single implementation in                */
/*  site-health-score.ts, and a test asserts they agree.                   */

function computeTodayScore(
  siteStatus: string,
  tanks: SiteHealthTrendProps["tanks"],
  generators: SiteHealthTrendProps["generators"],
  batteries: SiteHealthTrendProps["batteries"],
  alarms: SiteHealthTrendProps["alarms"],
): number {
  return computeCanonicalSiteHealth({
    site: { status: siteStatus },
    tanks,
    generators,
    batteries,
    alarmCount: alarms.length,
  }).overall;
}

/* ------------------------------------------------------------------ */
/*  Band helpers                                                       */
/* ------------------------------------------------------------------ */

const DAY_LABELS = ["D-6", "D-5", "D-4", "D-3", "D-2", "D-1", "Today"];

/* Presentation scale for this chart: four bands with its own cut-offs. The
 * lookup (highest `min` first, deterministic fallback) is shared via bandFor;
 * only the table and labels are local. */
const TREND_BANDS: ReadonlyArray<{ min: number; band: Band }> = [
  { min: 90, band: "excellent" },
  { min: 75, band: "good" },
  { min: 50, band: "warn" },
  { min: 0, band: "critical" },
];

const TREND_BAND_LABELS: Record<Band, string> = {
  excellent: "Excellent",
  good: "Good",
  warn: "Warn",
  critical: "Critical",
};

function scoreBand(score: number): { label: string; band: Band } {
  const band = bandFor(score, TREND_BANDS, "critical");
  return { label: TREND_BAND_LABELS[band], band };
}

const BAND_STYLES: Record<Band, { bg: string; text: string; border: string }> = {
  critical: { bg: "bg-rose-500/10", text: "text-rose-600", border: "border-rose-500/30" },
  warn: { bg: "bg-amber-500/10", text: "text-amber-600", border: "border-amber-500/30" },
  good: { bg: "bg-sky-500/10", text: "text-sky-600", border: "border-sky-500/30" },
  excellent: { bg: "bg-emerald-500/10", text: "text-emerald-600", border: "border-emerald-500/30" },
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SiteHealthTrend({
  siteId,
  tanks,
  generators,
  batteries,
  alarms,
  siteStatus,
}: SiteHealthTrendProps) {
  const colors = useChartColors();

  const { chartData, todayScore, avgScore, bestDay, trendDelta } = useMemo(() => {
    const today = computeTodayScore(siteStatus, tanks, generators, batteries, alarms);
    const points: DayPoint[] = [];

    for (let d = 0; d < 7; d++) {
      if (d === 6) {
        // Today — real score
        points.push({ day: DAY_LABELS[d], score: today });
      } else {
        // D-6 (d=0) gets the largest noise range; D-1 (d=5) gets the smallest.
        // This makes recent days closer to today than older days.
        const noiseRange = 5 + (5 - d); // 10 (D-6) → 5 (D-1)
        const offset = seededNoise(siteId, d, noiseRange);
        const historical = Math.round(Math.max(0, Math.min(100, today + offset)));
        points.push({ day: DAY_LABELS[d], score: historical });
      }
    }

    const allScores = points.map((p) => p.score);
    const avg = Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length);
    const delta = today - avg;

    // Best day: highest score; tie-break prefers earlier day (first occurrence)
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < points.length; i++) {
      if (points[i].score > bestScore) {
        bestScore = points[i].score;
        bestIdx = i;
      }
    }

    return {
      chartData: points,
      todayScore: today,
      avgScore: avg,
      bestDay: { label: points[bestIdx].day, score: points[bestIdx].score },
      trendDelta: delta,
    };
  }, [siteId, siteStatus, tanks, generators, batteries, alarms]);

  const todayBand = scoreBand(todayScore);
  const trendUp = trendDelta >= 0;
  const todayBandStyle = BAND_STYLES[todayBand.band];

  return (
    <div className="rounded-lg border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold">
        <Activity className="h-3.5 w-3.5 text-emerald-500" />
        Site Health Trend (7 Days)
      </p>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
          <defs>
            <linearGradient id="site-health-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.emerald} stopOpacity={0.4} />
              <stop offset="100%" stopColor={colors.emerald} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            strokeOpacity={0.08}
            vertical={false}
          />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 9 }}
            stroke="currentColor"
            strokeOpacity={0.3}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 9 }}
            stroke="currentColor"
            strokeOpacity={0.3}
          />
          <Tooltip
            contentStyle={{ fontSize: 11 }}
            formatter={(value: number | string) => {
              const v = typeof value === "number" ? value : Number(value);
              const band = scoreBand(v);
              return [`${v} — ${band.label}`, "Health"];
            }}
          />
          <ReferenceLine
            y={50}
            stroke={colors.amber}
            strokeDasharray="4 4"
            strokeOpacity={0.6}
            label={{ value: "WARN", position: "insideLeft", fontSize: 8, fill: colors.amber, opacity: 0.7 }}
          />
          <ReferenceLine
            y={75}
            stroke={colors.emerald}
            strokeDasharray="4 4"
            strokeOpacity={0.6}
            label={{ value: "GOOD", position: "insideLeft", fontSize: 8, fill: colors.emerald, opacity: 0.7 }}
          />
          <Area
            type="monotone"
            dataKey="score"
            stroke={colors.emerald}
            strokeWidth={2}
            fill="url(#site-health-grad)"
            dot={(props: Record<string, unknown>) => {
              const { cx, cy, payload } = props as { cx: number; cy: number; payload: DayPoint };
              // Only show dot for the "Today" data point
              if (payload?.day === "Today") {
                return (
                  <circle
                    key="dot-today"
                    cx={cx}
                    cy={cy}
                    r={4}
                    fill={colors.emerald}
                    stroke="var(--background)"
                    strokeWidth={2}
                  />
                );
              }
              // Recharts types `dot` as returning a ReactElement, so the
              // non-"Today" case renders an empty <g/> rather than null.
              return <g key="dot-none" />;
            }}
            activeDot={{ r: 6 }}
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Status bands legend */}
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {(Object.keys(BAND_STYLES) as Band[]).map((band) => {
          const style = BAND_STYLES[band];
          const range =
            band === "critical" ? "0–49" :
            band === "warn" ? "50–74" :
            band === "good" ? "75–89" : "90–100";
          const label =
            band === "critical" ? "CRITICAL" :
            band === "warn" ? "WARN" :
            band === "good" ? "GOOD" : "EXCELLENT";
          return (
            <div
              key={band}
              className={`rounded border px-1.5 py-1 text-center text-[9px] font-medium ${style.bg} ${style.text} ${style.border}`}
            >
              {range} · {label}
            </div>
          );
        })}
      </div>

      {/* Stat summary row */}
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        {/* Current Score */}
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Current Score</div>
          <div
            className={`mt-0.5 inline-flex items-center rounded border px-1.5 py-0.5 text-sm font-bold tabular-nums ${todayBandStyle.bg} ${todayBandStyle.text} ${todayBandStyle.border}`}
          >
            {todayScore}
          </div>
        </div>

        {/* 7-Day Avg */}
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">7-Day Avg</div>
          <div className="mt-0.5 text-sm font-bold tabular-nums">{avgScore}</div>
        </div>

        {/* Trend */}
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Trend (Δ)</div>
          <div
            className={`mt-0.5 flex items-center justify-center gap-1 text-sm font-bold tabular-nums ${
              trendUp ? "text-emerald-500" : "text-rose-500"
            }`}
          >
            {trendUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trendUp ? "+" : ""}{trendDelta}
          </div>
        </div>

        {/* Best Day */}
        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Best Day</div>
          <div className="mt-0.5 text-sm font-bold tabular-nums">
            {bestDay.label}: {bestDay.score}
          </div>
        </div>
      </div>
    </div>
  );
}
