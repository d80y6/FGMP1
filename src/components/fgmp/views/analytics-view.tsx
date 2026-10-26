"use client";

import { TrendingUp, TrendingDown, Activity, AlertTriangle, Brain, Gauge as GaugeIcon, Map as MapIcon, DollarSign, Wallet } from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Scatter, ScatterChart, ZAxis,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi } from "@/lib/fgmp/use-api";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import { TruncationNote } from "@/components/fgmp/truncation-note";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { AnalyticsPayload } from "@/lib/fgmp/types";
import { DecorativeChart } from "@/components/fgmp/decorative-chart";

/**
 * Render a currency figure that is null when no FX rate is configured.
 *
 * Deliberately NOT "$0.00": a nil total would read as "no loss", which is a
 * claim the data does not support. A dash states that we declined to convert.
 */
function formatUsd(
  value: number | null | undefined,
  numLang: Language,
  opts: { scale?: number; suffix?: string } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const v = opts.scale ? value / opts.scale : value;
  return `$${formatNumber(v.toFixed(opts.scale ? 1 : 2), numLang)}${opts.suffix ?? ""}`;
}

/**
 * What a currency chart shows when no rate is configured.
 *
 * The section note above claims a zeroed chart is never drawn — these two were
 * the exception: the donut coalesced null USD values to 0 and rendered
 * "$0 consumed / $0 stolen / $0 delivered", and the regional bar chart drew an
 * axis of $0k. Both state a measurement the platform does not have, which is the
 * one thing the dash in the KPI cards exists to avoid.
 */
function NoCurrencyNotice() {
  const t = useT();
  return (
    <p className="flex h-[200px] items-center justify-center px-6 text-center text-[11px] leading-relaxed text-muted-foreground">
      {t("analytics.noFxRateConfigured")}
    </p>
  );
}

export function AnalyticsView() {
  const snapshot = useFgmp((s) => s.snapshot);
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { data: a } = useApi<AnalyticsPayload>("/api/fgmp/analytics?projection=analytics", { interval: 15000 });
  const cc = useChartColors();

  if (!snapshot) return null;
  const consumption = a?.consumptionTrend ?? [];
  const efficiency = a?.siteEfficiency ?? [];
  const theftEvents = a?.theftEvents ?? [];
  const forecast = a?.forecast ?? [];
  const regions = a?.regionBreakdown ?? [];

  const totalConsumed = consumption.reduce((s: number, c) => s + c.litres, 0);
  const totalRunning = consumption.reduce((s: number, c) => s + c.running, 0);
  const avgEfficiency = efficiency.length ? (efficiency.reduce((s: number, e) => s + e.efficiency, 0) / efficiency.length) : 0;
  const topConsumers = [...efficiency].sort((x, y) => y.consumed - x.consumed).slice(0, 10);

  // anomaly scatter: consumed vs kwh
  const scatterData = efficiency.map((e) => ({ x: e.kwh, y: e.consumed, name: e.site, z: 1 }));

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.analytics")}
        description={t("desc.analytics")}
        icon={<TrendingUp className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("analytics.consumed24h")} value={`${formatNumber((totalConsumed / 1000).toFixed(1), numLang)}k`} unit="L" icon={<TrendingDown className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("analytics.genHours24h")} value={`${formatNumber(totalRunning.toFixed(1), numLang)}h`} icon={<Activity className="h-4 w-4" />} tone="good" />
        <KpiCard label={t("analytics.avgEfficiency")} value={`${formatNumber(avgEfficiency.toFixed(2), numLang)}`} unit="L/kWh" icon={<GaugeIcon className="h-4 w-4" />} tone={avgEfficiency > 0.4 ? "warn" : "good"} />
        <KpiCard label={t("analytics.theftEvents")} value={formatNumber(theftEvents.length, numLang)} icon={<AlertTriangle className="h-4 w-4" />} tone={theftEvents.length ? "danger" : "good"} />
        <KpiCard label={t("analytics.sitesAnalyzed")} value={formatNumber(efficiency.length, numLang)} icon={<MapIcon className="h-4 w-4" />} />
        <KpiCard label={t("analytics.forecast7d")} value={`${formatNumber((forecast.reduce((s: number, f) => s + f.litres, 0) / 1000).toFixed(1), numLang)}k`} unit="L" icon={<Brain className="h-4 w-4" />} tone="info" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-emerald-500" /> {t("analytics.consumptionRuntime")}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart tabIndex={-1} data={consumption} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <defs>
                  <linearGradient id="a-cons" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={cc.emerald} stopOpacity={0.4} /><stop offset="100%" stopColor={cc.emerald} stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} interval={3} />
                <YAxis yAxisId="l" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Area yAxisId="l" type="monotone" dataKey="litres" stroke={cc.emerald} strokeWidth={2} fill="url(#a-cons)" name="Litres" />
                <Line yAxisId="r" type="monotone" dataKey="running" stroke={cc.sky} strokeWidth={2} name="Gen hours" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Brain className="h-4 w-4 text-amber-500" /> {t("analytics.forecast7dTitle")}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart tabIndex={-1} data={forecast} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="litres" radius={[4, 4, 0, 0]}>
                  {forecast.map((_f, i: number) => <Cell key={i} fill={cc.amber} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><GaugeIcon className="h-4 w-4 text-sky-500" /> {t("analytics.topConsumers")}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart tabIndex={-1} data={topConsumers} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <YAxis type="category" dataKey="site" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} width={120} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="consumed" radius={[0, 4, 4, 0]} name={t("fuel.litresConsumed")}>
                  {topConsumers.map((e, i: number) => <Cell key={i} fill={e.efficiency > 0.45 ? cc.rose : e.efficiency > 0.35 ? cc.amber : cc.emerald} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-rose-500" /> {t("analytics.anomalyDetection")}</CardTitle></CardHeader>
          <CardContent>
            {/* Scatter points are role="img" with no name, one per point (52 on
                this tenant data). The series has no text equivalent, so unlike
                the doughnuts the graphic is NAMED rather than dropped. */}
            <DecorativeChart label={t("analytics.anomalyChartLabel")}>
            <ResponsiveContainer width="100%" height={260}>
              <ScatterChart tabIndex={-1} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} />
                <XAxis type="number" dataKey="x" name="kWh" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} label={{ value: "kWh", position: "insideBottom", offset: -2, fontSize: 9 }} />
                <YAxis type="number" dataKey="y" name="Litres" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} />
                <ZAxis type="number" dataKey="z" range={[40, 40]} />
                <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number, n: string) => [v, n === "y" ? "Litres" : "kWh"]} labelFormatter={() => ""} />
                <Scatter data={scatterData} fill={cc.sky} />
              </ScatterChart>
            </ResponsiveContainer>
            </DecorativeChart>
            <p className="px-2 text-[10px] text-muted-foreground">{t("analytics.anomalyNote")}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingDown className="h-4 w-4 text-rose-500" /> {t("analytics.theftPattern")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <ScrollArea className="h-[220px]">
              <div className="space-y-1.5">
                {theftEvents.slice(0, 20).map((e, i: number) => (
                  <div key={i} className="flex items-start gap-2 rounded border border-rose-500/20 bg-rose-500/5 p-2 text-[11px]">
                    <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px] border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400">{t("fuel.theft")}</Badge>
                    <div className="min-w-0 flex-1"><p className="line-clamp-2">{e.message}</p><p className="text-[10px] text-muted-foreground">{timeAgo(e.ts, numLang)}</p></div>
                  </div>
                ))}
                {theftEvents.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">{t("analytics.noTheftEvents")}</p>}
                <TruncationNote shown={20} total={theftEvents.length} />
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><MapIcon className="h-4 w-4 text-emerald-500" /> {t("analytics.regionPerformance")}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart tabIndex={-1} data={regions} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="region" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} interval={0} angle={-12} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="fuel" name="Fuel (L)" radius={[4, 4, 0, 0]} fill={cc.sky} />
                <Bar dataKey="alarms" name="Alarms" radius={[4, 4, 0, 0]} fill={cc.rose} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Fuel Cost Analytics Section */}
      {a?.fuelCost && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-emerald-500" />
            <h2 className="text-base font-semibold">{t("analytics.fuelCostTitle")}</h2>
            <Badge variant="outline" className="text-[10px]">
              {formatUsd(a.fuelCost.pricePerLitre, numLang)}/L
            </Badge>
          </div>

          {/* ── Why the currency figures are dashes ───────────────────────────
              Litres are measured; USD is converted. With no rate configured the
              conversion is not performed, so the currency KPIs below show "—".
              Saying so explicitly stops a dash reading as "$0 lost". */}
          {a.fuelCost.currencyAvailable === false ? (
            <p className="text-xs text-muted-foreground border-s-2 border-amber-500/60 ps-2">
              {t("analytics.noFxRateConfigured")}{" "}
              {/* No opacity: 70% of muted-foreground on the card measures
                  ~2.7:1. The parenthetical is already secondary by wording. */}
              <span>
                ({(a.fuelCost.theftLitres ?? 0).toLocaleString(numLang)} L detected)
              </span>
            </p>
          ) : a.fuelCost.fxAsOf ? (
            <p className="text-xs text-muted-foreground">
              {t("analytics.fxRateAsOf")}: {a.fuelCost.fxAsOf}
            </p>
          ) : null}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
            <KpiCard
              label={t("analytics.consumedToday")}
              value={formatUsd(a.fuelCost.consumedTodayUsd, numLang, { scale: 1000, suffix: "k" })}
              icon={<TrendingDown className="h-4 w-4" />}
              tone="info"
              hint={`${formatNumber((totalConsumed).toLocaleString(), numLang)} L ${t("analytics.consumedToday").toLowerCase()}`}
            />
            <KpiCard
              label={t("analytics.stolenValue")}
              value={formatUsd(a.fuelCost.stolenValueUsd, numLang)}
              icon={<AlertTriangle className="h-4 w-4" />}
              tone="danger"
              hint={`${formatNumber(a.fuelCost.theftLitres.toLocaleString(), numLang)} L ${t("analytics.stolen").toLowerCase()}`}
            />
            <KpiCard
              label={t("analytics.deliveredValue")}
              value={formatUsd(a.fuelCost.deliveredValueUsd, numLang, { scale: 1000, suffix: "k" })}
              icon={<DollarSign className="h-4 w-4" />}
              tone="good"
              hint={t("inventory.verified")}
            />
            <KpiCard
              label={t("analytics.forecastCost")}
              value={formatUsd(a.fuelCost.forecastCostUsd, numLang, { scale: 1000, suffix: "k" })}
              icon={<Brain className="h-4 w-4" />}
              tone="warn"
              hint={t("analytics.forecast7dTitle")}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Cost by Region */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <MapIcon className="h-4 w-4 text-sky-500" /> {t("analytics.fuelCostByRegion")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {a.fuelCost.currencyAvailable === false ? (
                  <NoCurrencyNotice />
                ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart tabIndex={-1}
                    data={a.fuelCost.costByRegion}
                    layout="vertical"
                    margin={{ top: 5, right: 20, left: 20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="cost-grad" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor={cc.emerald} stopOpacity={0.8} />
                        <stop offset="100%" stopColor={cc.emerald} stopOpacity={0.6} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="region" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} width={110} />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(v: number) => [`$${formatNumber(Number(v).toLocaleString(), numLang)}`, "Fuel Value"]}
                    />
                    <Bar dataKey="costUsd" radius={[0, 4, 4, 0]} fill="url(#cost-grad)" name="Fuel Value" />
                  </BarChart>
                </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Cost composition donut */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <DollarSign className="h-4 w-4 text-emerald-500" /> {t("analytics.costComposition")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {a.fuelCost.currencyAvailable === false ? (
                  <NoCurrencyNotice />
                ) : (() => {
                  // Reached only when a rate exists, so these are real USD.
                  const consumed = a.fuelCost.consumedTodayUsd ?? 0;
                  const stolen = a.fuelCost.stolenValueUsd ?? 0;
                  const delivered = a.fuelCost.deliveredValueUsd ?? 0;
                  const total = consumed + stolen + delivered || 1;
                  const data = [
                    { name: t("analytics.consumed"), value: consumed, fill: cc.sky },
                    { name: t("analytics.stolen"), value: stolen, fill: cc.rose },
                    { name: t("analytics.delivered"), value: delivered, fill: cc.emerald },
                  ];
                  return (
                    <>
                      <DecorativeChart>
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart tabIndex={-1}>
                            <Pie
                              data={data}
                              dataKey="value"
                              nameKey="name"
                              cx="50%"
                              cy="50%"
                              innerRadius={50}
                              outerRadius={80}
                              paddingAngle={3}
                            >
                              {data.map((e, i) => <Cell key={i} fill={e.fill} />)}
                            </Pie>
                            <Tooltip
                              contentStyle={{ fontSize: 12 }}
                              formatter={(v: number, n: string) => [`$${formatNumber(Number(v).toLocaleString(), numLang)}`, n]}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </DecorativeChart>
                      <div className="mt-2 space-y-1.5">
                        {data.map((d) => (
                          <div key={d.name} className="flex items-center justify-between text-xs">
                            <span className="flex items-center gap-1.5">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.fill }} />
                              {d.name}
                            </span>
                            <span className="font-medium tabular-nums">
                              ${formatNumber(d.value.toLocaleString(), numLang)}
                              <span className="ms-1 text-[10px] text-muted-foreground">
                                ({formatNumber(((d.value / total) * 100).toFixed(1), numLang)}%)
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
