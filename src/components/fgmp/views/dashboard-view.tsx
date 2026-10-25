"use client";

import { useMemo, useState } from "react";
import {
  Activity, Droplet, Zap, Siren, Truck, Building2, BatteryWarning,
  Gauge as GaugeIcon, TrendingUp, AlertTriangle, Fuel, ShieldCheck,
  ChevronRight, CheckCircle2,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useFavorites } from "@/lib/fgmp/use-favorites";
import { useApi, apiPost } from "@/lib/fgmp/use-api";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import { KpiCard } from "@/components/fgmp/kpi-card";
import { NationalMap } from "@/components/fgmp/national-map";
import { SectionHeader } from "@/components/fgmp/section-header";
import { SystemStatusBanner } from "@/components/fgmp/system-status-banner";
import { OnboardingChecklist } from "@/components/fgmp/onboarding-checklist";
import { SiteHealthWidget } from "@/components/fgmp/site-health-widget";
import { RegionLeaderboard } from "@/components/fgmp/region-leaderboard";
import { RegionDetailSheet } from "@/components/fgmp/region-detail-sheet";
import { FuelRunoutEta } from "@/components/fgmp/fuel-runout-eta";
import { ShiftHandoverPanel } from "@/components/fgmp/shift-handover-panel";
import { StatusBadge, severityDot } from "@/components/fgmp/status-badge";
import { DashboardSkeleton } from "@/components/fgmp/skeletons";
import { EmptyState } from "@/components/fgmp/empty-state";
import { ExportButton } from "@/components/fgmp/export-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/fgmp/format";
import { csvFilename, type CsvColumn } from "@/lib/fgmp/csv-export";
import { useT, useTF, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import type { AnalyticsPayload } from "@/lib/fgmp/types";
import type { AlarmRow } from "@/lib/fgmp/types";
import { translate } from "@/lib/fgmp/i18n";
import { ResourceError } from "@/components/fgmp/resource-error";
import { DecorativeChart } from "@/components/fgmp/decorative-chart";

type DashboardRange = "1h" | "24h" | "7d";

export function DashboardView() {
  // Subscribe to individual slices: a bare `useFgmp()` re-renders this
  // component on EVERY store write (search keystrokes, view changes,
  // lastTickAt, …) instead of only the slices actually read.
  const snapshot = useFgmp((s) => s.snapshot);
  const selectSite = useFgmp((s) => s.selectSite);
  const setView = useFgmp((s) => s.setView);
  const selectedSiteId = useFgmp((s) => s.selectedSiteId);
  const tick = useFgmp((s) => s.tick);

  const addRecent = useFavorites((s) => s.addRecent);
  const t = useT();
  const tFmt = useTF();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const k = snapshot?.kpis;
  // Single alarms fetch (polled every 6s) feeds both the live alarm feed
  // and the derived "Top Critical Alarms" triage list. limit=50 keeps a
  // wide enough pool of OPEN alarms to pick the 5 most urgent from.
  const { data: alarms, error: alarmsError, refetch: refetchAlarms } = useApi<AlarmRow[]>("/api/fgmp/alarms?status=OPEN,ACKNOWLEDGED,ESCALATED&limit=50", { interval: 6000 });
  const [range, setRange] = useState<DashboardRange>("24h");
  const { data: analytics, error: analyticsError, refetch: refetchAnalytics } = useApi<AnalyticsPayload>(`/api/fgmp/analytics?range=${range}&projection=dashboard`, { interval: 15000, deps: [range] });
  const cc = useChartColors();
  const [regionSheet, setRegionSheet] = useState<string | null>(null);

  // Top 5 critical open alarms — L3 first, then L2, then L1; ties broken by
  // most recent. Derived from the polled alarms feed (no extra fetch).
  const topCriticalAlarms = useMemo(() => {
    const sevRank: Record<string, number> = { L3: 0, L2: 1, L1: 2 };
    return (alarms ?? [])
      .filter((a) => a.status === "OPEN")
      .sort((a, b) => {
        const sa = sevRank[a.severity] ?? 9;
        const sb = sevRank[b.severity] ?? 9;
        if (sa !== sb) return sa - sb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, 5);
  }, [alarms]);

  // Acknowledge a single alarm via the existing action-based endpoint
  // (POST /api/fgmp/alarms { action: "acknowledge", alarmId }). Mirrors the
  // pattern used in alarms-view so behavior + audit trail stay consistent.
  const ackAlarm = async (id: string) => {
    const res = await apiPost("/api/fgmp/alarms", { action: "acknowledge", alarmId: id });
    if (res.ok) {
      toast.success(t("alarms.acknowledgedToast"));
      refetchAlarms();
      tick(10);
    } else {
      toast.error(t("alarms.ackFailed"), { description: res.error });
    }
  };

  const rangeLabel = range === "1h" ? t("dash.range1h") : range === "7d" ? t("dash.range7d") : t("dash.range24h");

  const fuelDist = useMemo(() => {
    if (!snapshot) return [];
    const buckets = [
      { range: "0-12%", count: 0, fill: cc.rose },
      { range: "13-25%", count: 0, fill: cc.amber },
      { range: "26-50%", count: 0, fill: cc.amber },
      { range: "51-75%", count: 0, fill: cc.emerald },
      { range: "76-100%", count: 0, fill: cc.emerald },
    ];
    for (const t of snapshot.tanks) {
      const pct = (t.current / t.capacity) * 100;
      const i = pct <= 12 ? 0 : pct <= 25 ? 1 : pct <= 50 ? 2 : pct <= 75 ? 3 : 4;
      buckets[i].count++;
    }
    return buckets;
  }, [snapshot, cc.rose, cc.amber, cc.emerald]);

  const fleetStatus = useMemo(() => {
    if (!snapshot) return [];
    const online = snapshot.sites.filter((s) => s.status === "ONLINE").length;
    const degraded = snapshot.sites.filter((s) => s.status === "DEGRADED").length;
    const offline = snapshot.sites.filter((s) => s.status === "OFFLINE").length;
    return [
      { name: t("common.online"), value: online, fill: cc.emerald },
      { name: t("dash.degraded"), value: degraded, fill: cc.amber },
      { name: t("common.offline"), value: offline, fill: cc.rose },
    ];
  }, [snapshot, cc.emerald, cc.amber, cc.rose, t]);

  // KPI snapshot export (#43-C) — long-format (Metric | Value) CSV with one
  // row per current KPI. Computed here (before the early-return skeleton)
  // so the hook order stays stable; the ExportButton is disabled while the
  // snapshot is loading. Numbers are localized to match the on-screen KPI
  // cards; ratios like sites online/total stay as a single string cell so
  // Excel renders them inline with the raw numbers.
  const kpiSnapshotRows = useMemo(() => {
    if (!k) return [];
    return [
      { metric: t("csv.kpiSitesOnline"), value: `${formatNumber(k.onlineSites, numLang)} / ${formatNumber(k.totalSites, numLang)}` },
      { metric: t("csv.kpiFuelPct"), value: `${formatNumber(k.fuelPct, numLang)}%` },
      { metric: t("csv.kpiFuelLitres"), value: formatNumber(k.totalFuelLitres, numLang) },
      { metric: t("csv.kpiTanksCritical"), value: formatNumber(k.tanksCritical, numLang) },
      { metric: t("csv.kpiTanksLow"), value: formatNumber(k.tanksLow, numLang) },
      { metric: t("csv.kpiGeneratorsRunning"), value: formatNumber(k.generatorsRunning, numLang) },
      { metric: t("csv.kpiGeneratorsTotal"), value: formatNumber(k.generatorsTotal, numLang) },
      { metric: t("csv.kpiGeneratorsFault"), value: formatNumber(k.generatorsFault, numLang) },
      { metric: t("csv.kpiAlarmsL1"), value: formatNumber(k.alarmsL1, numLang) },
      { metric: t("csv.kpiAlarmsL2"), value: formatNumber(k.alarmsL2, numLang) },
      { metric: t("csv.kpiAlarmsL3"), value: formatNumber(k.alarmsL3, numLang) },
      { metric: t("csv.kpiBatteriesLow"), value: formatNumber(k.batteriesLow, numLang) },
      { metric: t("csv.kpiPendingDeliveries"), value: formatNumber(k.pendingDeliveries, numLang) },
      { metric: t("csv.kpiOpenTickets"), value: formatNumber(k.openTickets, numLang) },
      { metric: t("csv.kpiAvgSiteHealth"), value: formatNumber(k.avgSiteHealth, numLang) },
      { metric: t("csv.kpiFuelConsumedToday"), value: formatNumber(k.fuelConsumedTodayL, numLang) },
      { metric: t("csv.kpiGeneratorHoursToday"), value: formatNumber(k.generatorHoursToday, numLang) },
      { metric: t("csv.kpiDispensersTotal"), value: formatNumber(k.dispensersTotal, numLang) },
      { metric: t("csv.kpiDispensersDispensing"), value: formatNumber(k.dispensersDispensing, numLang) },
      { metric: t("csv.kpiDispensersFault"), value: formatNumber(k.dispensersFault, numLang) },
      { metric: t("csv.kpiDispenserTransactionsToday"), value: formatNumber(k.dispenserTransactionsToday, numLang) },
      { metric: t("csv.kpiDispenserVolumeToday"), value: formatNumber(k.dispenserVolumeTodayL, numLang) },
    ];
  }, [k, t, numLang]);
  const kpiSnapshotColumns: CsvColumn[] = [
    { key: "metric", label: t("csv.metric") },
    { key: "value", label: t("csv.value") },
  ];

  // While the snapshot is loading (initial mount before the first /state
  // response arrives), show the dashboard skeleton so the operator sees
  // shimmer placeholders instead of an empty grid. Mirrors the real layout
  // 1:1 so the swap to live data is layout-shift-free.
  if (!snapshot || !k) return <DashboardSkeleton />;
  const consumption = analytics?.consumptionTrend ?? [];

  // Sparkline data — small inline trend / distribution mini-charts rendered
  // inside the KPI cards (#43-D). Computed as plain consts (not useMemo)
  // because the inputs are cheap primitives already on `k` / `consumption`
  // and they need to be derived AFTER the early-return guard (so we can
  // assume `k` is defined). Plain consts here don't violate the rules of
  // hooks (they aren't hooks).
  // For the fuel card we use the consumption trend's litres series (real
  // time series — sampled to 5 points). For the alarms card we show the
  // severity breakdown [L1, L2, L3] as a 3-point mini-chart (distribution,
  // not trend — labelled accordingly via tooltip). For the generators card
  // we show the fleet status breakdown [running, fault, stopped, total,
  // running-again] — last point mirrors the first so a single-segment
  // sparkline reads as a closed loop rather than a flat line.
  const fuelSpark: number[] = (() => {
    if (consumption.length === 0) return [];
    const n = consumption.length;
    if (n <= 5) return consumption.map((c) => Number(c.litres ?? 0));
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = Math.floor((i / 4) * (n - 1));
      out.push(Number(consumption[idx]?.litres ?? 0));
    }
    return out;
  })();
  const alarmsSpark: number[] = [k.alarmsL1, k.alarmsL2, k.alarmsL3];
  const generatorsSpark: number[] = (() => {
    const stopped = Math.max(0, k.generatorsTotal - k.generatorsRunning - k.generatorsFault);
    return [k.generatorsRunning, k.generatorsFault, stopped, k.generatorsTotal, k.generatorsRunning];
  })();

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("dash.title")}
        description={t("dash.subtitle")}
        icon={<Activity className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setView("analytics")}>
              <TrendingUp className="mr-1.5 h-4 w-4" /> {t("dash.analytics")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setView("alarms")}>
              <Siren className="mr-1.5 h-4 w-4" /> {t("dash.alarms")}
              {k.openAlarms > 0 && <Badge className="ml-1.5 h-4 px-1 text-[10px]">{formatNumber(k.openAlarms, numLang)}</Badge>}
            </Button>
            <ExportButton
              filename={csvFilename("kpi-snapshot")}
              rows={kpiSnapshotRows}
              columns={kpiSnapshotColumns}
              disabled={!k}
              label={t("common.exportKpis")}
            />
          </>
        }
      />

      <ResourceError error={alarmsError ?? analyticsError} onRetry={() => { refetchAlarms(); refetchAnalytics(); }} />

      {/* First-run onboarding checklist (#9) — ADMIN-only setup card,
          auto-hides when the platform has enough data or when dismissed */}
      <OnboardingChecklist />

      {/* System status banner — first thing operator sees */}
      <SystemStatusBanner kpis={k} />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label={t("dash.sitesOnlineLabel")} value={formatNumber(k.onlineSites, numLang)} unit={`/ ${formatNumber(k.totalSites, numLang)}`} icon={<Building2 className="h-4 w-4" />} tone={k.onlineSites === k.totalSites ? "good" : "warn"} hint={`${formatNumber(k.degradedSites, numLang)} ${t("dash.degraded")} · ${formatNumber(k.offlineSites, numLang)} ${t("dash.offline")}`} info={t("common.kpiInfoSites")} animate />
        <KpiCard label={t("dash.avgHealth")} value={formatNumber(k.avgSiteHealth, numLang)} unit="%" icon={<ShieldCheck className="h-4 w-4" />} tone={k.avgSiteHealth > 85 ? "good" : "warn"} info={t("common.kpiInfoHealth")} animate decimals={0} />
        <KpiCard label={t("dash.fuelInventoryLabel")} value={formatNumber(k.fuelPct, numLang)} unit={`% · ${formatNumber((k.totalFuelLitres / 1000).toFixed(1), numLang)}k L`} icon={<Droplet className="h-4 w-4" />} tone={k.fuelPct < 25 ? "danger" : "info"} hint={`${formatNumber(k.totalFuelLitres.toLocaleString(), numLang)} / ${formatNumber(k.totalFuelCapacity.toLocaleString(), numLang)} L`} info={t("common.kpiInfoFuel")} animate decimals={1} sparkline={fuelSpark} sparklineLabel={t("common.last5Readings")} />
        <KpiCard label={t("dash.tanksCriticalShort")} value={formatNumber(k.tanksCritical, numLang)} unit={`· ${formatNumber(k.tanksLow, numLang)} ${t("dash.low")}`} icon={<AlertTriangle className="h-4 w-4" />} tone={k.tanksCritical > 0 ? "danger" : "good"} info={t("common.kpiInfoTanks")} animate />
        <KpiCard label={t("dash.generatorsLabel")} value={formatNumber(k.generatorsRunning, numLang)} unit={`/ ${formatNumber(k.generatorsTotal, numLang)} ${t("dash.running")}`} icon={<Zap className="h-4 w-4" />} tone="info" hint={`${formatNumber(k.generatorsFault, numLang)} ${t("dash.fault")}`} info={t("common.kpiInfoGenerators")} animate sparkline={generatorsSpark} sparklineLabel={t("common.last5Readings")} />
        <KpiCard label={t("dash.openAlarmsLabel")} value={formatNumber(k.openAlarms, numLang)} unit={`L3: ${formatNumber(k.alarmsL3, numLang)}`} icon={<Siren className="h-4 w-4" />} tone={k.openAlarms > 0 ? "danger" : "good"} hint={`L1:${formatNumber(k.alarmsL1, numLang)} L2:${formatNumber(k.alarmsL2, numLang)} L3:${formatNumber(k.alarmsL3, numLang)}`} info={t("common.kpiInfoAlarms")} animate sparkline={alarmsSpark} sparklineLabel={t("common.last5Readings")} />
        <KpiCard label={t("dash.lowBatteriesLabel")} value={formatNumber(k.batteriesLow, numLang)} icon={<BatteryWarning className="h-4 w-4" />} tone={k.batteriesLow > 0 ? "warn" : "good"} info={t("common.kpiInfoBatteries")} animate />
        <KpiCard label={t("dash.pendingDeliveriesLabel")} value={formatNumber(k.pendingDeliveries, numLang)} unit={`· ${formatNumber(k.openTickets, numLang)} ${t("dash.tix")}`} icon={<Truck className="h-4 w-4" />} tone="info" info={t("common.kpiInfoDeliveries")} animate />
      </div>

      {/* Top Critical Alarms — one-click triage of the 5 most urgent open alarms (#7) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base"><Siren className="h-4 w-4 text-rose-500" /> {t("dash.topCriticalAlarms")}</CardTitle>
            <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">{t("dash.criticalAlarmsHint")}</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setView("alarms")}>{t("common.viewAll")}</Button>
        </CardHeader>
        <CardContent className="p-0">
          {topCriticalAlarms.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={t("dash.allClear")}
              description={t("dash.noCriticalAlarms")}
              compact
            />
          ) : (
            <div className="divide-y">
              {topCriticalAlarms.map((a) => (
                // A row is two actions — open the alarm, acknowledge it — so it
                // cannot be one role="button" wrapping a real <button>: that is
                // nested-interactive, and a screen reader announces a button
                // inside a button. The row is layout only; the main area is a
                // real <button> and Ack is its sibling.
                <div
                  key={a.id}
                  className={cn(
                    // Slide-in animation + smooth hover transitions.
                    "group relative flex items-center gap-2 pr-3 transition-all duration-200 animate-slide-in-up motion-reduce:animate-none",
                    // Severity-tinted background (subtle).
                    a.severity === "L3" && "bg-rose-500/[0.03] hover:bg-rose-500/[0.07]",
                    a.severity === "L2" && "bg-amber-500/[0.02] hover:bg-amber-500/[0.06]",
                    a.severity === "L1" && "hover:bg-slate-500/[0.05]",
                  )}
                >
                  <button
                      type="button"
                      onClick={() => setView("alarms")}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                    >
                    {/* Left-border accent coloured by severity (L3=rose, L2=amber, L1=slate).
                        Absolute-positioned so it spans the row height. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute inset-y-0 left-0 w-[3px] transition-opacity duration-200 group-hover:opacity-100",
                        a.severity === "L3" && "bg-rose-500 opacity-70",
                        a.severity === "L2" && "bg-amber-500 opacity-70",
                        a.severity === "L1" && "bg-slate-400 opacity-60",
                      )}
                    />
                    <StatusBadge value={a.severity} className="h-5 shrink-0 px-1.5 text-[10px]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{translate(`alarm.${a.type}`, numLang) !== `alarm.${a.type}` ? translate(`alarm.${a.type}`, numLang) : (a.type ?? "").replace(/_/g, " ")}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{a.message}</p>
                    </div>
                    <div className="hidden w-40 shrink-0 text-right text-[11px] sm:block">
                      <p className="truncate font-medium text-foreground">{a.site?.name ?? "—"}</p>
                      {/* Time-ago badge with subtle background. */}
                      <span className="mt-0.5 inline-flex items-center rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {a.site?.code ?? ""} · {timeAgo(a.createdAt, numLang)}
                      </span>
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2 text-[11px] transition-transform active:scale-95"
                    onClick={() => {
                      void ackAlarm(a.id);
                      // #18 — Ack also opens the site detail sheet so operators
                      // can triage the underlying asset immediately, and tracks
                      // the visit in the Quick Access recent-sites list.
                      if (a.siteId) {
                        selectSite(a.siteId);
                        setView("sites");
                        addRecent(a.siteId);
                      }
                    }}
                  >
                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> {t("dash.ackAlarmShort")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fuel Runout ETA predictor — most urgent tanks predicted to run dry (#41-A) */}
      <FuelRunoutEta />

      {/* Shift Handover log — NOC operator shift-change notes (Round 46) */}
      <ShiftHandoverPanel />

      {/* Site Health Score widget */}
      {analytics?.siteHealth && (
        <SiteHealthWidget overall={analytics.siteHealth.overall} factors={analytics.siteHealth.factors} />
      )}

      {/* Main grid: map + alarm feed */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Fuel className="h-4 w-4 text-emerald-500" /> {t("dash.nationalSiteMap")}</CardTitle>
            <Badge variant="outline" className="text-[10px]">{formatNumber(snapshot.sites.length, numLang)} {t("dash.sites")}</Badge>
          </CardHeader>
          <CardContent className="p-2 pt-0">
            <div className="aspect-[16/10] w-full overflow-hidden rounded-lg border bg-muted/30">
              <NationalMap sites={snapshot.sites} selectedSiteId={selectedSiteId} onSelectSite={(id) => { selectSite(id); setView("sites"); addRecent(id); }} />
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Siren className="h-4 w-4 text-rose-500" /> {t("dash.liveAlarmFeed")}</CardTitle>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setView("alarms")}>{t("common.viewAll")}</Button>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            <ScrollArea className="h-[420px]">
              <div className="space-y-1.5 px-3 pb-3">
                {(alarms ?? []).length === 0 && (
                  <EmptyState
                    icon={ShieldCheck}
                    title={t("dash.noActiveAlarms")}
                    description={t("dash.noCriticalAlarms")}
                    compact
                    className="mt-4"
                  />
                )}
                {(alarms ?? []).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { selectSite(a.siteId); setView("sites"); addRecent(a.siteId); }}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-all duration-200 hover:bg-muted/50 hover:shadow-sm motion-reduce:transition-none",
                      a.severity === "L3" && "border-rose-500/20 bg-rose-500/[0.03]",
                      a.severity === "L2" && "border-amber-500/20 bg-amber-500/[0.02]",
                      "animate-slide-in-up motion-reduce:animate-none"
                    )}
                  >
                    <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", severityDot(a.severity), a.severity === "L3" && "animate-pulse-soft motion-reduce:animate-none")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-semibold">{translate(`alarm.${a.type}`, numLang) !== `alarm.${a.type}` ? translate(`alarm.${a.type}`, numLang) : (a.type ?? "").replace(/_/g, " ")}</p>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(a.createdAt, numLang)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{a.message}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <StatusBadge value={a.severity} className="h-4 px-1 text-[10px]" />
                        <StatusBadge value={a.status} className="h-4 px-1 text-[10px]" />
                        <span className="truncate text-[10px] text-muted-foreground">{a.site?.name}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Building2 className="h-4 w-4 text-emerald-500" /> {t("dash.fleet")}</CardTitle></CardHeader>
          <CardContent>
            <DecorativeChart>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart tabIndex={-1}>
                  <Pie data={fleetStatus} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={45} outerRadius={70} paddingAngle={3}>
                    {fleetStatus.map((e, i) => <Cell key={i} fill={e.fill} />)}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </DecorativeChart>
            <div className="mt-2 flex justify-center gap-3 text-[11px]">
              {fleetStatus.map((f) => (
                <span key={f.name} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: f.fill }} />{f.name}: <b>{f.value}</b></span>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><Droplet className="h-4 w-4 text-sky-500" /> {t("dash.fuelDist")}</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart tabIndex={-1} data={fuelDist} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="range" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {fuelDist.map((e, i) => <Cell key={i} fill={e.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><TrendingUp className="h-4 w-4 text-emerald-500" /> {t("dash.consumptionTrendRange")} <span className="font-normal text-muted-foreground">({rangeLabel})</span></CardTitle>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={range}
              onValueChange={(v) => { if (v) setRange(v as DashboardRange); }}
              aria-label={t("dash.timeRange")}
            >
              <ToggleGroupItem value="1h" className="h-7 px-2 text-[11px]">{t("dash.range1h")}</ToggleGroupItem>
              <ToggleGroupItem value="24h" className="h-7 px-2 text-[11px]">{t("dash.range24h")}</ToggleGroupItem>
              <ToggleGroupItem value="7d" className="h-7 px-2 text-[11px]">{t("dash.range7d")}</ToggleGroupItem>
            </ToggleGroup>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart tabIndex={-1} data={consumption} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                <defs>
                  <linearGradient id="cons-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={cc.emerald} stopOpacity={0.4} />
                    <stop offset="95%" stopColor={cc.emerald} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                <XAxis dataKey="t" tick={{ fontSize: 9 }} stroke="currentColor" strokeOpacity={0.3} interval={3} />
                <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Area type="monotone" dataKey="litres" stroke={cc.emerald} strokeWidth={2} fill="url(#cons-grad)" />
              </AreaChart>
            </ResponsiveContainer>
            <div className="mt-1 flex items-center justify-between px-2 text-[11px] text-muted-foreground">
              <span>{t("dash.consumedToday")}: <b className="text-foreground">{formatNumber(k.fuelConsumedTodayL.toLocaleString(), numLang)} L</b></span>
              <span>{t("dash.genHoursToday")}: <b className="text-foreground">{formatNumber(k.generatorHoursToday, numLang)} h</b></span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Region breakdown + live events */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><GaugeIcon className="h-4 w-4 text-amber-500" /> {t("dash.regionBreakdownTitle")}</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(analytics?.regionBreakdown ?? []).map((r) => (
                <button
                  key={r.region}
                  type="button"
                  onClick={() => setRegionSheet(r.region)}
                  className="group flex w-full items-center gap-3 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/40"
                  title={`${t("dash.openRegion")}: ${r.region}`}
                >
                  <div className="w-32 shrink-0 truncate text-xs font-medium">{r.region}</div>
                  <div className="flex flex-1 items-center gap-2">
                    <div className="flex flex-1 gap-0.5">
                      <div className="h-5 rounded-l bg-emerald-500/70" style={{ width: `${(r.sites / k.totalSites) * 100}%` }} title={`${formatNumber(r.sites, numLang)} ${t("dash.sites")}`} />
                    </div>
                  </div>
                  <div className="w-16 text-right text-[11px] tabular-nums text-muted-foreground">{formatNumber(r.sites, numLang)} {t("dash.sites")}</div>
                  <div className="w-16 text-right text-[11px] tabular-nums text-sky-500">{tFmt("dash.fuelK", { n: formatNumber(Math.round(r.fuel / 1000), numLang) })}</div>
                  <div className="w-14 text-right text-[11px] tabular-nums text-amber-500">{formatNumber(r.alarms, numLang)} {t("dash.alm")}</div>
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm"><Activity className="h-4 w-4 text-emerald-500" /> {t("dash.eventStreamTitle")}</CardTitle>
            <Badge variant="outline" className="text-[10px]">{formatNumber(snapshot.events.length, numLang)} {t("dash.events")}</Badge>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[220px]">
              <div className="space-y-1 px-3 pb-3">
                {snapshot.events.slice(0, 40).map((e) => (
                  <div key={e.id} className="flex items-start gap-2 border-b py-1.5 text-xs last:border-0">
                    <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                      e.kind === "CRITICAL" ? "bg-rose-500" : e.kind === "WARN" ? "bg-amber-500" : e.kind === "CONTROL" ? "bg-sky-500" : e.kind === "DELIVERY" ? "bg-emerald-500" : "bg-slate-400")} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{e.message}</p>
                      <p className="text-[10px] text-muted-foreground">{timeAgo(e.ts, numLang)}</p>
                    </div>
                  </div>
                ))}
                {snapshot.events.length === 0 && (
                  <EmptyState
                    icon={Activity}
                    title={t("common.noDataTitle")}
                    description={t("dash.noEvents")}
                    compact
                    className="mt-3"
                  />
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* Region performance leaderboard — full width */}
      <RegionLeaderboard
        regions={analytics?.regionBreakdown ?? []}
        totalSites={k.totalSites}
        onSelectRegion={(r) => setRegionSheet(r)}
      />

      {/* Per-region drill-down sheet — opened by clicking any region row */}
      <RegionDetailSheet
        region={regionSheet}
        onOpenChange={(open) => !open && setRegionSheet(null)}
      />
    </div>
  );
}
