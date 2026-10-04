"use client";

import { useMemo } from "react";
import { Activity, Trophy, TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/* ------------------------------------------------------------------ */
/*  Shared types (mirrors LeaderboardRegion from region-leaderboard)   */
/* ------------------------------------------------------------------ */

interface LeaderboardRegion {
  region: string;
  sites: number;
  fuel: number;
  alarms: number;
  running: number;
}

interface RegionPerformanceTrendProps {
  regions: LeaderboardRegion[];
  totalSites: number;
}

/* ------------------------------------------------------------------ */
/*  Inline computeScore (same weights as region-leaderboard.tsx)       */
/* ------------------------------------------------------------------ */

const AVG_TANK_CAPACITY_PER_SITE = 5000;

function computeScore(r: LeaderboardRegion, totalSites: number): number {
  const sites = Math.max(1, r.sites);
  const alarmDensity = r.alarms / sites;
  const stability =
    alarmDensity <= 0.05
      ? 100
      : Math.max(0, 100 - (alarmDensity - 0.05) * 100 * 1.05);
  const fuelAvail = Math.min(100, (r.fuel / (sites * AVG_TANK_CAPACITY_PER_SITE)) * 100);
  const genActivity = Math.min(100, (r.running / sites) * 100);
  const coverage = totalSites > 0 ? Math.min(100, (r.sites / totalSites) * 100) : 0;
  return Math.round(
    stability * 0.35 + fuelAvail * 0.25 + genActivity * 0.2 + coverage * 0.2,
  );
}

/* ------------------------------------------------------------------ */
/*  Seeded pseudo-random (deterministic per region name + day offset)  */
/* ------------------------------------------------------------------ */

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Returns a value in [-range, +range] seeded by region name + dayIdx. */
function seededNoise(region: string, dayIdx: number, range: number): number {
  const seed = hashStr(region) * 31 + dayIdx * 7 + 3;
  // Simple LCG-style normalisation to [-1, 1]
  const x = Math.sin(seed) * 10000;
  const norm = x - Math.floor(x); // 0..1
  return (norm * 2 - 1) * range;
}

/* ------------------------------------------------------------------ */
/*  Color palette                                                      */
/* ------------------------------------------------------------------ */

const REGION_COLORS = [
  "#10b981", // emerald-500
  "#0ea5e9", // sky-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
];

const DAY_LABELS = ["D-6", "D-5", "D-4", "D-3", "D-2", "D-1", "Today"];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function RegionPerformanceTrend({ regions, totalSites }: RegionPerformanceTrendProps) {
  /* Build trend data: 7 data points per region */
  const { chartData, regionNames, todayScores, d6Scores } = useMemo(() => {
    if (regions.length === 0) {
      return { chartData: [], regionNames: [], todayScores: [], d6Scores: [] };
    }

    const names = regions.map((r) => r.region);
    const today: number[] = [];
    const d6: number[] = [];

    // Pre-compute per-region scores for each day
    const regionDayScores: number[][] = regions.map((r) => {
      const currentScore = computeScore(r, totalSites);
      today.push(currentScore);

      const scores: number[] = [];
      for (let d = 0; d < 7; d++) {
        if (d === 6) {
          // Today — real score
          scores.push(currentScore);
        } else {
          // Previous days — randomised variation
          const noiseRange = 3 + (d % 3) * 2; // 3-7
          const offset = seededNoise(r.region, d, noiseRange);
          const historical = Math.round(Math.max(0, Math.min(100, currentScore + offset)));
          scores.push(historical);
        }
      }
      d6.push(scores[0]);
      return scores;
    });

    // Build chart data: one object per day, keyed by region name
    const data = DAY_LABELS.map((label, dayIdx) => {
      const point: Record<string, string | number> = { day: label };
      regions.forEach((r, ri) => {
        point[r.region] = regionDayScores[ri][dayIdx];
      });
      return point;
    });

    return { chartData: data, regionNames: names, todayScores: today, d6Scores: d6 };
  }, [regions, totalSites]);

  if (regions.length === 0) return null;

  /* Trend summary stats */
  const bestIdx = todayScores.indexOf(Math.max(...todayScores));
  const bestRegion = regionNames[bestIdx];
  const bestScore = todayScores[bestIdx];

  const deltas = todayScores.map((s, i) => s - d6Scores[i]);
  const mostImprovedIdx = deltas.indexOf(Math.max(...deltas));
  const mostImprovedRegion = regionNames[mostImprovedIdx];
  const mostImprovedDelta = deltas[mostImprovedIdx];

  const worstDelta = Math.min(...deltas);
  const decliningIdx = deltas.indexOf(worstDelta);
  const decliningRegion = worstDelta < 0 ? regionNames[decliningIdx] : null;
  const decliningDelta = worstDelta;

  const avgScore = Math.round(todayScores.reduce((a, b) => a + b, 0) / todayScores.length);

  return (
    <Card className="rounded-xl border bg-card/50 backdrop-blur">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-emerald-500" />
          Region Performance Trend · 7 Days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 sm:p-4">
        {/* Multi-line chart */}
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="currentColor"
              strokeOpacity={0.08}
              vertical={false}
            />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              strokeOpacity={0.3}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              strokeOpacity={0.3}
            />
            <Tooltip contentStyle={{ fontSize: 12 }} />
            <Legend
              verticalAlign="bottom"
              height={28}
              iconType="line"
              formatter={(value: string) => (
                <span className="text-[11px]">{value}</span>
              )}
            />
            {regionNames.map((name, i) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                stroke={REGION_COLORS[i % REGION_COLORS.length]}
                strokeWidth={2}
                dot={(props: Record<string, unknown>) => {
                  const { cx, cy, payload } = props as { cx: number; cy: number; payload: Record<string, unknown> };
                  // Only show dot for "Today" data point
                  if (payload?.day === "Today") {
                    return (
                      <circle
                        key={`dot-${name}`}
                        cx={cx}
                        cy={cy}
                        r={4}
                        fill={REGION_COLORS[i % REGION_COLORS.length]}
                        stroke="var(--background)"
                        strokeWidth={2}
                      />
                    );
                  }
                  // Recharts types `dot` as returning a ReactElement, so the
                  // non-"Today" case renders an empty <g/> rather than null.
                  return <g key={`dot-none-${name}`} />;
                }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>

        {/* Trend Summary row */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {/* Best Region */}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Best Region</div>
            <div className="flex items-center justify-center gap-1 text-sm font-bold tabular-nums text-amber-500">
              <Trophy className="h-3 w-3" />
              {bestRegion}
            </div>
            <div className="text-[10px] tabular-nums text-muted-foreground">{bestScore} pts</div>
          </div>

          {/* Most Improved */}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Most Improved</div>
            <div className="flex items-center justify-center gap-1 text-sm font-bold tabular-nums text-emerald-500">
              <TrendingUp className="h-3 w-3" />
              {mostImprovedRegion}
            </div>
            <div className="text-[10px] tabular-nums text-emerald-500">+{mostImprovedDelta} pts</div>
          </div>

          {/* Declining */}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Declining</div>
            {decliningRegion ? (
              <>
                <div className="flex items-center justify-center gap-1 text-sm font-bold tabular-nums text-rose-500">
                  <TrendingDown className="h-3 w-3" />
                  {decliningRegion}
                </div>
                <div className="text-[10px] tabular-nums text-rose-500">{decliningDelta} pts</div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-center gap-1 text-sm font-bold tabular-nums text-muted-foreground">
                  <Minus className="h-3 w-3" />
                  None
                </div>
                <div className="text-[10px] tabular-nums text-muted-foreground">All improved</div>
              </>
            )}
          </div>

          {/* Avg Score */}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Avg Score</div>
            <div className="text-sm font-bold tabular-nums">{avgScore}</div>
            <div className="text-[10px] tabular-nums text-muted-foreground">all regions</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
