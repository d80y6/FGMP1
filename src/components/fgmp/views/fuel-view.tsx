"use client";

import { useMemo, useState } from "react";
import { Droplet, Search, AlertTriangle, TrendingDown, TrendingUp, Download } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi } from "@/lib/fgmp/use-api";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import { TruncationNote } from "@/components/fgmp/truncation-note";
import { SectionHeader } from "@/components/fgmp/section-header";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { BarGauge, Gauge } from "@/components/fgmp/gauge";
import { StatusBadge } from "@/components/fgmp/status-badge";
import { EmptyState } from "@/components/fgmp/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/fgmp/sparkline";
import { FuelDeliveryTracking } from "@/components/fgmp/fuel-delivery-tracking";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtLitres, timeAgo } from "@/lib/fgmp/format";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { EventItem } from "@/lib/fgmp/types";
import type { AnalyticsPayload } from "@/lib/fgmp/types";
import { DecorativeChart } from "@/components/fgmp/decorative-chart";

export function FuelView() {
  const snapshot = useFgmp((s) => s.snapshot);
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("pct-asc");
  const { data: analytics, loading: analyticsLoading } = useApi<AnalyticsPayload>("/api/fgmp/analytics?projection=fuel", { interval: 15000 });
  // Selected label for the sort trigger's tooltip (the visible value can be
  // clipped by the fixed trigger width, especially in Arabic).
  const SORT_LABEL: Record<string, string> = {
    "pct-asc": t("fuel.sortLowHigh"),
    "pct-desc": t("fuel.sortHighLow"),
    capacity: t("fuel.sortCapacity"),
    site: t("fuel.sortSite"),
  };
  const cc = useChartColors();

  const tanks = useMemo(() => {
    if (!snapshot) return [];
    const siteOf = (id: string) => snapshot.sites.find((s) => s.id === id);
    let list = snapshot.tanks.map((t) => {
      const site = siteOf(t.siteId);
      const pct = (t.current / t.capacity) * 100;
      return { ...t, site: site?.name ?? "—", code: site?.code ?? "", region: site?.region ?? "", pct };
    });
    if (q) list = list.filter((t) => `${t.label} ${t.site} ${t.code}`.toLowerCase().includes(q.toLowerCase()));
    list.sort((a, b) => {
      if (sort === "pct-asc") return a.pct - b.pct;
      if (sort === "pct-desc") return b.pct - a.pct;
      if (sort === "capacity") return b.capacity - a.capacity;
      return a.site.localeCompare(b.site);
    });
    return list;
  }, [snapshot, q, sort]);

  // Fill-percentage distribution for the donut (proposal §8.3,
  // Figure 12 — "المخطط الدائري لنسب الامتلاء"): tanks grouped
  // into the five bands the platform already alarms on.
  // NB: declared BEFORE the `if (!snapshot) return null` guard so
  // the hook order stays stable across loading/loaded renders.
  const fillBands = useMemo(() => {
    const bands = [
      { key: "fuel.bandCritical", min: 0, max: 12, color: "#f43f5e" },
      { key: "fuel.bandLow", min: 12, max: 25, color: "#f59e0b" },
      { key: "fuel.bandAdequate", min: 25, max: 60, color: "#0ea5e9" },
      { key: "fuel.bandHigh", min: 60, max: 85, color: "#10b981" },
      { key: "fuel.bandFull", min: 85, max: 101, color: "#059669" },
    ];
    return bands
      .map((b) => ({
        ...b,
        name: t(b.key),
        value: tanks.filter((tk) => tk.pct >= b.min && tk.pct < b.max).length,
      }))
      .filter((b) => b.value > 0);
  }, [tanks, t]);

  if (!snapshot) return null;
  const k = snapshot.kpis;
  const critical = tanks.filter((t) => t.pct <= 12);
  const low = tanks.filter((t) => t.pct > 12 && t.pct <= 25);
  const refillPlan = tanks.filter((t) => t.pct <= 30).sort((a, b) => a.pct - b.pct).slice(0, 8);
  const theftEvents = analytics?.theftEvents ?? [];
  const refillEvents = analytics?.refillEvents ?? [];
  const avgPct = tanks.length ? Math.round(tanks.reduce((a, t) => a + t.pct, 0) / tanks.length) : 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("nav.fuel")}
        description={t("desc.fuel")}
        icon={<Droplet className="h-5 w-5" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => window.open("/api/fgmp/export?type=tanks", "_blank")}>
            <Download className="me-1.5 h-4 w-4" /> {t("common.export")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("fuel.totalFuel")} value={`${formatNumber((k.totalFuelLitres / 1000).toFixed(1), numLang)}k`} unit="L" icon={<Droplet className="h-4 w-4" />} tone="info" hint={`${formatNumber(k.fuelPct, numLang)}% ${t("fuel.ofCapacity")}`} />
        <KpiCard label={t("fuel.avgLevel")} value={`${formatNumber(avgPct, numLang)}%`} icon={<TrendingUp className="h-4 w-4" />} tone={avgPct < 25 ? "danger" : "good"} />
        <KpiCard label={t("fuel.critical")} value={formatNumber(critical.length, numLang)} icon={<AlertTriangle className="h-4 w-4" />} tone={critical.length ? "danger" : "good"} />
        <KpiCard label={t("fuel.low")} value={formatNumber(low.length, numLang)} icon={<AlertTriangle className="h-4 w-4" />} tone={low.length ? "warn" : "good"} />
        <KpiCard label={t("fuel.consumed24h")} value={fmtLitres(k.fuelConsumedTodayL, numLang)} icon={<TrendingDown className="h-4 w-4" />} tone="info" />
        <KpiCard label={t("fuel.tanks")} value={formatNumber(tanks.length, numLang)} icon={<Droplet className="h-4 w-4" />} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* National fuel gauge + consumption */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("fuel.nationalInventory")}</CardTitle></CardHeader>
          <CardContent className="flex flex-col items-center pt-2">
            <Gauge value={k.fuelPct} size={180} label={`${fmtLitres(k.totalFuelLitres, numLang)}`} sublabel={`${t("fuel.ofCapacity")} ${fmtLitres(k.totalFuelCapacity, numLang)}`} />
          </CardContent>
        </Card>

        {/* Fill-percentage donut (proposal §8.3, Figure 12) */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("fuel.fillDistribution")}</CardTitle></CardHeader>
          <CardContent>
            {fillBands.length === 0 ? (
              <EmptyState icon={Droplet} title={t("fuel.noTanks")} />
            ) : (
              <DecorativeChart>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart tabIndex={-1}>
                    <Pie
                      data={fillBands}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={2}
                      strokeWidth={0}
                    >
                      {fillBands.map((b) => (
                        <Cell key={b.key} fill={b.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(v: number, name: string) => [formatNumber(v, numLang), name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </DecorativeChart>
            )}
            <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 pt-1">
              {fillBands.map((b) => (
                <span key={b.key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: b.color }} />
                  {b.name} · {formatNumber(b.value, numLang)}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("fuel.nationalConsumption")}</CardTitle></CardHeader>
          <CardContent>
            {analyticsLoading && !analytics ? (
              <Skeleton className="h-[200px] w-full" />
            ) : (analytics?.consumptionTrend ?? []).length === 0 ? (
              <EmptyState
                icon={TrendingUp}
                title={t("common.noDataInRange")}
                description={t("common.noDataInRangeHint")}
                compact
              />
            ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart tabIndex={-1} data={analytics?.consumptionTrend ?? []} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="fuel-cons" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={cc.sky} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={cc.sky} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} interval={3} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="litres" stroke={cc.sky} strokeWidth={2} fill="url(#fuel-cons)" name={t("fuel.litresConsumed")} />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Refill planning + theft/refill events */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-amber-500" /> {t("fuel.refillPlanning")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <div className="space-y-2">
              {refillPlan.map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" title={`${t.site} · ${t.label}`}>{t.site} · {t.label}</p>
                    <div className="mt-1"><BarGauge value={t.pct} /></div>
                  </div>
                  <div className="text-end text-[11px]">
                    <p className="font-bold tabular-nums">{formatNumber(Math.round(t.pct), numLang)}%</p>
                    <p className="text-muted-foreground">{fmtLitres(t.current, numLang)}</p>
                  </div>
                </div>
              ))}
              {refillPlan.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">{t("fuel.noTanksNeedRefill")}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingDown className="h-4 w-4 text-rose-500" /> {t("fuel.theftDetection")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <ScrollList events={theftEvents} empty={t("fuel.noTheftEvents")} tone="rose" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-emerald-500" /> {t("fuel.refillEvents")}</CardTitle></CardHeader>
          <CardContent className="p-3">
            <ScrollList events={refillEvents} empty={t("fuel.noUnexpectedRefills")} tone="emerald" />
          </CardContent>
        </Card>
      </div>

      {/* Fuel delivery tracking — pipeline, active timeline, completions, 7d chart */}
      <FuelDeliveryTracking />

      {/* Tank list */}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="text-sm">{t("fuel.tankInventory")} ({formatNumber(tanks.length, numLang)})</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              {/* The filter row must wrap, not overflow: at 390px a 200px
                  search plus a 186px select ran past the card's right edge and
                  the sort control became unreachable (D-31). */}
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("fuel.searchTanks")} className="h-9 w-[168px] pl-8 sm:w-[200px]" />
            </div>
            <Select label={t("fuel.sortBy")} value={sort} onValueChange={setSort}>
              {/* Width fits the longest option in either language; the title
                  carries the full value when a translation still overflows
                  (a nowrap trigger clips silently otherwise — D-31). */}
              <SelectTrigger className="h-9 w-[132px] sm:w-[186px]" title={SORT_LABEL[sort]}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pct-asc">{t("fuel.sortLowHigh")}</SelectItem>
                <SelectItem value="pct-desc">{t("fuel.sortHighLow")}</SelectItem>
                <SelectItem value="capacity">{t("fuel.sortCapacity")}</SelectItem>
                <SelectItem value="site">{t("fuel.sortSite")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {tanks.slice(0, 60).map((t) => (
              <div key={t.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{t.label}</p>
                    <p className="truncate text-[10px] text-muted-foreground" title={`${t.code} · ${t.site}`}>{t.code} · {t.site}</p>
                  </div>
                  <StatusBadge value={t.status} className="h-5 text-[10px]" />
                </div>
                <div className="mt-2"><BarGauge value={t.pct} showLabel /></div>
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{fmtLitres(t.current, numLang)} / {fmtLitres(t.capacity, numLang)}</span>
                  <Sparkline data={t.history?.slice(-40).map((h) => h.l) ?? []} width={70} height={18} color={t.pct <= 12 ? cc.rose : (t.pct <= 25 ? cc.amber : cc.emerald)} />
                </div>
              </div>
            ))}
            {tanks.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">{t("common.noneYet")}</p>
            )}
          </div>
          <TruncationNote shown={60} total={tanks.length} />
        </CardContent>
      </Card>
    </div>
  );
}

function ScrollList({ events, empty, tone }: { events: EventItem[]; empty: string; tone: "rose" | "emerald" }) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  return (
    <div className="max-h-64 space-y-1.5 overflow-y-auto pe-1">
      {events.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">{empty}</p>}
      {events.map((e, i) => (
        <div key={i} className="flex items-start gap-2 rounded border p-2 text-[11px]">
          <Badge variant="outline" className={`h-4 shrink-0 px-1 text-[10px] ${tone === "rose" ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"}`}>
            {tone === "rose" ? t("fuel.theft") : t("fuel.refill")}
          </Badge>
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2">{e.message}</p>
            <p className="text-[10px] text-muted-foreground">{timeAgo(e.ts, numLang)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
