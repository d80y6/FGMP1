/**
 * Shared status vocabulary and colour mappings.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two components carried byte-identical copies of `determineStatus(kpis)` and
 * three more each declared their own site-status colour table, in three
 * different representations (SVG hex, Tailwind text/border classes, dot
 * classes). Nothing forced them to agree, so a status could be amber in the
 * header and green on the map after a one-sided edit.
 *
 * The rules live here once. The representations stay explicit because they
 * genuinely differ — an SVG fill cannot use a Tailwind class — but they are
 * keyed off the same status names and sit next to each other, so drift is
 * visible in a single diff.
 *
 * Pure: no React, no store, no DOM. Safe from a component, a test, or a server
 * render.
 */

import type { Kpis } from "./types";

/** Three-tier system health used by the header banner and mini indicator. */
export type SystemStatusLevel = "OPERATIONAL" | "DEGRADED" | "CRITICAL";

/**
 * Overall system status from the fleet KPIs.
 *
 *  - CRITICAL:  offlineSites >= 3 OR alarmsL3 >= 5 OR
 *               (alarmsL3 > 0 AND tanksCritical > 5)
 *  - DEGRADED:  offlineSites > 0 OR alarmsL3 > 0 OR
 *               tanksCritical > 2 OR generatorsFault > 0
 *  - OPERATIONAL: otherwise
 */
export function determineSystemStatus(k: Kpis): SystemStatusLevel {
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

/**
 * Site status → SVG fill. Used by the national map (fills cannot be classes).
 *
 * MAINTENANCE is purple here and sky-blue in the class-based maps below; that
 * difference predates this module and is kept deliberately: purple reads as a
 * planned state on a land map, sky-blue reads as "informational" in a table.
 * The four status NAMES are what must not drift.
 */
export const SITE_STATUS_HEX: Record<string, string> = {
  ONLINE: "#10b981",
  DEGRADED: "#f59e0b",
  OFFLINE: "#f43f5e",
  MAINTENANCE: "#a855f7",
};

/** Site status → Tailwind text/border/background trio (comparison tables). */
export function siteStatusTextClass(status: string): string {
  switch (status) {
    case "ONLINE":
      return "text-emerald-500 border-emerald-500/30 bg-emerald-500/10";
    case "DEGRADED":
      return "text-amber-500 border-amber-500/30 bg-amber-500/10";
    case "OFFLINE":
      return "text-rose-500 border-rose-500/30 bg-rose-500/10";
    case "MAINTENANCE":
      return "text-sky-500 border-sky-500/30 bg-sky-500/10";
    default:
      return "text-muted-foreground";
  }
}

/** Site status → dot background class (compact lists / widgets). */
export function siteStatusDotClass(status: string): string {
  switch (status) {
    case "ONLINE":
      return "bg-emerald-500";
    case "DEGRADED":
      return "bg-amber-500";
    case "OFFLINE":
      return "bg-rose-500";
    case "MAINTENANCE":
      return "bg-sky-500";
    default:
      return "bg-slate-400";
  }
}
