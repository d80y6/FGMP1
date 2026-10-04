"use client";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Kpis } from "@/lib/fgmp/types";

type StatusLevel = "OPERATIONAL" | "DEGRADED" | "CRITICAL";

/**
 * Determine overall system status from KPIs — same 3-tier logic as SystemStatusBanner.
 *  - CRITICAL:  offlineSites >= 3 OR alarmsL3 >= 5 OR (alarmsL3 > 0 AND tanksCritical > 5)
 *  - DEGRADED:  offlineSites > 0 OR alarmsL3 > 0 OR tanksCritical > 2 OR generatorsFault > 0
 *  - OPERATIONAL: otherwise
 */
function determineStatus(k: Kpis): StatusLevel {
  if (
    k.offlineSites >= 3 ||
    k.alarmsL3 >= 5 ||
    (k.alarmsL3 > 0 && k.tanksCritical > 5)
  ) {
    return "CRITICAL";
  }
  if (
    k.offlineSites > 0 ||
    k.alarmsL3 > 0 ||
    k.tanksCritical > 2 ||
    k.generatorsFault > 0
  ) {
    return "DEGRADED";
  }
  return "OPERATIONAL";
}

const PILL_STYLES: Record<StatusLevel, string> = {
  OPERATIONAL: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  DEGRADED: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  CRITICAL: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
};

const DOT_STYLES: Record<StatusLevel, string> = {
  OPERATIONAL: "bg-emerald-500",
  DEGRADED: "bg-amber-500",
  CRITICAL: "bg-rose-500 animate-pulse",
};

interface MiniStatusIndicatorProps {
  kpis: Kpis;
}

export function MiniStatusIndicator({ kpis }: MiniStatusIndicatorProps) {
  const status = determineStatus(kpis);

  // Build tooltip breakdown — only non-zero items
  const issues: string[] = [];
  if (kpis.alarmsL3 > 0) issues.push(`${kpis.alarmsL3} L3 Critical Alarm${kpis.alarmsL3 !== 1 ? "s" : ""}`);
  if (kpis.generatorsFault > 0) issues.push(`${kpis.generatorsFault} Gen Fault${kpis.generatorsFault !== 1 ? "s" : ""}`);
  if (kpis.offlineSites > 0) issues.push(`${kpis.offlineSites} Offline Site${kpis.offlineSites !== 1 ? "s" : ""}`);
  if (kpis.tanksCritical > 0) issues.push(`${kpis.tanksCritical} Critical Tank${kpis.tanksCritical !== 1 ? "s" : ""}`);
  if (kpis.alarmsL2 > 0) issues.push(`${kpis.alarmsL2} L2 Warning${kpis.alarmsL2 !== 1 ? "s" : ""}`);
  if (kpis.batteriesLow > 0) issues.push(`${kpis.batteriesLow} Low Batter${kpis.batteriesLow !== 1 ? "ies" : "y"}`);

  const tooltipText = issues.length > 0 ? issues.join(" · ") : "No active issues";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            PILL_STYLES[status]
          )}
        >
          <span className={cn("h-2 w-2 rounded-full", DOT_STYLES[status])} />
          {status}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">
        {tooltipText}
      </TooltipContent>
    </Tooltip>
  );
}
