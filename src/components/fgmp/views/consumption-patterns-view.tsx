"use client";

import { useMemo } from "react";
import {
  Activity, Clock, Moon, Sun, Calendar, Flame,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { TankState } from "@/lib/fgmp/types";
import { cn } from "@/lib/utils";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const NIGHT_HOURS = [22, 23, 0, 1, 2, 3, 4, 5];

interface Bucket {
  sum: number;
  count: number;
}

interface SiteStat {
  siteId: string;
  site: string;
  mean: number;
  variance: number;
  samples: number;
}

/**
 * Walk a tank's history and accumulate per-cell consumption rates (L/h) into
 * a 7×24 matrix (day-of-week × hour-of-day). Consecutive history points are
 * treated as one interval; we compute the litre-delta (clamped to ≥0 so that
 * refills don't show as negative consumption) and the elapsed hours, then
 * bucket the resulting rate by the midpoint timestamp's day-of-week and hour.
 *
 * The `matrix` argument is mutated in place.
 */
function bucketTankHistory(tank: TankState, matrix: Bucket[][]) {
  const h = tank.history ?? [];
  if (h.length < 2) return;
  for (let i = 0; i < h.length - 1; i++) {
    const p1 = h[i];
    const p2 = h[i + 1];
    const dt = (p1.t - p2.t) / 3600000; // hours
    if (dt <= 0) continue;
    const dl = Math.max(0, p1.l - p2.l); // litres consumed (refills ignored)
    if (dl === 0) continue;
    const rate = dl / dt; // L/h
    const midT = (p1.t + p2.t) / 2;
    const date = new Date(midT);
    // Map JS getDay() (0=Sun..6=Sat) to Mon-first index (0=Mon..6=Sun)
    const dow = (date.getDay() + 6) % 7;
    const hour = date.getHours();
    matrix[dow][hour].sum += rate;
    matrix[dow][hour].count += 1;
  }
}

function avgCell(b: Bucket): number {
  return b.count > 0 ? b.sum / b.count : 0;
}

/** Map an intensity (0..1) to a Tailwind background class. */
function colorForIntensity(intensity: number): string {
  if (intensity === 0) return "bg-muted/40";
  if (intensity < 0.2) return "bg-emerald-500/20";
  if (intensity < 0.4) return "bg-emerald-500/40";
  if (intensity < 0.6) return "bg-amber-500/50";
  if (intensity < 0.8) return "bg-rose-500/60";
  return "bg-rose-600/80";
}

export function ConsumptionPatternsView() {
  const { snapshot } = useFgmp();
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const cc = useChartColors();

  const { matrix, siteStats, maxCell } = useMemo(() => {
    const m: Bucket[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ sum: 0, count: 0 })),
    );
    const siteMap = new Map<string, Bucket[][]>();
    if (snapshot) {
      const siteOf = (id: string) => snapshot.sites.find((s) => s.id === id);
      for (const tk of snapshot.tanks) {
        bucketTankHistory(tk, m);
        if (!siteMap.has(tk.siteId)) {
          siteMap.set(tk.siteId, Array.from({ length: 7 }, () =>
            Array.from({ length: 24 }, () => ({ sum: 0, count: 0 })),
          ));
        }
        bucketTankHistory(tk, siteMap.get(tk.siteId)!);
      }
      const stats: SiteStat[] = [];
      for (const [siteId, sm] of siteMap) {
        const values: number[] = [];
        for (let d = 0; d < 7; d++) {
          for (let h = 0; h < 24; h++) {
            const v = avgCell(sm[d][h]);
            if (v > 0) values.push(v);
          }
        }
        if (values.length === 0) continue;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
        const site = siteOf(siteId)?.name ?? "—";
        stats.push({ siteId, site, mean, variance, samples: values.length });
      }
      stats.sort((a, b) => b.variance - a.variance);
      let mc = 0;
      for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
          mc = Math.max(mc, avgCell(m[d][h]));
        }
      }
      return { matrix: m, siteStats: stats, maxCell: mc };
    }
    return { matrix: m, siteStats: [] as SiteStat[], maxCell: 0 };
  }, [snapshot]);

  if (!snapshot) return null;

  // KPI metrics — derived from the matrix so heatmap + KPIs stay consistent.
  const hasData = maxCell > 0;
  const hourAvgs = HOURS.map((h) => {
    let s = 0;
    for (let d = 0; d < 7; d++) s += avgCell(matrix[d][h]);
    return s / 7;
  });
  const dayAvgs = DAYS.map((_, d) => {
    let s = 0;
    for (let h = 0; h < 24; h++) s += avgCell(matrix[d][h]);
    return s / 24;
  });
  const peakHourIdx = hasData
    ? hourAvgs.indexOf(Math.max(...hourAvgs))
    : -1;
  const peakDayIdx = hasData
    ? dayAvgs.indexOf(Math.max(...dayAvgs))
    : -1;

  // Night (22:00-06:00) vs Daytime (06:00-22:00) averages
  const nightValues: number[] = [];
  for (const h of NIGHT_HOURS) {
    for (let d = 0; d < 7; d++) nightValues.push(avgCell(matrix[d][h]));
  }
  const dayValues: number[] = [];
  for (let h = 6; h < 22; h++) {
    for (let d = 0; d < 7; d++) dayValues.push(avgCell(matrix[d][h]));
  }
  const nightAvg = nightValues.length
    ? nightValues.reduce((a, b) => a + b, 0) / nightValues.length
    : 0;
  const dayAvg = dayValues.length
    ? dayValues.reduce((a, b) => a + b, 0) / dayValues.length
    : 0;

  // Chart data
  const hourChartData = HOURS.map((h) => ({
    hour: `${formatNumber(String(h).padStart(2, "0"), numLang)}:00`,
    avg: Math.round(hourAvgs[h] * 100) / 100,
  }));
  const dayChartData = DAYS.map((d, i) => ({
    day: d,
    avg: Math.round(dayAvgs[i] * 100) / 100,
  }));
  const maxHourAvg = Math.max(...hourAvgs, 1);
  const maxDayAvg = Math.max(...dayAvgs, 1);

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.consumption-patterns")}
        description={t("desc.consumption-patterns")}
        icon={<Activity className="h-5 w-5" />}
        tone="emerald"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
        <KpiCard
          label="Peak Hour"
          value={peakHourIdx >= 0
            ? `${formatNumber(String(peakHourIdx).padStart(2, "0"), numLang)}:00`
            : "—"}
          icon={<Clock className="h-4 w-4" />}
          tone="danger"
          hint={peakHourIdx >= 0
            ? `${formatNumber(hourAvgs[peakHourIdx].toFixed(1), numLang)} L/h avg`
            : "No data"}
        />
        <KpiCard
          label="Peak Day"
          value={peakDayIdx >= 0 ? DAYS[peakDayIdx] : "—"}
          icon={<Calendar className="h-4 w-4" />}
          tone="warn"
          hint={peakDayIdx >= 0
            ? `${formatNumber(dayAvgs[peakDayIdx].toFixed(1), numLang)} L/h avg`
            : "No data"}
        />
        <KpiCard
          label="Night Consumption"
          value={formatNumber(nightAvg.toFixed(1), numLang)}
          unit="L/h"
          icon={<Moon className="h-4 w-4" />}
          tone="info"
          hint="22:00 – 06:00"
        />
        <KpiCard
          label="Daytime Consumption"
          value={formatNumber(dayAvg.toFixed(1), numLang)}
          unit="L/h"
          icon={<Sun className="h-4 w-4" />}
          tone="good"
          hint="06:00 – 22:00"
        />
      </div>

      {/* Heatmap matrix */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Flame className="h-4 w-4 text-rose-500" />
            Consumption Heatmap (L/h avg, last 24h window)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3">
          <div className="overflow-x-auto">
            <table
              dir="ltr"
              className="w-full border-separate border-spacing-1 text-center text-[10px]"
            >
              <thead>
                <tr>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">
                    Day
                  </th>
                  {HOURS.map((h) => (
                    <th
                      key={h}
                      className="px-1 py-1 font-medium text-muted-foreground"
                    >
                      {formatNumber(String(h).padStart(2, "0"), numLang)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((day, d) => (
                  <tr key={day}>
                    <td className="px-2 py-1 text-left font-medium">{day}</td>
                    {HOURS.map((h) => {
                      const v = avgCell(matrix[d][h]);
                      const intensity = maxCell > 0 ? v / maxCell : 0;
                      const bg = colorForIntensity(intensity);
                      const tooltip = v > 0
                        ? `${day} ${String(h).padStart(2, "0")}:00 — ${formatNumber(v.toFixed(2), numLang)} L/h`
                        : `${day} ${String(h).padStart(2, "0")}:00 — no consumption`;
                      return (
                        <td
                          key={h}
                          className={cn(
                            "h-7 w-7 rounded-sm transition-transform hover:scale-125 hover:ring-2 hover:ring-foreground/40",
                            bg,
                          )}
                          title={tooltip}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Legend */}
          <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
            <span>Low</span>
            <span className="h-3 w-6 rounded-sm bg-emerald-500/20" />
            <span className="h-3 w-6 rounded-sm bg-emerald-500/40" />
            <span className="h-3 w-6 rounded-sm bg-amber-500/50" />
            <span className="h-3 w-6 rounded-sm bg-rose-500/60" />
            <span className="h-3 w-6 rounded-sm bg-rose-600/80" />
            <span>High</span>
          </div>
        </CardContent>
      </Card>

      {/* Side panel charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Clock className="h-4 w-4 text-amber-500" />
              Average Consumption by Hour
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hourChartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="hour" tick={{ fontSize: 8 }} stroke="currentColor" strokeOpacity={0.3} interval={2} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(v: any) => [`${formatNumber(Number(v).toFixed(2), numLang)} L/h`, "Avg"]}
                />
                <Bar dataKey="avg" radius={[3, 3, 0, 0]} name="L/h">
                  {hourChartData.map((d, i) => {
                    const intensity = maxHourAvg > 0 ? d.avg / maxHourAvg : 0;
                    const fill = intensity < 0.4 ? cc.emerald : intensity < 0.7 ? cc.amber : cc.rose;
                    return <Cell key={i} fill={fill} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Calendar className="h-4 w-4 text-emerald-500" />
              Average Consumption by Day of Week
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dayChartData} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  formatter={(v: any) => [`${formatNumber(Number(v).toFixed(2), numLang)} L/h`, "Avg"]}
                />
                <Bar dataKey="avg" radius={[4, 4, 0, 0]} name="L/h">
                  {dayChartData.map((d, i) => {
                    const intensity = maxDayAvg > 0 ? d.avg / maxDayAvg : 0;
                    const fill = intensity < 0.4 ? cc.emerald : intensity < 0.7 ? cc.amber : cc.rose;
                    return <Cell key={i} fill={fill} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Top 5 sites by variance */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Top 5 Sites by Consumption Variance
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead className="text-right">Mean (L/h)</TableHead>
                <TableHead className="text-right">Std Dev (L/h)</TableHead>
                <TableHead className="text-right">Variance</TableHead>
                <TableHead className="text-right">Samples</TableHead>
                <TableHead>Pattern</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {siteStats.slice(0, 5).map((s) => {
                const stdDev = Math.sqrt(s.variance);
                const cv = s.mean > 0 ? stdDev / s.mean : 0;
                return (
                  <TableRow key={s.siteId}>
                    <TableCell className="text-xs font-medium">{s.site}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(s.mean.toFixed(2), numLang)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(stdDev.toFixed(2), numLang)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(s.variance.toFixed(2), numLang)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{formatNumber(s.samples, numLang)}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          cv > 0.6
                            ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[10px]"
                            : cv > 0.3
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px]"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px]"
                        }
                      >
                        {cv > 0.6 ? "Volatile" : cv > 0.3 ? "Variable" : "Stable"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {siteStats.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                    No consumption data available in current tank history.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
