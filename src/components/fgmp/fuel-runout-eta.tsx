"use client";

import { Clock, Info, AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { useApi } from "@/lib/fgmp/use-api";
import { useFgmp } from "@/lib/fgmp/store";
import { useT, useArabicNumerals, formatNumber } from "@/lib/fgmp/use-language";
import type { Language } from "@/lib/fgmp/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Fuel Runout ETA predictor widget (#41-A)
 * ────────────────────────────────────────────────────────────────────────────
 * Dashboard card that surfaces the fuel tanks most at risk of running dry,
 * ranked by predicted runout time. Polls /api/fgmp/fuel/runout-eta every 60s.
 *
 * Each row shows: site + tank label, an urgency dot, the ETA duration
 * ("8h 12m" / "2d 4h"), and the current fill %. A footer "View all tanks"
 * button jumps to the Fuel view. An ⓘ tooltip explains the formula.
 */

type Urgency = "critical" | "urgent" | "soon" | "ok";

interface RunoutTank {
  tankId: string;
  label: string;
  siteId: string;
  siteName: string;
  region: string;
  currentLitres: number;
  capacityLitres: number;
  pct: number;
  ratePerHour: number;
  etaHours: number | null;
  etaIso: string | null;
  urgency: Urgency;
}

interface RunoutResponse {
  tanks: RunoutTank[];
}

const MAX_ROWS = 8;

// Urgency → dot color (rose / amber / emerald palette only — no indigo/blue).
const URGENCY_DOT: Record<Urgency, string> = {
  critical: "bg-rose-500",
  urgent: "bg-amber-500",
  soon: "bg-emerald-500",
  ok: "bg-slate-400",
};

// Subtle row tint matching the urgency.
const URGENCY_TINT: Record<Urgency, string> = {
  critical: "bg-rose-500/[0.04]",
  urgent: "bg-amber-500/[0.03]",
  soon: "",
  ok: "",
};

const URGENCY_LABEL_KEY: Record<Urgency, string> = {
  critical: "dash.runoutEtaUrgencyCritical",
  urgent: "dash.runoutEtaUrgencyUrgent",
  soon: "dash.runoutEtaUrgencySoon",
  ok: "common.online",
};

/**
 * Format an ETA (in hours) as a compact duration string.
 *   >= 1 day  → "2d 4h"
 *   >= 1 hour → "8h 12m"
 *   < 1 hour  → "5m"
 *   null      → "—"
 * Numeric tokens are localized (Arabic-Indic digits when lang=ar).
 */
function formatDuration(etaHours: number | null, lang: Language, t: (k: string) => string): string {
  if (etaHours === null || !Number.isFinite(etaHours)) return "—";
  const totalMinutes = Math.max(0, Math.round(etaHours * 60));
  const days = Math.floor(totalMinutes / 1440);
  const remAfterDays = totalMinutes % 1440;
  const hours = Math.floor(remAfterDays / 60);
  const minutes = remAfterDays % 60;
  const hUnit = t("dash.runoutEtaHours");
  const dUnit = t("dash.runoutEtaDays");
  const mUnit = t("dash.runoutEtaMin");
  if (days >= 1) return `${formatNumber(days, lang)}${dUnit} ${formatNumber(hours, lang)}${hUnit}`;
  if (hours >= 1) return `${formatNumber(hours, lang)}${hUnit} ${formatNumber(minutes, lang)}${mUnit}`;
  return `${formatNumber(minutes, lang)}${mUnit}`;
}

/** Fill-% badge color: rose at critical, amber at low, emerald otherwise. */
function pctBadgeClass(pct: number): string {
  if (pct <= 12) return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400";
  if (pct <= 25) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
}

export function FuelRunoutEta() {
  const t = useT();
  const setView = useFgmp((s) => s.setView);
  const useArabicNums = useArabicNumerals();
  const numLang: Language = useArabicNums ? "ar" : "en";

  const { data, loading, error } = useApi<RunoutResponse>("/api/fgmp/fuel/runout-eta", { interval: 60_000 });

  // API already sorts by etaHours asc & filters to at-risk tanks; show the
  // top 8 most urgent. Derived from the polled payload — no extra fetch.
  const rows = (data?.tanks ?? []).slice(0, MAX_ROWS);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-amber-500" />
            {t("dash.runoutEtaTitle")}
          </CardTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("dash.runoutEtaTitle")}
                className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              >
                <Info className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] text-[11px] leading-snug font-normal">
              {t("dash.runoutEtaInfo")}
            </TooltipContent>
          </Tooltip>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 text-xs"
          onClick={() => setView("fuel")}
        >
          {t("dash.runoutEtaViewAll")}
        </Button>
      </CardHeader>

      <CardContent className="p-0">
        {loading ? (
          <div className="space-y-1.5 p-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-md border p-2.5">
                <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                </div>
                <div className="h-5 w-10 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <span>{t("dash.runoutEtaError")}</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm font-medium">{t("dash.runoutEtaEmpty")}</p>
          </div>
        ) : (
          <div className="max-h-72 divide-y overflow-y-auto pr-0.5">
            {rows.map((tk) => (
              <button
                key={tk.tankId}
                type="button"
                onClick={() => setView("fuel")}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none",
                  URGENCY_TINT[tk.urgency],
                )}
                title={`${tk.siteName} — ${tk.label} · ${t(URGENCY_LABEL_KEY[tk.urgency])} · ${t("dash.runoutEtaRate")}: ${formatNumber(tk.ratePerHour, numLang)} L/h`}
              >
                <span
                  className={cn(
                    "mt-0.5 h-2 w-2 shrink-0 rounded-full",
                    URGENCY_DOT[tk.urgency],
                    tk.urgency === "critical" && "animate-pulse-soft",
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{tk.siteName}</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {tk.label}
                    <span className="mx-1 text-muted-foreground/50">·</span>
                    {t("dash.runoutEtaRate")}: {formatNumber(tk.ratePerHour, numLang)} L/h
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      tk.urgency === "critical" && "text-rose-700 dark:text-rose-400",
                      tk.urgency === "urgent" && "text-amber-700 dark:text-amber-400",
                      tk.urgency === "soon" && "text-foreground",
                    )}
                  >
                    {formatDuration(tk.etaHours, numLang, t)}
                  </span>
                  <Badge variant="outline" className={cn("h-4 px-1 text-[9px] tabular-nums", pctBadgeClass(tk.pct))}>
                    {formatNumber(tk.pct, numLang)}%
                  </Badge>
                </div>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
