/**
 * Canonical site-health scoring (Phase 5, task 1).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Four surfaces used to answer "how healthy is this site?" and three of them
 * disagreed, which is worse than untidy: an operator comparing a site badge to
 * a regional card saw two different numbers for the same site and had no way
 * to know which was right.
 *
 *   site-health-badge.tsx        uptime×0.30 + fuel×0.25 + gen×0.20
 *                               + batt×0.15 + alarmLoad×0.10
 *   site-health-trend.tsx        uptime×0.30 + fuel×0.25 + gen×0.20
 *                               + batt×0.15 − alarmPenalty + 15
 *   region-detail-sheet.tsx      a SECOND private copy of the trend formula,
 *                               plus a region formula with entirely
 *                               different factors
 *
 * They were not three renderings of one formula; they were three formulas. The
 * badge scored battery state-of-health while the other two scored "voltage > 46",
 * and the badge folded alarms into a weighted term while the others subtracted
 * a penalty and then added back a flat 15. Same inputs, different answers.
 *
 * WHAT IS CANONICAL HERE, AND WHY
 * -------------------------------
 * The weights are the BADGE's, because it is the one an operator reads at a
 * glance on the primary dashboard surface and because its five-factor shape is
 * the only one that reports alarm pressure as a first-class factor rather than
 * as an arithmetic fudge (`-penalty +15` means zero alarms scores 15 points
 * HIGHER than a site with no measured factor at all, which is incoherent).
 *
 * The weights, and what they mean for an operator triaging a fleet:
 *
 *   uptime   30%   A site that is down is worth nothing regardless of how full
 *                   its tanks are. This is the single most urgent fact about a
 *                   site and it dominates the score.
 *   fuel     25%   The thing this platform exists to protect. Second only to
 *                   uptime, and deliberately so.
 *   gen      20%   Generation is the backup path; degradation is serious but
 *                   recoverable while fuel is not.
 *   batt     15%   Battery is the shortest-lived asset and degrades gracefully;
 *                   it should move the score without dominating it.
 *   alarms   10%   Signal about everything else, not a measure of it. Weighted
 *                   last because a busy alarm list on an otherwise healthy site
 *                   should not read as an unhealthy site.
 *
 * These sum to exactly 1.0. That is deliberate and is asserted in the test:
 * weights that silently stop summing to 1 would make the score mean nothing,
 * since factors would no longer be a weighted average.
 *
 * Empty collections score 100, not 0. A site with no tanks is not 25% worse
 * than a site whose tanks are full — it has nothing to be wrong about. This was
 * already the convention in two of the three originals and is preserved here.
 */

import type { GenStatus, TankState, GenState, BattState } from "@/lib/fgmp/types";

/**
 * Canonical factor weights. MUST sum to 1.
 *
 * Exported so a caller can render the breakdown without re-typing the numbers,
 * which is how the weights drifted apart in the first place.
 */
export const SITE_HEALTH_WEIGHTS = {
  uptime: 0.30,
  fuel: 0.25,
  generator: 0.20,
  battery: 0.15,
  alarms: 0.10,
} as const;

export type SiteHealthFactorKey = keyof typeof SITE_HEALTH_WEIGHTS;

/** Stable order for rendering the factor breakdown. */
export const SITE_HEALTH_FACTOR_ORDER: readonly SiteHealthFactorKey[] = [
  "uptime",
  "fuel",
  "generator",
  "battery",
  "alarms",
];

/**
 * Site status → uptime score.
 *
 * MAINTENANCE is 30 rather than 0 on purpose: a site down for planned work is
 * a known, scheduled condition, and scoring it as a total outage puts the
 * maintenance window on the incident list. The two former implementations
 * disagreed here (30 vs 50); 30 is chosen because a site in maintenance is
 * still not delivering, and under-reporting that hides a real risk.
 */
const UPTIME_BY_STATUS: Record<string, number> = {
  ONLINE: 100,
  DEGRADED: 60,
  MAINTENANCE: 30,
  OFFLINE: 0,
};

/** Fallback for a status string we do not recognise. */
const UNKNOWN_UPTIME_SCORE = 50;

/**
 * Battery below this voltage counts as unhealthy.
 *
 * The badge used state-of-health and the others used a 46 V threshold on a
 * 48 V nominal bank, i.e. roughly the bottom 4%. Threshold health is the more
 * honest signal: state-of-health is a slowly-moving estimate, while voltage is
 * what actually limits a battery bank right now. Voltage wins.
 */
const BATTERY_TRIP_RATIO = 0.88;

export interface SiteHealthFactors {
  uptime: number;
  fuel: number;
  generator: number;
  battery: number;
  alarms: number;
}

export interface SiteHealthInput {
  /**
   * `status` is widened to `string` deliberately. The score only ever compares
   * against "FAULT", and a call site holding an untyped row (the region sheet
   * builds generators from a local aggregate type) should not be forced to
   * cast to satisfy the scorer. Narrowing happens here instead.
   */
  site: { status: string };
  tanks: Pick<TankState, "current" | "capacity">[];
  generators: { status: string }[];
  batteries: Pick<BattState, "voltage">[];
  /** Open alarm count for the site. */
  alarmCount: number;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/** Average % full across tanks. Empty → 100 (see the header note). */
export function fuelScore(tanks: SiteHealthInput["tanks"]): number {
  if (tanks.length === 0) return 100;
  const avg =
    tanks.reduce((sum, t) => sum + (t.current / Math.max(1, t.capacity)) * 100, 0) /
    tanks.length;
  return clamp(avg);
}

/** Fraction of generators not in FAULT. Empty → 100. */
export function generatorScore(generators: SiteHealthInput["generators"]): number {
  if (generators.length === 0) return 100;
  const ok = generators.filter((g) => g.status !== "FAULT").length;
  return (ok / generators.length) * 100;
}

/**
 * Fraction of batteries above their own trip voltage. Empty → 100.
 *
 * Phase 5 (analytics task): the hardcoded absolute `> 46` this replaced scored
 * EVERY 24 V bank 0% — 24 V never reaches 46 V, healthy or not — while the
 * server-side aggregate correctly compared against nominal. Two surfaces, two
 * answers, for the same fleet. Both now use nominal-relative here.
 */
export function batteryScore(
  batteries: { voltage: number; nominalVoltage?: number }[],
): number {
  if (batteries.length === 0) return 100;
  const healthy = batteries.filter(
    (b) =>
      // A bank with no declared nominal voltage cannot be judged; treat it as
      // healthy rather than penalising an un-instrumented site.
      b.nominalVoltage == null || b.voltage > b.nominalVoltage * BATTERY_TRIP_RATIO,
  ).length;
  return (healthy / batteries.length) * 100;
}

/**
 * Alarm pressure → a 0-100 factor, not a penalty.
 *
 * Capped at 10 alarms because by then the factor is 0 and further alarms carry
 * no extra information. Mapping pressure to a bounded factor (rather than
 * subtracting it) keeps the score a weighted average, so the weights still mean
 * what they say.
 *
 * Phase 5 (analytics task): the server-side aggregate used a per-site density
 * penalty capped at 25 points. Measured against this function the two differ
 * by up to 80 points on the factor — 8 points on the 0-100 headline — so the
 * same site could read "healthy" on the dashboard and "unhealthy" on its badge.
 * The server now calls this.
 *
 * @param alarmCount open alarms. `siteCount` is accepted and IGNORED: the
 * penalty shape is kept for signature compatibility with the old aggregate,
 * which divided by site count. Per-SITE scoring has one site by definition, so
 * dividing would only mask a real alarm backlog.
 */
export function alarmScore(alarmCount: number, _siteCount?: number): number {
  const ALARM_SATURATION = 10;
  return clamp(100 - (Math.max(0, alarmCount) / ALARM_SATURATION) * 100);
}

export interface SiteHealthResult {
  /** 0-100, rounded. */
  overall: number;
  factors: SiteHealthFactors;
  /** i18n keys in canonical order, for rendering the breakdown. */
  factorKeys: { key: SiteHealthFactorKey; labelKey: string; value: number; weight: string }[];
}

const FACTOR_LABEL_KEYS: Record<SiteHealthFactorKey, string> = {
  uptime: "dash.siteUptime",
  fuel: "dash.fuelReserves",
  generator: "dash.generatorHealth",
  battery: "dash.batteryHealth",
  alarms: "dash.alarmLoad",
};

/**
 * The one implementation every surface must use.
 *
 * Pure and dependency-free so it can be called from a component, a test, or a
 * server render without pulling in React or the store.
 */
export function computeSiteHealth(input: SiteHealthInput): SiteHealthResult {
  const factors: SiteHealthFactors = {
    uptime: UPTIME_BY_STATUS[input.site.status] ?? UNKNOWN_UPTIME_SCORE,
    fuel: fuelScore(input.tanks),
    generator: generatorScore(input.generators),
    battery: batteryScore(input.batteries),
    alarms: alarmScore(input.alarmCount),
  };

  const overall = Math.round(
    SITE_HEALTH_FACTOR_ORDER.reduce(
      (sum, key) => sum + factors[key] * SITE_HEALTH_WEIGHTS[key],
      0,
    ),
  );

  return {
    overall,
    factors,
    factorKeys: SITE_HEALTH_FACTOR_ORDER.map((key) => ({
      key,
      labelKey: FACTOR_LABEL_KEYS[key],
      value: Math.round(factors[key]),
      weight: `${Math.round(SITE_HEALTH_WEIGHTS[key] * 100)}%`,
    })),
  };
}

/**
 * Band thresholds for colouring a score.
 *
 * The five-band scale is canonical, not the badge's private one. The badge had
 * five bands (excellent/good/fair/poor/critical), the trend chart had three
 * (excellent/degraded/critical) and the region sheet had three again with
 * different cut-offs — so the SAME score rendered green in one place and amber
 * in another. One scale, here, so a number cannot look healthy and unhealthy at
 * the same time.
 */
export type HealthBand = "excellent" | "good" | "fair" | "poor" | "critical";

/** Lower bound of each band, highest first. */
const BAND_THRESHOLDS: { min: number; band: HealthBand }[] = [
  { min: 90, band: "excellent" },
  { min: 75, band: "good" },
  { min: 60, band: "fair" },
  { min: 40, band: "poor" },
  { min: 0, band: "critical" },
];

export function healthBand(score: number): HealthBand {
  return BAND_THRESHOLDS.find((t) => score >= t.min)?.band ?? "critical";
}

/** Visual classes per band, so the four surfaces render identically. */
export const HEALTH_BAND_CLASSES: Record<
  HealthBand,
  { cls: string; dot: string }
> = {
  excellent: {
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  good: {
    cls: "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400",
    dot: "bg-green-500",
  },
  fair: {
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  poor: {
    cls: "border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  critical: {
    cls: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
    dot: "bg-rose-500",
  },
};