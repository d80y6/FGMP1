"use client";

import { computeSiteHealth as computeCanonicalSiteHealth } from "@/lib/health/site-health-score";
import { useShallow } from "zustand/react/shallow";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts";
import { useFgmp } from "@/lib/fgmp/store";
import { useApi } from "@/lib/fgmp/use-api";
import { useChartColors } from "@/lib/fgmp/use-chart-colors";
import { StatusBadge, severityDot } from "@/components/fgmp/status-badge";
import { Breadcrumbs } from "@/components/fgmp/breadcrumbs";
import { cn } from "@/lib/utils";
import { timeAgo, fmtLitres } from "@/lib/fgmp/format";
import {
  MapPin, Building2, Siren, Droplet, Zap, ChevronRight,
  ShieldCheck, Gauge, ListChecks,
} from "lucide-react";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import { translate, type Language } from "@/lib/fgmp/i18n";

/** Resolve an alarm type enum value to its localized display label. */
function alarmTypeLabel(type: string, lang: Language): string {
  if (!type) return "";
  const key = `alarm.${type}`;
  const translated = translate(key, lang);
  return translated === key ? type.replace(/_/g, " ") : translated;
}

/* ------------------------------------------------------------------ */
/*  Region score — a DIFFERENT metric from site health, deliberately.      */
/* ------------------------------------------------------------------ */
/*  Phase 5 task 1 note: this measures a REGION (aggregate stability,     */
/*  fleet coverage), not a site, so it keeps its own factors. It is NOT    */
/*  compared against a site badge anywhere in the UI. Previously it looked  */
/*  interchangeable with site health because both rendered as a 0-100      */
/*  "score" beside a site name, which invited exactly the comparison the   */
/*  audit flagged. The name now says what it is.                           */
/* ------------------------------------------------------------------ */

const AVG_TANK_CAPACITY_PER_SITE = 5000;

interface RegionAgg {
  sites: number;
  fuel: number;
  alarms: number;
  running: number;
}

interface RegionScore {
  score: number;
  factors: {
    stability: number;
    fuelAvail: number;
    genActivity: number;
    coverage: number;
  };
}

function computeRegionScore(r: RegionAgg, totalSites: number): RegionScore {
  const sites = Math.max(1, r.sites);
  const alarmDensity = r.alarms / sites;
  const stability =
    alarmDensity <= 0.05 ? 100 : Math.max(0, 100 - (alarmDensity - 0.05) * 100 * 1.05);
  const fuelAvail = Math.min(100, (r.fuel / (sites * AVG_TANK_CAPACITY_PER_SITE)) * 100);
  const genActivity = Math.min(100, (r.running / sites) * 100);
  const coverage = totalSites > 0 ? Math.min(100, (r.sites / totalSites) * 100) : 0;
  const score = Math.round(
    stability * 0.35 + fuelAvail * 0.25 + genActivity * 0.2 + coverage * 0.2,
  );
  return { score, factors: { stability, fuelAvail, genActivity, coverage } };
}

/* ------------------------------------------------------------------ */
/*  Site health (mirrors site-health-trend.tsx computeTodayScore)      */
/* ------------------------------------------------------------------ */

/**
 * Phase 5 task 1: the sheet carried a SECOND private copy of the trend
 * formula, identical to it and different from the badge. It now calls the one
 * canonical implementation like every other surface.
 */
function computeSiteHealth(
  siteStatus: string,
  tanks: { current: number; capacity: number }[],
  generators: { status: string }[],
  batteries: { voltage: number }[],
  alarmCount: number,
): number {
  return computeCanonicalSiteHealth({
    site: { status: siteStatus },
    tanks,
    generators,
    batteries,
    alarmCount,
  }).overall;
}

/* ------------------------------------------------------------------ */
/*  Style helpers                                                      */
/* ------------------------------------------------------------------ */

function scoreTextClass(score: number): string {
  if (score >= 85) return "text-emerald-500";
  if (score >= 70) return "text-amber-500";
  return "text-rose-500";
}

function scoreBadgeClass(score: number): string {
  if (score >= 85) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (score >= 70) return "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400";
}

function scoreBarClass(score: number): string {
  if (score >= 85) return "bg-gradient-to-r from-emerald-500 to-emerald-400";
  if (score >= 70) return "bg-gradient-to-r from-amber-500 to-amber-400";
  return "bg-gradient-to-r from-rose-500 to-rose-400";
}

/** Severity chip — task spec: L1 sky, L2 amber, L3 rose. */
function severityChipClass(sev: string): string {
  if (sev === "L3") return "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30";
  if (sev === "L2") return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
  return "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30";
}

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function MiniKpi({
  icon, label, value, hint, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "good" | "warn" | "danger" | "info";
}) {
  const toneRing =
    tone === "good" ? "border-emerald-500/20" :
    tone === "warn" ? "border-amber-500/20" :
    tone === "danger" ? "border-rose-500/20" :
    tone === "info" ? "border-sky-500/20" : "";
  const toneText =
    tone === "good" ? "text-emerald-500" :
    tone === "warn" ? "text-amber-500" :
    tone === "danger" ? "text-rose-500" :
    tone === "info" ? "text-sky-500" : "text-muted-foreground";
  return (
    <div className={cn("rounded-lg border bg-card/50 p-3", toneRing)}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={toneText}>{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-lg font-bold leading-tight tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{hint}</div>}
    </div>
  );
}

function FactorCard({
  label, value, weight, tone,
}: {
  label: string;
  value: number;
  weight: number;
  tone: "emerald" | "sky" | "amber" | "violet";
}) {
  const toneText =
    tone === "emerald" ? "text-emerald-500" :
    tone === "sky" ? "text-sky-500" :
    tone === "amber" ? "text-amber-500" :
    "text-violet-500";
  const toneBar =
    tone === "emerald" ? "bg-emerald-400" :
    tone === "sky" ? "bg-sky-400" :
    tone === "amber" ? "bg-amber-400" :
    "bg-violet-400";
  return (
    <div className="rounded-lg border bg-card/50 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="text-[10px] font-semibold text-muted-foreground">{Math.round(weight * 100)}%</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={cn("text-lg font-bold tabular-nums", toneText)}>{Math.round(value)}</span>
        <span className="text-[10px] text-muted-foreground">/ 100</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn("h-full rounded-full transition-all duration-700 ease-out", toneBar)}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export interface RegionDetailSheetProps {
  region: string | null;
  onOpenChange: (open: boolean) => void;
}

export function RegionDetailSheet({ region, onOpenChange }: RegionDetailSheetProps) {
  const t = useT();
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";
  const { snapshot, selectSite, setView } = useFgmp(useShallow((s) => ({ snapshot: s.snapshot, selectSite: s.selectSite, setView: s.setView })));
  const cc = useChartColors();
  // Fetch open/ack/escalated alarms for the region drilldown. Reuse the same
  // endpoint pattern as dashboard-view's live alarm feed.
  const { data: alarms } = useApi<any[]>(
    "/api/fgmp/alarms?status=OPEN,ACKNOWLEDGED,ESCALATED&limit=500",
    { interval: 10000 },
  );

  const open = region !== null;

  // Aggregate everything for the selected region up-front so the render
  // body stays declarative. Recomputes when snapshot, region, alarms, or
  // chart colors change.
  const data = useMemo(() => {
    if (!snapshot || !region) return null;
    const sitesInRegion = snapshot.sites.filter((s) => s.region === region);
    const siteIds = new Set(sitesInRegion.map((s) => s.id));
    const tanks = snapshot.tanks.filter((t) => siteIds.has(t.siteId));
    const generators = snapshot.generators.filter((g) => siteIds.has(g.siteId));
    const batteries = snapshot.batteries.filter((b) => siteIds.has(b.siteId));
    const regionAlarms = (alarms ?? []).filter((a) => siteIds.has(a.siteId));

    const governorates = new Set(sitesInRegion.map((s) => s.governorate));
    const districts = new Set(sitesInRegion.map((s) => s.district));
    const online = sitesInRegion.filter((s) => s.status === "ONLINE").length;
    const degraded = sitesInRegion.filter((s) => s.status === "DEGRADED").length;
    const offline = sitesInRegion.filter((s) => s.status === "OFFLINE").length;
    const genRunning = generators.filter((g) => g.status === "RUNNING").length;
    const genFault = generators.filter((g) => g.status === "FAULT").length;
    const totalFuel = tanks.reduce((a, t) => a + t.current, 0);
    const avgFuelPct = tanks.length > 0
      ? tanks.reduce((a, t) => a + (t.current / Math.max(1, t.capacity)) * 100, 0) / tanks.length
      : 0;

    const alarmsL1 = regionAlarms.filter((a) => a.severity === "L1").length;
    const alarmsL2 = regionAlarms.filter((a) => a.severity === "L2").length;
    const alarmsL3 = regionAlarms.filter((a) => a.severity === "L3").length;

    const scoreData = computeRegionScore(
      {
        sites: sitesInRegion.length,
        fuel: totalFuel,
        alarms: regionAlarms.length,
        running: genRunning,
      },
      snapshot.sites.length,
    );

    // Per-site health for the top-N sites table.
    const alarmCountBySite = new Map<string, number>();
    for (const a of regionAlarms) {
      alarmCountBySite.set(a.siteId, (alarmCountBySite.get(a.siteId) ?? 0) + 1);
    }
    const sitesWithHealth = sitesInRegion
      .map((s) => {
        const siteTanks = tanks.filter((t) => t.siteId === s.id);
        const siteGens = generators.filter((g) => g.siteId === s.id);
        const siteBatts = batteries.filter((b) => b.siteId === s.id);
        const ac = alarmCountBySite.get(s.id) ?? 0;
        const health = computeSiteHealth(s.status, siteTanks, siteGens, siteBatts, ac);
        const fuelPct = siteTanks.length > 0
          ? siteTanks.reduce((a, t) => a + (t.current / Math.max(1, t.capacity)) * 100, 0) / siteTanks.length
          : 0;
        const genRunningCount = siteGens.filter((g) => g.status === "RUNNING").length;
        const genStatus = siteGens.length === 0
          ? "—"
          : siteGens.some((g) => g.status === "FAULT") ? "FAULT"
          : genRunningCount > 0 ? `${genRunningCount}/${siteGens.length} RUN`
          : "IDLE";
        return { site: s, health, fuelPct, genStatus, alarms: ac };
      })
      .sort((a, b) => b.health - a.health);

    const recentAlarms = [...regionAlarms]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5);

    // Fuel distribution buckets per task spec.
    const fuelBuckets = [
      { range: "Critical", sub: "<12%", count: 0, fill: cc.rose },
      { range: "Low", sub: "12-25%", count: 0, fill: cc.amber },
      { range: "Mid", sub: "25-60%", count: 0, fill: cc.sky },
      { range: "Good", sub: "60-100%", count: 0, fill: cc.emerald },
    ];
    for (const t of tanks) {
      const pct = (t.current / Math.max(1, t.capacity)) * 100;
      const i = pct < 12 ? 0 : pct < 25 ? 1 : pct < 60 ? 2 : 3;
      fuelBuckets[i].count++;
    }

    const alarmPie = [
      { name: "L1", value: alarmsL1, fill: cc.sky },
      { name: "L2", value: alarmsL2, fill: cc.amber },
      { name: "L3", value: alarmsL3, fill: cc.rose },
    ];

    return {
      sitesInRegion, tanks, generators, batteries, regionAlarms,
      governorates: governorates.size, districts: districts.size,
      online, degraded, offline, total: sitesInRegion.length,
      genRunning, genFault, genTotal: generators.length,
      totalFuel, avgFuelPct,
      alarmsL1, alarmsL2, alarmsL3,
      score: scoreData.score, factors: scoreData.factors,
      sitesWithHealth, recentAlarms,
      fuelBuckets, alarmPie,
    };
  }, [snapshot, region, alarms, cc.rose, cc.amber, cc.sky, cc.emerald]);

  const handleSiteClick = (siteId: string) => {
    selectSite(siteId);
    setView("sites");
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <SheetHeader className="gap-2 border-b bg-gradient-to-r from-emerald-500/10 to-transparent px-5 py-4">
          {/* Breadcrumbs (#11) — Fleet → Region (current) */}
          <Breadcrumbs
            items={[
              { label: t("common.fleet"), href: "/?view=dashboard" },
              ...(region ? [{ label: region }] : []),
            ]}
            className="mb-0.5"
          />
          <SheetTitle className="flex items-center gap-2 text-lg font-bold">
            <MapPin className="h-5 w-5 text-emerald-500" />
            {region ?? t("region.region")}
            {data && (
              <Badge
                variant="outline"
                className={cn("ml-1 h-6 px-2 text-xs font-bold tabular-nums", scoreBadgeClass(data.score))}
                title={t("region.scoreTitle")}
              >
                <ShieldCheck className="mr-1 h-3 w-3" />
                {data.score}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {data ? (
              <>
                <span className="flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  {data.total} {data.total === 1 ? t("region.site") : t("region.sites")}
                </span>
                <span className="text-muted-foreground/50">·</span>
                <span>{data.governorates} {data.governorates === 1 ? t("region.governorate") : t("region.governorates")}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{data.districts} {data.districts === 1 ? t("region.district") : t("region.districts")}</span>
              </>
            ) : (
              <span>{t("region.loadingSummary")}</span>
            )}
          </SheetDescription>
        </SheetHeader>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {!snapshot || !data ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : data.total === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <Building2 className="h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 text-sm font-medium">{t("region.noSites")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("region.noSitesHint")}
              </p>
            </div>
          ) : (
            <div className="space-y-5 p-4">
              {/* KPI grid */}
              <section className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <MiniKpi
                    icon={<Building2 className="h-3.5 w-3.5" />}
                    label={t("region.sitesOnline")}
                    value={
                      <span className="flex items-center gap-1.5">
                        <span className={cn(
                          "h-2 w-2 rounded-full",
                          data.offline > 0 ? "bg-rose-500" : data.degraded > 0 ? "bg-amber-500" : "bg-emerald-500",
                        )} />
                        {data.online}
                        <span className="text-xs font-normal text-muted-foreground">/ {data.total}</span>
                      </span>
                    }
                    hint={`${data.degraded} ${t("dash.degraded")} · ${data.offline} ${t("dash.offline")}`}
                    tone={data.offline > 0 ? "danger" : data.degraded > 0 ? "warn" : "good"}
                  />
                  <MiniKpi
                    icon={<Siren className="h-3.5 w-3.5" />}
                    label={t("region.openAlarms")}
                    value={data.regionAlarms.length}
                    hint={
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className={cn("h-3.5 px-1 text-[9px] font-bold", severityChipClass("L1"))}>L1:{data.alarmsL1}</Badge>
                        <Badge variant="outline" className={cn("h-3.5 px-1 text-[9px] font-bold", severityChipClass("L2"))}>L2:{data.alarmsL2}</Badge>
                        <Badge variant="outline" className={cn("h-3.5 px-1 text-[9px] font-bold", severityChipClass("L3"))}>L3:{data.alarmsL3}</Badge>
                      </span>
                    }
                    tone={data.alarmsL3 > 0 ? "danger" : data.regionAlarms.length > 0 ? "warn" : "good"}
                  />
                  <MiniKpi
                    icon={<Droplet className="h-3.5 w-3.5" />}
                    label={t("region.fuelInventory")}
                    value={fmtLitres(data.totalFuel, numLang)}
                    hint={`${data.avgFuelPct.toFixed(1)}% · ${data.tanks.length} ${t("fuel.tanks").toLowerCase()}`}
                    tone={data.avgFuelPct < 25 ? "danger" : data.avgFuelPct < 50 ? "warn" : "good"}
                  />
                  <MiniKpi
                    icon={<Zap className="h-3.5 w-3.5" />}
                    label={t("region.generators")}
                    value={
                      <span>
                        {data.genRunning}
                        <span className="text-xs font-normal text-muted-foreground"> / {data.genTotal} {t("region.running")}</span>
                      </span>
                    }
                    hint={data.genFault > 0 ? `${data.genFault} ${t("region.fault")}` : t("region.noFaults")}
                    tone={data.genFault > 0 ? "danger" : data.genRunning > 0 ? "info" : "warn"}
                  />
                </div>
              </section>

              {/* Charts row */}
              <section className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="rounded-lg border bg-card/50 p-3">
                    <SectionTitle icon={<Droplet className="h-3.5 w-3.5 text-sky-500" />}>
                      {t("region.fuelDistribution")}
                    </SectionTitle>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={data.fuelBuckets} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.08} vertical={false} />
                        <XAxis dataKey="range" tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} />
                        <YAxis tick={{ fontSize: 10 }} stroke="currentColor" strokeOpacity={0.3} allowDecimals={false} />
                        <RTooltip
                          contentStyle={{ fontSize: 11 }}
                          formatter={(v: number) => [`${v} tank${v === 1 ? "" : "s"}`, "Count"]}
                          labelFormatter={(_, payload) => {
                            const p = payload?.[0]?.payload as { range: string; sub: string } | undefined;
                            return p ? `${p.range} (${p.sub})` : "";
                          }}
                        />
                        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                          {data.fuelBuckets.map((e, i) => <Cell key={i} fill={e.fill} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="rounded-lg border bg-card/50 p-3">
                    <SectionTitle icon={<Siren className="h-3.5 w-3.5 text-rose-500" />}>
                      {t("region.alarmSeverity")}
                    </SectionTitle>
                    {data.regionAlarms.length === 0 ? (
                      <div className="flex h-[160px] flex-col items-center justify-center text-center">
                        <ShieldCheck className="h-6 w-6 text-emerald-500/70" />
                        <p className="mt-1.5 text-[11px] text-muted-foreground">{t("region.noActiveAlarms")}</p>
                      </div>
                    ) : (
                      <ResponsiveContainer width="100%" height={160}>
                        <PieChart>
                          <Pie
                            data={data.alarmPie}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius={40}
                            outerRadius={62}
                            paddingAngle={2}
                          >
                            {data.alarmPie.map((e, i) => <Cell key={i} fill={e.fill} />)}
                          </Pie>
                          <RTooltip contentStyle={{ fontSize: 11 }} formatter={(v: number, n: string) => [`${v} alarm${v === 1 ? "" : "s"}`, n]} />
                        </PieChart>
                      </ResponsiveContainer>
                    )}
                    <div className="mt-1 flex justify-center gap-3 text-[10px]">
                      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: cc.sky }} />L1: <b className="tabular-nums">{data.alarmsL1}</b></span>
                      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: cc.amber }} />L2: <b className="tabular-nums">{data.alarmsL2}</b></span>
                      <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: cc.rose }} />L3: <b className="tabular-nums">{data.alarmsL3}</b></span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Sites table (top 10 by health) */}
              <section className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="rounded-lg border bg-card/50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <SectionTitle icon={<ListChecks className="h-3.5 w-3.5 text-emerald-500" />}>
                      {t("region.topSites")}
                    </SectionTitle>
                    <Badge variant="outline" className="text-[10px]">{data.total} {t("region.total")}</Badge>
                  </div>
                  <ScrollArea className="h-[280px] pr-2">
                    <Table>
                      <TableHeader>
                        <TableRow className="[&_th]:h-7 [&_th]:py-1 [&_th]:text-[10px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                          <TableHead>{t("region.code")}</TableHead>
                          <TableHead>{t("region.name")}</TableHead>
                          <TableHead>{t("region.status")}</TableHead>
                          <TableHead className="text-right">{t("region.health")}</TableHead>
                          <TableHead className="text-right">{t("region.alarms")}</TableHead>
                          <TableHead className="text-right">{t("region.fuel")}</TableHead>
                          <TableHead className="text-right">{t("region.gen")}</TableHead>
                          <TableHead className="w-6"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.sitesWithHealth.slice(0, 10).map(({ site, health, fuelPct, genStatus, alarms }) => (
                          <TableRow
                            key={site.id}
                            onClick={() => handleSiteClick(site.id)}
                            className="cursor-pointer py-1.5 text-xs tabular-nums hover:bg-muted/40 [&_td]:py-1.5 [&_td]:text-xs"
                          >
                            <TableCell className="font-mono text-[10px] text-muted-foreground">{site.code}</TableCell>
                            <TableCell className="max-w-[140px] truncate font-medium">{site.name}</TableCell>
                            <TableCell><StatusBadge value={site.status} className="h-5 text-[9px]" /></TableCell>
                            <TableCell className="text-right">
                              <span className={cn("font-bold tabular-nums", scoreTextClass(health))}>{health}%</span>
                            </TableCell>
                            <TableCell className="text-right">
                              {alarms > 0 ? (
                                <span className="font-semibold text-rose-500">{alarms}</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <span className={cn(
                                "font-semibold tabular-nums",
                                fuelPct < 12 ? "text-rose-500" : fuelPct < 25 ? "text-amber-500" : "text-emerald-500",
                              )}>{fuelPct.toFixed(0)}%</span>
                            </TableCell>
                            <TableCell className="text-right text-[10px] text-muted-foreground">{genStatus}</TableCell>
                            <TableCell className="text-muted-foreground"><ChevronRight className="h-3 w-3" /></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                  {data.total > 10 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 w-full text-xs"
                      onClick={() => { setView("sites"); onOpenChange(false); }}
                    >
                      {t("region.viewAllSites")} {data.total} {t("region.sites")}
                      <ChevronRight className="ml-1 h-3 w-3" />
                    </Button>
                  )}
                </div>
              </section>

              {/* Top alarms */}
              <section className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="rounded-lg border bg-card/50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <SectionTitle icon={<Siren className="h-3.5 w-3.5 text-rose-500" />}>
                      {t("region.recentAlarms")}
                    </SectionTitle>
                    <Badge variant="outline" className="text-[10px]">{data.regionAlarms.length} {t("region.active")}</Badge>
                  </div>
                  {data.recentAlarms.length === 0 ? (
                    <div className="flex items-center justify-center py-6 text-center text-xs text-muted-foreground">
                      <ShieldCheck className="mr-1.5 h-4 w-4 text-emerald-500" />
                      {t("region.noActiveAlarmsInRegion")}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {data.recentAlarms.map((a) => (
                        <button
                          key={a.id}
                          onClick={() => handleSiteClick(a.siteId)}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md border p-2 text-left transition-colors hover:bg-muted/40",
                            a.severity === "L3" ? "border-rose-500/20 bg-rose-500/[0.03]" :
                            a.severity === "L2" ? "border-amber-500/20 bg-amber-500/[0.02]" :
                            "border-sky-500/20 bg-sky-500/[0.02]",
                          )}
                        >
                          <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", severityDot(a.severity))} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="truncate text-xs font-semibold">{alarmTypeLabel(a.type, numLang)}</p>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(a.createdAt, numLang)}</span>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{a.message}</p>
                            <div className="mt-1 flex items-center gap-1.5">
                              <Badge variant="outline" className={cn("h-4 px-1 text-[9px] font-bold", severityChipClass(a.severity))}>
                                {a.severity}
                              </Badge>
                              <span className="truncate text-[10px] text-muted-foreground">
                                {a.site?.code} · {a.site?.name}
                              </span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-7 w-full text-xs"
                    onClick={() => { setView("alarms"); onOpenChange(false); }}
                  >
                    {t("region.viewAllAlarms")}
                    <ChevronRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              </section>

              {/* Region performance breakdown */}
              <section className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="rounded-lg border bg-card/50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <SectionTitle icon={<Gauge className="h-3.5 w-3.5 text-amber-500" />}>
                      {t("region.performanceBreakdown")}
                    </SectionTitle>
                    <Badge variant="outline" className={cn("text-[10px] font-bold", scoreBadgeClass(data.score))}>
                      {t("region.score")}: {data.score}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <FactorCard label={t("region.stability")} value={data.factors.stability} weight={0.35} tone="emerald" />
                    <FactorCard label={t("region.fuelAvail")} value={data.factors.fuelAvail} weight={0.25} tone="sky" />
                    <FactorCard label={t("region.genActivity")} value={data.factors.genActivity} weight={0.20} tone="amber" />
                    <FactorCard label={t("region.coverage")} value={data.factors.coverage} weight={0.20} tone="violet" />
                  </div>
                  {/* Subtle overall progress bar */}
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t("region.overall")}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/60">
                      <div
                        className={cn("h-full rounded-full transition-all duration-700 ease-out", scoreBarClass(data.score))}
                        style={{ width: `${data.score}%` }}
                      />
                    </div>
                    <span className={cn("text-xs font-bold tabular-nums", scoreTextClass(data.score))}>{data.score}</span>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
