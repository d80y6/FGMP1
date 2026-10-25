/**
 * Three-tier "score tone" classes for the region surfaces.
 *
 * The region detail sheet and the region leaderboard both render the same
 * computed 0–100 score, and both had their own copy of these three if-chains
 * with identical 85/70 cut-offs and identical Tailwind strings. Two copies of
 * a colour scale drift: a component-local edit turns the same number green in
 * the sheet and amber in the board. The table lives here once.
 *
 * NOTE — these cut-offs are deliberately NOT the canonical health bands in
 * `@/lib/health/site-health-score`. Region scores measure a different thing
 * (stability/fuel/generator activity/coverage across many sites) and use a
 * three-tier presentation; site health uses five bands. Keep the two scales
 * separate, but keep each one in a single place.
 */

const EMERALD = {
  text: "text-emerald-500",
  bar: "bg-gradient-to-r from-emerald-500 to-emerald-400",
  badge:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
} as const;

const AMBER = {
  text: "text-amber-500",
  bar: "bg-gradient-to-r from-amber-500 to-amber-400",
  badge:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
} as const;

const ROSE = {
  text: "text-rose-500",
  bar: "bg-gradient-to-r from-rose-500 to-rose-400",
  badge: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400",
} as const;

function tone(score: number): typeof EMERALD | typeof AMBER | typeof ROSE {
  if (score >= 85) return EMERALD;
  if (score >= 70) return AMBER;
  return ROSE;
}

/** Text colour for a region score. */
export function scoreTextClass(score: number): string {
  return tone(score).text;
}

/** Progress-bar gradient for a region score. */
export function scoreBarClass(score: number): string {
  return tone(score).bar;
}

/** Badge border/background/text for a region score. */
export function scoreBadgeClass(score: number): string {
  return tone(score).badge;
}
