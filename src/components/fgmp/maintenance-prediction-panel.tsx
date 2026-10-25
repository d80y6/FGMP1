"use client";

import { useMemo, useState } from "react";
import {
  Wrench,
  ChevronDown,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  Clock,
  CalendarClock,
  Gauge,
  Cog,
  Zap,
  History,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FilterTabs, FilterTab } from "@/components/fgmp/filter-tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useFgmp } from "@/lib/fgmp/store";
import type { GenState } from "@/lib/fgmp/types";
import { useT, useTF } from "@/lib/fgmp/use-language";

// ────────────────────────────────────────────────────────────────────────────
// Types & constants
// ────────────────────────────────────────────────────────────────────────────

type Urgency = "OVERDUE" | "DUE_NOW" | "DUE_SOON" | "OK";

interface MaintRow {
  id: string;
  label: string;
  siteName: string;
  siteCode: string;
  manufacturer: string;
  model: string;
  ratedPowerKw: number;
  runtimeHours: number;
  oilChangeIntervalHrs: number;
  lastOilChangeHrs: number;
  nextMaintenanceHrs: number;
  hoursUntil: number;
  lastOilChangeHoursAgo: number;
  progressPct: number; // unclamped — can exceed 100 when overdue
  progressPctClamped: number; // 0–100 for bar width
  urgency: Urgency;
  avgDailyHours: number;
  etaDays: number; // negative when overdue
  configured: boolean; // false if interval/maintenance invalid
}

const FALLBACK_DAILY_HOURS = 8; // assumption when no history is available

// Urgency thresholds (in runtime hours remaining until next maintenance)
const DUE_NOW_THRESHOLD = 20;
const DUE_SOON_THRESHOLD = 100;

// Progress-bar color zones (based on consumed percentage of interval)
const PROGRESS_THRESHOLDS = {
  ROSE: 100, // >100% → overdue
  AMBER: 80, // 80–100% → due soon / now
  SKY: 50, // 50–80% → approaching
};

// ────────────────────────────────────────────────────────────────────────────
// Urgency styling tokens
// ────────────────────────────────────────────────────────────────────────────

const URGENCY_META: Record<
  Urgency,
  {
    labelKey: string;
    badge: string;
    border: string; // left border color for card
    barFill: string; // gradient for progress bar fill
    chip: string; // header chip pill
    icon: typeof AlertOctagon;
    pulse?: boolean;
    tooltipKey: string;
  }
> = {
  OVERDUE: {
    labelKey: "prediction.overdue",
    badge:
      "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30 animate-urgency-pulse",
    border: "border-l-rose-500",
    barFill: "bg-gradient-to-r from-rose-600 to-rose-400",
    chip: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30",
    icon: AlertOctagon,
    pulse: true,
    tooltipKey: "prediction.overdueTip",
  },
  DUE_NOW: {
    labelKey: "prediction.dueNow",
    badge:
      "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
    border: "border-l-amber-500",
    barFill: "bg-gradient-to-r from-amber-600 to-amber-400",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
    icon: AlertTriangle,
    tooltipKey: "prediction.dueNowTip",
  },
  DUE_SOON: {
    labelKey: "prediction.dueSoon",
    badge: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
    border: "border-l-sky-500",
    barFill: "bg-gradient-to-r from-sky-600 to-sky-400",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/30",
    icon: Clock,
    tooltipKey: "prediction.dueSoonTip",
  },
  OK: {
    labelKey: "prediction.ok",
    badge:
      "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    border: "border-l-emerald-500",
    barFill: "bg-gradient-to-r from-emerald-600 to-emerald-400",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    icon: CheckCircle2,
    tooltipKey: "prediction.okTip",
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Computation helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the average daily runtime (hours/day) for a generator from its
 * history (if available). Falls back to FALLBACK_DAILY_HOURS when history is
 * missing, has fewer than 2 points, or spans less than an hour.
 *
 * The snapshot shipped by the API strips `history` to keep payloads small, so
 * in practice we fall back to 8h/day for most generators. The history-based
 * path remains in place for callers that hydrate per-entity history.
 */
function computeAvgDailyHours(g: GenState): number {
  const hist = g.history;
  if (!hist || hist.length < 2) return FALLBACK_DAILY_HOURS;
  const first = hist[0];
  const last = hist[hist.length - 1];
  const dtMs = last.t - first.t;
  if (dtMs < 60 * 60 * 1000) return FALLBACK_DAILY_HOURS; // <1h span — not reliable
  const dRuntime = last.runtime - first.runtime;
  if (!Number.isFinite(dRuntime) || dRuntime < 0) return FALLBACK_DAILY_HOURS;
  const days = dtMs / (24 * 60 * 60 * 1000);
  const avg = dRuntime / days;
  if (!Number.isFinite(avg) || avg <= 0) return FALLBACK_DAILY_HOURS;
  return avg;
}

function deriveUrgency(hoursUntil: number): Urgency {
  if (hoursUntil < 0) return "OVERDUE";
  if (hoursUntil <= DUE_NOW_THRESHOLD) return "DUE_NOW";
  if (hoursUntil <= DUE_SOON_THRESHOLD) return "DUE_SOON";
  return "OK";
}

function buildRow(g: GenState, siteName: string, siteCode: string): MaintRow {
  const interval = g.oilChangeIntervalHrs;
  const configured = Number.isFinite(interval) && interval > 0 && g.nextMaintenanceHrs > g.lastOilChangeHrs;

  const hoursUntil = configured ? g.nextMaintenanceHrs - g.runtimeHours : 0;
  const span = configured ? g.nextMaintenanceHrs - g.lastOilChangeHrs : 1;
  const consumed = g.runtimeHours - g.lastOilChangeHrs;
  const progressPct = configured ? (consumed / span) * 100 : 0;
  const progressPctClamped = Math.max(0, Math.min(100, progressPct));
  const avgDailyHours = computeAvgDailyHours(g);
  const etaDays = configured ? hoursUntil / avgDailyHours : 0;

  return {
    id: g.id,
    label: g.label,
    siteName,
    siteCode,
    manufacturer: g.manufacturer,
    model: g.model,
    ratedPowerKw: g.ratedPowerKw,
    runtimeHours: g.runtimeHours,
    oilChangeIntervalHrs: interval,
    lastOilChangeHrs: g.lastOilChangeHrs,
    nextMaintenanceHrs: g.nextMaintenanceHrs,
    hoursUntil,
    lastOilChangeHoursAgo: consumed,
    progressPct,
    progressPctClamped,
    urgency: configured ? deriveUrgency(hoursUntil) : "OK",
    avgDailyHours,
    etaDays,
    configured,
  };
}

/**
 * Format the ETA string for display:
 *  - Overdue <1d  → "OVERDUE by {N}h"
 *  - Overdue ≥1d  → "OVERDUE by {N}d"
 *  - Due <1d      → "Due in {N}h"
 *  - Due ≥1d      → "Due in {N}d {M}h"
 */
function formatEta(row: MaintRow): string {
  if (!row.configured) return "Not configured";
  const h = row.hoursUntil;
  if (h < 0) {
    const overdueH = Math.abs(h);
    if (overdueH < 24) return `OVERDUE by ${Math.round(overdueH)}h`;
    const d = Math.floor(overdueH / 24);
    const remH = Math.round(overdueH - d * 24);
    return remH > 0 ? `OVERDUE by ${d}d ${remH}h` : `OVERDUE by ${d}d`;
  }
  if (h < 24) return `Due in ${Math.round(h)}h`;
  const d = Math.floor(h / 24);
  const remH = Math.round(h - d * 24);
  return remH > 0 ? `Due in ${d}d ${remH}h` : `Due in ${d}d`;
}

// Round to 1 decimal place, with thousands separators
function fmtHrs(n: number): string {
  return Math.round(n).toLocaleString();
}

// ────────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────────

function UrgencyChip({
  urgency,
  count,
}: {
  urgency: Urgency;
  count: number;
}) {
  const t = useT();
  if (count === 0) return null;
  const meta = URGENCY_META[urgency];
  const Icon = meta.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tabular-nums transition-colors",
            meta.chip,
          )}
        >
          <Icon className="h-3 w-3" />
          <span>{t(meta.labelKey)}</span>
          <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] leading-none">
            {count}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {t(meta.tooltipKey)}
      </TooltipContent>
    </Tooltip>
  );
}

function ProgressBar({ row }: { row: MaintRow }) {
  const t = useT();
  const tFmt = useTF();
  if (!row.configured) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <div className="h-1.5 w-full rounded-full bg-muted/60" />
        <span>{t("prediction.notConfigured")}</span>
      </div>
    );
  }
  const pct = row.progressPctClamped;
  // Choose fill color based on consumed percentage (rose >100%, amber 80–100, sky 50–80, emerald <50)
  let fillClass: string;
  if (row.progressPct > PROGRESS_THRESHOLDS.ROSE) fillClass = URGENCY_META.OVERDUE.barFill;
  else if (row.progressPct >= PROGRESS_THRESHOLDS.AMBER) fillClass = URGENCY_META.DUE_NOW.barFill;
  else if (row.progressPct >= PROGRESS_THRESHOLDS.SKY) fillClass = URGENCY_META.DUE_SOON.barFill;
  else fillClass = URGENCY_META.OK.barFill;

  return (
    <div className="space-y-1">
      <div className="relative h-2 w-full rounded-full bg-muted/60">
        {/* Tick marks at 50%, 80%, 100% */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute top-0 bottom-0 w-px bg-foreground/15" style={{ left: "50%" }} />
          <div className="absolute top-0 bottom-0 w-px bg-foreground/20" style={{ left: "80%" }} />
          <div className="absolute top-0 bottom-0 w-px bg-foreground/25" style={{ left: "100%" }} />
        </div>
        {/* Fill */}
        <div
          className={cn("h-full rounded-full transition-all duration-500", fillClass)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          {tFmt("common.hoursOf", { a: fmtHrs(row.runtimeHours), b: fmtHrs(row.nextMaintenanceHrs) })}
        </span>
        <span
          className={cn(
            "font-mono tabular-nums",
            row.progressPct > 100 && "text-rose-700 dark:text-rose-400 font-semibold",
            row.progressPct >= 80 && row.progressPct <= 100 && "text-amber-700 dark:text-amber-400",
          )}
        >
          {Math.round(row.progressPct)}%
        </span>
      </div>
    </div>
  );
}

function DetailGrid({ row }: { row: MaintRow }) {
  const t = useT();
  const items: { icon: typeof Wrench; labelKey: string; value: string; tone?: string }[] = [
    {
      icon: History,
      labelKey: "prediction.lastOilChange",
      value: `${fmtHrs(row.lastOilChangeHrs)}h`,
    },
    {
      icon: Clock,
      labelKey: "prediction.hoursSinceOil",
      value: `${fmtHrs(row.lastOilChangeHoursAgo)}h`,
    },
    {
      icon: CalendarClock,
      labelKey: "prediction.avgDailyRuntime",
      value: `${row.avgDailyHours.toFixed(1)}h/day ${
        row.avgDailyHours === FALLBACK_DAILY_HOURS ? t("prediction.assumed") : t("prediction.fromHistory")
      }`,
    },
    {
      icon: Wrench,
      labelKey: "prediction.oilChangeInterval",
      value: `${fmtHrs(row.oilChangeIntervalHrs)}h`,
    },
    {
      icon: Cog,
      labelKey: "prediction.manufacturerModel",
      value: `${row.manufacturer} ${row.model}`,
    },
    {
      icon: Zap,
      labelKey: "prediction.ratedPower",
      value: `${row.ratedPowerKw} kW`,
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-1.5 py-2 sm:grid-cols-2">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <div
            key={it.labelKey}
            className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t(it.labelKey)}
              </p>
              <p className="truncate text-[11px] font-medium tabular-nums">{it.value}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GeneratorCard({ row }: { row: MaintRow }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const meta = URGENCY_META[row.urgency];
  const Icon = meta.icon;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group rounded-lg border border-l-2 bg-card p-3 transition-all duration-200 hover:bg-muted/30 hover:shadow-sm",
        meta.border,
      )}
    >
      <div className="flex items-start gap-3">
        {/* Left: identity */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium" title={row.label}>{row.label}</p>
            <Badge variant="outline" className="h-4 px-1 text-[10px] text-muted-foreground">
              {row.manufacturer}
            </Badge>
          </div>
          <p
            className="truncate text-[11px] text-muted-foreground"
            title={`${row.siteCode ? `${row.siteCode} · ` : ""}${row.siteName}`}
          >
            {row.siteCode ? `${row.siteCode} · ` : ""}
            {row.siteName}
          </p>
        </div>

        {/* Center: progress bar (hidden on very small screens) */}
        <div className="hidden min-w-[180px] flex-1 sm:block">
          <ProgressBar row={row} />
        </div>

        {/* Right: urgency + ETA + expand trigger */}
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex flex-col items-end gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                meta.badge,
              )}
            >
              <Icon className="h-2.5 w-2.5" />
              {t(meta.labelKey)}
            </span>
            <span className="font-mono text-[11px] font-medium tabular-nums text-foreground">
              {formatEta(row)}
            </span>
          </div>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={open ? t("prediction.collapse") : t("prediction.expand")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200",
                  open && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>
        </div>
      </div>

      {/* Mobile progress bar (shown below on small screens) */}
      <div className="mt-2 sm:hidden">
        <ProgressBar row={row} />
      </div>

      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 data-[state=open]:duration-200">
        <div className="mt-2 border-t border-border/40 pt-2">
          <DetailGrid row={row} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StatTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  tone?: "rose" | "amber" | "sky" | "emerald" | "muted";
}) {
  const TONE_TEXT: Record<string, string> = {
    rose: "text-rose-700 dark:text-rose-400",
    amber: "text-amber-700 dark:text-amber-400",
    sky: "text-sky-700 dark:text-sky-400",
    emerald: "text-emerald-700 dark:text-emerald-400",
    muted: "text-foreground",
  };
  return (
    <div className="rounded-md border bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className={cn("shrink-0", TONE_TEXT[tone ?? "muted"])}>{icon}</span>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
      <p className={cn("mt-1 text-base font-bold tabular-nums", TONE_TEXT[tone ?? "muted"])}>
        {value}
      </p>
    </div>
  );
}

type FilterKind = "all" | "urgent" | "overdue" | "ok";

// ────────────────────────────────────────────────────────────────────────────
// Main panel
// ────────────────────────────────────────────────────────────────────────────

/**
 * Maintenance Prediction Panel
 *
 * Reads `useFgmp().snapshot.generators` and renders a ranked, filterable list
 * of generators sorted by hours-until-next-maintenance (most urgent first).
 * Each row shows a progress bar (runtime consumed vs interval), an ETA
 * prediction based on average daily runtime, and an expandable detail panel.
 */
export function MaintenancePredictionPanel() {
  const t = useT();
  const snapshot = useFgmp((s) => s.snapshot);
  const [filter, setFilter] = useState<FilterKind>("all");

  const rows = useMemo<MaintRow[]>(() => {
    if (!snapshot) return [];
    const siteOf = (id: string) => snapshot.sites.find((s) => s.id === id);
    return snapshot.generators.map((g) => {
      const site = siteOf(g.siteId);
      return buildRow(g, site?.name ?? "—", site?.code ?? "");
    });
  }, [snapshot]);

  // Sort by hoursUntil ascending — most urgent first.
  // Unconfigured rows sink to the bottom (treated as Infinity).
  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a.configured ? a.hoursUntil : Number.POSITIVE_INFINITY;
      const bv = b.configured ? b.hoursUntil : Number.POSITIVE_INFINITY;
      if (av !== bv) return av - bv;
      return a.label.localeCompare(b.label);
    });
    return copy;
  }, [rows]);

  const counts = useMemo(() => {
    const c = { OVERDUE: 0, DUE_NOW: 0, DUE_SOON: 0, OK: 0 } as Record<Urgency, number>;
    for (const r of rows) c[r.urgency]++;
    return c;
  }, [rows]);

  const hasOverdue = counts.OVERDUE > 0;

  const filtered = useMemo(() => {
    if (filter === "all") return sorted;
    if (filter === "urgent") {
      return sorted.filter(
        (r) => r.urgency === "OVERDUE" || r.urgency === "DUE_NOW" || r.urgency === "DUE_SOON",
      );
    }
    if (filter === "overdue") return sorted.filter((r) => r.urgency === "OVERDUE");
    return sorted.filter((r) => r.urgency === "OK");
  }, [sorted, filter]);

  if (!snapshot) return null;

  const total = rows.length;
  const totalUrgent = counts.OVERDUE + counts.DUE_NOW + counts.DUE_SOON;

  return (
    <Card className="relative gap-0 overflow-hidden py-0">
      {/* Warning gradient when any overdue */}
      {hasOverdue && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-r from-rose-500/5 to-transparent" />
      )}

      {/* Header */}
      <div className="relative flex flex-col gap-3 px-4 pb-3 pt-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-xl bg-amber-500/10 p-2.5 text-amber-700 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20 dark:text-amber-400">
            <Wrench className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-bold tracking-tight">{t("prediction.title")}</h3>
            <p className="text-xs text-muted-foreground">
              {t("prediction.subtitle")}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <UrgencyChip urgency="OVERDUE" count={counts.OVERDUE} />
          <UrgencyChip urgency="DUE_NOW" count={counts.DUE_NOW} />
          <UrgencyChip urgency="DUE_SOON" count={counts.DUE_SOON} />
          <UrgencyChip urgency="OK" count={counts.OK} />
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center justify-between gap-2 border-y border-border/40 bg-muted/20 px-4 py-2">
        <FilterTabs value={filter} onValueChange={(v) => setFilter(v as FilterKind)} label={t("prediction.filterLabel")}>
          <FilterTab value="all">
              {t("prediction.all")}
              <span className="ml-1 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-foreground">
                {total}
              </span>
            </FilterTab>
            <FilterTab value="urgent">
              {t("prediction.urgent")}
              <span className="ml-1 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-foreground">
                {totalUrgent}
              </span>
            </FilterTab>
            <FilterTab value="overdue">
              {t("prediction.overdueTab")}
              <span className="ml-1 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-foreground">
                {counts.OVERDUE}
              </span>
            </FilterTab>
            <FilterTab value="ok">
              {t("prediction.okLabel")}
              <span className="ml-1 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-foreground">
                {counts.OK}
              </span>
            </FilterTab>
        </FilterTabs>
        <span className="hidden text-[10px] text-muted-foreground sm:inline">
          {t("prediction.sortedBy")}
        </span>
      </div>

      {/* Generator list */}
      <div className="maintenance-prediction-scroll max-h-[400px] overflow-y-auto px-3 py-3" tabIndex={0} role="region" aria-label={t("a11y.scrollPredictions")}>
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
              <CheckCircle2 className="h-7 w-7 text-emerald-500" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("prediction.noGens")}</p>
              <p className="text-xs text-muted-foreground">
                {filter === "all"
                  ? t("prediction.allWithinInterval")
                  : t("prediction.noMatch")}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((row) => (
              <GeneratorCard key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>

      {/* Footer summary */}
      <div className="border-t border-border/40 bg-muted/20 px-4 py-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile
            icon={<Gauge className="h-3.5 w-3.5" />}
            label={t("prediction.total")}
            value={total}
          />
          <StatTile
            icon={<AlertOctagon className="h-3.5 w-3.5" />}
            label={t("prediction.overdueLabel")}
            value={counts.OVERDUE}
            tone="rose"
          />
          <StatTile
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label={t("prediction.dueNowLabel")}
            value={counts.DUE_NOW}
            tone="amber"
          />
          <StatTile
            icon={<Clock className="h-3.5 w-3.5" />}
            label={t("prediction.dueSoonLabel")}
            value={counts.DUE_SOON}
            tone="sky"
          />
          <StatTile
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label={t("prediction.okLabel")}
            value={counts.OK}
            tone="emerald"
          />
          <div className="flex items-end justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() =>
                toast.info(t("prediction.scheduleToast"), {
                  description: t("prediction.scheduleToastDesc"),
                })
              }
            >
              <Phone className="mr-1.5 h-3.5 w-3.5" />
              {t("prediction.scheduleMaintenance")}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
