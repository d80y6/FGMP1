import type { RegionBreakdownRow } from "@/lib/fgmp/types";

/**
 * Region performance scoring — one implementation, two surfaces.
 *
 * The leaderboard and the performance trend each carried their own copy of this
 * formula, with a comment in the trend pointing at the other file. They agreed
 * to the decimal, which is exactly the situation that lasts until someone edits
 * one of them: the leaderboard would rank a region first while the trend chart
 * drew it second, and neither file would look wrong on its own.
 *
 * The weights and the 100 % fuel baseline are the definition of the score, so
 * they live here rather than being re-derived at each call site.
 */

/** Avg fuel tank capacity per site, in litres — the denominator for "fuel availability". */
export const AVG_TANK_CAPACITY_PER_SITE = 5000;

export interface RegionScoreFactors {
  /** Alarm density, 100 % until alarms exceed 5 % of sites, then straight down. */
  stability: number;
  /** Fuel on hand against `sites × 5000 L`, capped at 100 %. */
  fuelAvail: number;
  /** Running generators per site, capped at 100 %. */
  genActivity: number;
  /** The region's share of the national fleet. */
  coverage: number;
}

export interface RegionScore {
  score: number;
  factors: RegionScoreFactors;
}

/**
 * Compute the 0-100 score for a region:
 *  - online stability (35 %)
 *  - fuel availability (25 %)
 *  - generator activity (20 %)
 *  - site coverage (20 %)
 */
export function scoreRegion(r: RegionBreakdownRow, totalSites: number): RegionScore {
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
