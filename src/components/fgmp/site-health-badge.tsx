"use client";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { TankState, GenState, BattState, SiteState } from "@/lib/fgmp/types";
import { useT } from "@/lib/fgmp/use-language";

/**
 * Per-site Health Score badge.
 * Computes a 0-100 score from tank/gen/batt/site state with weighted factors,
 * then renders a compact colored pill with tooltip showing the factor breakdown.
 *
 * Factors (same weighting as the national widget):
 *  - Site uptime (status)      30%
 *  - Fuel reserves (avg tank)  25%
 *  - Generator health          20%
 *  - Battery health            15%
 *  - Alarm load                10%  (approximated from offline/degraded status)
 */
function band(score: number): { bandKey: string; cls: string; dot: string } {
  if (score >= 90) return { bandKey: "excellent", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" };
  if (score >= 75) return { bandKey: "good", cls: "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400", dot: "bg-green-500" };
  if (score >= 60) return { bandKey: "fair", cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" };
  if (score >= 40) return { bandKey: "poor", cls: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400", dot: "bg-orange-500" };
  return { bandKey: "critical", cls: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400", dot: "bg-rose-500" };
}

export interface SiteHealthInput {
  site: Pick<SiteState, "status" | "loadKw" | "gridAvailable">;
  tanks: TankState[];
  generators: GenState[];
  batteries: BattState[];
}

export function computeSiteHealth({ site, tanks, generators, batteries }: SiteHealthInput) {
  // Site uptime (30%) — ONLINE=100, DEGRADED=60, MAINTENANCE=30, OFFLINE=0
  const uptimeMap: Record<string, number> = { ONLINE: 100, DEGRADED: 60, MAINTENANCE: 30, OFFLINE: 0 };
  const uptime = uptimeMap[site.status] ?? 50;

  // Fuel reserves (25%) — avg % full across tanks
  let fuelPct = 100;
  if (tanks.length > 0) {
    const avg = tanks.reduce((s, t) => s + (t.current / t.capacity) * 100, 0) / tanks.length;
    fuelPct = avg;
  }

  // Generator health (20%) — non-FAULT fraction (RUNNING/STOPPED/MAINTENANCE all OK, FAULT is bad)
  let genHealth = 100;
  if (generators.length > 0) {
    const ok = generators.filter((g) => g.status !== "FAULT").length;
    genHealth = (ok / generators.length) * 100;
  }

  // Battery health (15%) — avg state-of-health
  let battHealth = 100;
  if (batteries.length > 0) {
    const avg = batteries.reduce((s, b) => s + b.stateOfHealth, 0) / batteries.length;
    battHealth = avg;
  }

  // Alarm load (10%) — heuristic: OFFLINE/DEGRADED indicates alarm pressure
  const alarmLoad = site.status === "ONLINE" ? 100 : site.status === "DEGRADED" ? 50 : 10;

  const overall = Math.round(uptime * 0.3 + fuelPct * 0.25 + genHealth * 0.2 + battHealth * 0.15 + alarmLoad * 0.1);
  return {
    overall,
    factors: [
      { labelKey: "dash.siteUptime", value: Math.round(uptime), weight: "30%" },
      { labelKey: "dash.fuelReserves", value: Math.round(fuelPct), weight: "25%" },
      { labelKey: "dash.generatorHealth", value: Math.round(genHealth), weight: "20%" },
      { labelKey: "dash.batteryHealth", value: Math.round(battHealth), weight: "15%" },
      { labelKey: "dash.alarmLoad", value: Math.round(alarmLoad), weight: "10%" },
    ],
  };
}

interface SiteHealthBadgeProps {
  site: Pick<SiteState, "status" | "loadKw" | "gridAvailable">;
  tanks: TankState[];
  generators: GenState[];
  batteries: BattState[];
  compact?: boolean;
}

export function SiteHealthBadge({ site, tanks, generators, batteries, compact = false }: SiteHealthBadgeProps) {
  const t = useT();
  const { overall, factors } = computeSiteHealth({ site, tanks, generators, batteries });
  const b = band(overall);
  const bandLabel = t(`health.${b.bandKey}`);
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex cursor-help items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
              b.cls
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", b.dot)} />
            {overall}
            {!compact && <span className="opacity-80">· {bandLabel}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="p-0 overflow-hidden">
          <div className="min-w-[200px] space-y-1.5 p-3">
            <div className="flex items-baseline justify-between border-b pb-1.5">
              <p className="text-xs font-semibold">{t("health.siteHealthScore")}: {overall}/100</p>
              <p className="text-[10px] text-muted-foreground">{bandLabel}</p>
            </div>
            {factors.map((f) => (
              <div key={f.labelKey} className="flex items-center gap-2 text-[10px]">
                <span className="w-20 text-muted-foreground">{t(f.labelKey)}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      f.value >= 75 ? "bg-emerald-500" : f.value >= 50 ? "bg-amber-500" : "bg-rose-500"
                    )}
                    style={{ width: `${f.value}%` }}
                  />
                </div>
                <span className="w-8 text-right tabular-nums">{f.value}</span>
                <span className="w-8 text-right text-muted-foreground">{f.weight}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
