"use client";

import { useMemo } from "react";
import {
  Brain, AlertTriangle, AlertOctagon, Clock, TrendingDown,
  PackagePlus, Activity,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Legend,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { fmtLitres, fmtDateTime } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { TankState } from "@/lib/fgmp/types";

type RiskLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

interface ForecastRow {
  id: string;
  siteId: string;
  site: string;
  tank: string;
  current: number;
  capacity: number;
  pct: number;
  rate: number; // L/h, positive = consuming
  hoursToLow: number;
  hoursToCritical: number;
  hoursToDry: number;
  dryOutAt: number | null;
  risk: RiskLevel;
}

const RISK_COLORS: Record<RiskLevel, { bg: string; text: string; border: string }> = {
  CRITICAL: { bg: "bg-rose-500/15", text: "text-rose-700 dark:text-rose-300", border: "border-rose-500/40" },
  HIGH: { bg: "bg-rose-500/10", text: "text-rose-600 dark:text-rose-400", border: "border-rose-500/30" },
  MEDIUM: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", border: "border-amber-500/30" },
  LOW: { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/30" },
};

const RISK_ORDER: Record<RiskLevel, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3,
};

/**
 * Compute the consumption rate (L/h) for a tank using least-squares linear
 * regression on the last N history points. The slope of `level` vs `time`
 * is negative when the tank is draining; we return the absolute value. If
 * the slope is non-negative (no consumption, or a recent refill), we return
 * 0 so the forecast shows the tank as stable / LOW risk.
 */
function linearRegressionRate(history: { t: number; l: number }[]): number {
  // Use the last 24 points (≈2h at the engine's 5-min cadence) to capture
  // the *current* drain rate while smoothing out single-interval noise.
  const pts = history.slice(-24);
  if (pts.length < 2) return 0;
  const n = pts.length;
  const ts = pts.map((p) => p.t);
  const ls = pts.map((p) => p.l);
  const tMean = ts.reduce((a, b) => a + b, 0) / n;
  const lMean = ls.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (ts[i] - tMean) * (ls[i] - lMean);
    den += (ts[i] - tMean) ** 2;
  }
  if (den === 0) return 0;
  // slope is in L/ms → convert to L/h
  const slopeLPerH = (num / den) * 3600000;
  return slopeLPerH < 0 ? -slopeLPerH : 0;
}

function fmtHours(h: number, numLang: Language): string {
  if (!isFinite(h) || h <= 0) return "—";
  if (h < 24) return `${formatNumber(h.toFixed(1), numLang)}h`;
  return `${formatNumber((h / 24).toFixed(1), numLang)}d`;
}

export function FuelForecastView() {
  const { snapshot, setView } = useFgmp();
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const cc = useChartColors();

  const rows = useMemo<ForecastRow[]>(() => {
    if (!snapshot) return [];
    const siteOf = (id: string) => snapshot.sites.find((s) => s.id === id);
    return snapshot.tanks.map((tk: TankState) => {
      const site = siteOf(tk.siteId);
      const rate = linearRegressionRate(tk.history ?? []);
      const pct = tk.capacity > 0 ? (tk.current / tk.capacity) * 100 : 0;
      const hoursToDry = rate > 0 ? tk.current / rate : Infinity;
      const hoursToLow = rate > 0 ? Math.max(0, (tk.current - tk.low) / rate) : Infinity;
      const hoursToCritical = rate > 0 ? Math.max(0, (tk.current - tk.critical) / rate) : Infinity;
      let risk: RiskLevel;
      if (rate <= 0) risk = "LOW";
      else if (hoursToCritical < 24) risk = "CRITICAL";
      else if (hoursToCritical < 72) risk = "HIGH";
      else if (hoursToCritical < 168) risk = "MEDIUM";
      else risk = "LOW";
      const dryOutAt = isFinite(hoursToDry) ? Date.now() + hoursToDry * 3600000 : null;
      return {
        id: tk.id,
        siteId: tk.siteId,
        site: site?.name ?? "—",
        tank: tk.label,
        current: tk.current,
        capacity: tk.capacity,
        pct,
        rate,
        hoursToLow,
        hoursToCritical,
        hoursToDry,
        dryOutAt,
        risk,
      };
    }).sort((a, b) => {
      if (RISK_ORDER[a.risk] !== RISK_ORDER[b.risk]) {
        return RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
      }
      return a.hoursToCritical - b.hoursToCritical;
    });
  }, [snapshot]);

  if (!snapshot) return null;

  const critical = rows.filter((r) => r.risk === "CRITICAL");
  const high = rows.filter((r) => r.risk === "HIGH");
  const refuelNeeded72h = rows.filter((r) => isFinite(r.hoursToCritical) && r.hoursToCritical < 72);
  const dryOutsDays = rows
    .filter((r) => isFinite(r.hoursToDry))
    .map((r) => r.hoursToDry / 24);
  const avgDryOutDays = dryOutsDays.length
    ? dryOutsDays.reduce((a, b) => a + b, 0) / dryOutsDays.length
    : 0;

  // 7-day level projection for top 5 critical/high tanks
  const topRiskTanks = rows
    .filter((r) => r.risk === "CRITICAL" || r.risk === "HIGH")
    .slice(0, 5);
  const chartData: Array<Record<string, number | string>> = Array.from({ length: 8 }, (_, i) => {
    const point: Record<string, number | string> = { day: `D+${i}` };
    for (const r of topRiskTanks) {
      const projected = r.rate > 0
        ? Math.max(0, Math.round(r.current - r.rate * 24 * i))
        : Math.round(r.current);
      point[r.id] = projected;
    }
    return point;
  });
  const LINE_STROKES = [cc.rose, "#fb7185", cc.amber, "#fbbf24", cc.emerald];

  // Risk distribution bar chart
  const riskDist: Array<{ name: RiskLevel; count: number; risk: RiskLevel }> =
    (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as RiskLevel[]).map((r) => ({
      name: r,
      count: rows.filter((x) => x.risk === r).length,
      risk: r,
    }));
  const RISK_BAR_COLOR: Record<RiskLevel, string> = {
    CRITICAL: cc.rose,
    HIGH: "#fb7185",
    MEDIUM: cc.amber,
    LOW: cc.emerald,
  };

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.fuel-forecast")}
        description={t("desc.fuel-forecast")}
        icon={<Brain className="h-5 w-5" />}
        tone="amber"
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
        <KpiCard
          label="Critical Risk"
          value={formatNumber(critical.length, numLang)}
          icon={<AlertOctagon className="h-4 w-4" />}
          tone="danger"
          hint="< 24h to critical"
        />
        <KpiCard
          label="High Risk"
          value={formatNumber(high.length, numLang)}
          icon={<AlertTriangle className="h-4 w-4" />}
          tone="warn"
          hint="< 72h to critical"
        />
        <KpiCard
          label="Refuel Needed 72h"
          value={formatNumber(refuelNeeded72h.length, numLang)}
          icon={<PackagePlus className="h-4 w-4" />}
          tone={refuelNeeded72h.length ? "warn" : "good"}
          hint="Tanks needing action"
        />
        <KpiCard
          label="Avg Dry-Out"
          value={isFinite(avgDryOutDays) && avgDryOutDays > 0
            ? formatNumber(avgDryOutDays.toFixed(1), numLang)
            : "—"}
          unit={isFinite(avgDryOutDays) && avgDryOutDays > 0 ? "d" : undefined}
          icon={<Clock className="h-4 w-4" />}
          tone="info"
          hint="Across consuming tanks"
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingDown className="h-4 w-4 text-rose-500" />
              7-Day Level Projection — Top Risk Tanks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topRiskTanks.length === 0 ? (
              <p className="py-12 text-center text-xs text-muted-foreground">
                No critical or high-risk tanks currently.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                  <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                  <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: any) => [`${formatNumber(Number(v).toLocaleString(), numLang)} L`, ""]} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  {topRiskTanks.map((r, i) => (
                    <Line
                      key={r.id}
                      type="monotone"
                      dataKey={r.id}
                      stroke={LINE_STROKES[i % LINE_STROKES.length]}
                      strokeWidth={2}
                      dot={false}
                      name={r.tank}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4 text-amber-500" />
              Tank Risk Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={riskDist} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v: any) => [`${formatNumber(Number(v), numLang)}`, "Tanks"]} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} name="Tanks">
                  {riskDist.map((d) => (
                    <Cell key={d.risk} fill={RISK_BAR_COLOR[d.risk]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Forecast table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Tank Refuel Forecast ({formatNumber(rows.length, numLang)})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[560px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="min-w-[140px]">Site</TableHead>
                  <TableHead className="min-w-[120px]">Tank</TableHead>
                  <TableHead className="text-right">Current (L)</TableHead>
                  <TableHead className="text-right">Capacity (L)</TableHead>
                  <TableHead className="text-right">%</TableHead>
                  <TableHead className="text-right">Rate (L/h)</TableHead>
                  <TableHead className="text-right">Hrs → Low</TableHead>
                  <TableHead className="text-right">Hrs → Critical</TableHead>
                  <TableHead className="text-right">Hrs → Dry</TableHead>
                  <TableHead className="min-w-[140px]">Dry-Out Date</TableHead>
                  <TableHead className="text-center">Risk</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const rc = RISK_COLORS[r.risk];
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{r.site}</TableCell>
                      <TableCell className="text-xs font-medium">{r.tank}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtLitres(r.current, numLang)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtLitres(r.capacity, numLang)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        <span className={r.pct <= 12 ? "text-rose-600 dark:text-rose-400" : r.pct <= 25 ? "text-amber-600 dark:text-amber-400" : ""}>
                          {formatNumber(r.pct.toFixed(1), numLang)}%
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.rate > 0 ? formatNumber(r.rate.toFixed(1), numLang) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtHours(r.hoursToLow, numLang)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums font-medium">{fmtHours(r.hoursToCritical, numLang)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{fmtHours(r.hoursToDry, numLang)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.dryOutAt ? fmtDateTime(r.dryOutAt, numLang) : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline" className={`${rc.bg} ${rc.text} ${rc.border} text-[10px] font-semibold`}>
                          {r.risk}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {(r.risk === "CRITICAL" || r.risk === "HIGH") && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() => setView("inventory")}
                          >
                            <PackagePlus className="mr-1 h-3 w-3" /> Create Delivery
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={12} className="py-8 text-center text-xs text-muted-foreground">
                      No tank data available.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
