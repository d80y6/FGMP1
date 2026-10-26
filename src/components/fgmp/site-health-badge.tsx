"use client";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { TankState, GenState, BattState, SiteState } from "@/lib/fgmp/types";
import { useT } from "@/lib/fgmp/use-language";
import {
  computeSiteHealth as computeCanonicalSiteHealth,
  healthBand,
  HEALTH_BAND_CLASSES,
} from "@/lib/health/site-health-score";

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
/**
 * Phase 5 task 1: the band scale now lives in site-health-score.ts.
 * Previously this file carried its own five cut-offs while the trend chart and
 * region sheet carried three different ones, so the same score could render as
 * green in one place and amber in another.
 */
function band(score: number): { bandKey: string; cls: string; dot: string } {
  const b = healthBand(score);
  const { cls, dot } = HEALTH_BAND_CLASSES[b];
  return { bandKey: b, cls, dot };
}

export interface SiteHealthInput {
  site: Pick<SiteState, "status" | "loadKw" | "gridAvailable">;
  tanks: TankState[];
  generators: GenState[];
  batteries: BattState[];
  /** Open alarm count for the site. Phase 5: the canonical formula needs it. */
  alarmCount?: number;
}

/**
 * Phase 5 task 1: delegates to the single canonical implementation.
 *
 * This badge previously carried its own private copy of the formula, with
 * weights that matched neither the trend chart nor the region sheet. Kept as a
 * thin wrapper so existing call sites and the exported name do not change, but
 * it no longer decides anything on its own.
 */
export function computeSiteHealth({ site, tanks, generators, batteries, alarmCount = 0 }: SiteHealthInput) {
  return computeCanonicalSiteHealth({
    site,
    tanks,
    generators,
    batteries,
    alarmCount,
  });
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
  const { overall, factorKeys } = computeSiteHealth({ site, tanks, generators, batteries });
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
            {factorKeys.map((f) => (
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
                <span className="w-8 text-end tabular-nums">{f.value}</span>
                <span className="w-8 text-end text-muted-foreground">{f.weight}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
