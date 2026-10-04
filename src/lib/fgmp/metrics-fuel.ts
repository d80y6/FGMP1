import { getSystemSettingNumber } from "./metrics-settings";

/**
 * FGMP fuel money + capacity-weighted fuel statistics.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * TWO MONEY CONSTANTS USED TO DISAGREE
 *
 *   engine.ts:26               UNIT_PRICE_YER_PER_L = 520   (Yemeni Rial / litre)
 *   analytics/route.ts:166     FUEL_PRICE_PER_L     = 1.85  (USD / litre)
 *
 * Two unrelated hardcoded numbers for the same physical quantity. This module
 * makes the USD figure DERIVE from the engine's YER constant via one
 * configurable FX rate, so by default the two cost views agree instead of
 * silently drifting apart:
 *
 *     priceUsd = priceYer / fxYerPerUsd
 *
 * With the defaults (520 YER/L ÷ 281 YER/USD) that is 1.8506 USD/L, i.e. the
 * same 1.85 the analytics route used to hardcode — but now it moves with the
 * engine's price instead of being a second constant.
 *
 * CONFIGURATION (first hit wins)
 *   1. FGMP_FUEL_PRICE_YER_PER_L  (default 520 — matches engine.ts:26)
 *   2. SystemSetting.fuelPriceYerPerL
 *   3. FGMP_FX_YER_PER_USD       (default 281)
 *   4. SystemSetting.fxYerPerUsd
 *
 * The analytics response keeps `fuelCost.pricePerLitre` as a NUMBER because
 * `analytics-view.tsx` calls `a.fuelCost.pricePerLitre.toFixed(2)`; the YER
 * figure and the provenance are exposed in sibling fields.
 */

/** Must match `UNIT_PRICE_YER_PER_L` in src/lib/fgmp/engine.ts. */
export const DEFAULT_FUEL_PRICE_YER_PER_L = 520;

/**
 * 281 YER/USD is the rate implied by the two historical constants
 * (520 ÷ 1.85 = 281.08). Replace with the operator's real rate.
 */
export const DEFAULT_FX_YER_PER_USD = 281;

export interface FuelPrice {
  /** Numerically identical to `pricePerLitre` (USD per litre) for compatibility. */
  usdPerLitre: number;
  yerPerLitre: number;
  /** YER per 1 USD. */
  fxYerPerUsd: number;
  /** Where the numbers came from — surfaced so a disagreement is debuggable. */
  source: "env" | "db" | "default";
  fxSource: "env" | "db" | "default";
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

let cached: Promise<FuelPrice> | null = null;

/** Resolve the single fuel price used by every cost view in analytics. */
export function resolveFuelPrice(): Promise<FuelPrice> {
  if (cached) return cached;
  cached = (async () => {
    const yerEnv = positiveEnv("FGMP_FUEL_PRICE_YER_PER_L");
    const yerDb = await getSystemSettingNumber("fuelPriceYerPerL");
    const yerPerLitre = yerEnv ?? (yerDb !== undefined && yerDb > 0 ? yerDb : DEFAULT_FUEL_PRICE_YER_PER_L);

    const fxEnv = positiveEnv("FGMP_FX_YER_PER_USD");
    const fxDb = await getSystemSettingNumber("fxYerPerUsd");
    const fxYerPerUsd = fxEnv ?? (fxDb !== undefined && fxDb > 0 ? fxDb : DEFAULT_FX_YER_PER_USD);

    return {
      // 4 dp keeps the price visible at sub-cent resolution instead of rounding
      // 1.8506 down to 1.85 and hiding the difference from 1.8507.
      usdPerLitre: Math.round((yerPerLitre / fxYerPerUsd) * 10000) / 10000,
      yerPerLitre,
      fxYerPerUsd,
      source: yerEnv !== undefined ? "env" : yerDb !== undefined && yerDb > 0 ? "db" : "default",
      fxSource: fxEnv !== undefined ? "env" : fxDb !== undefined && fxDb > 0 ? "db" : "default",
    };
  })();
  return cached;
}

/** Test hook. */
export function resetFuelPriceCache(): void {
  cached = null;
}

// ── Capacity-weighted fuel percentage ─────────────────────────────────────

export interface TankLevel {
  current: number;
  capacity: number;
}

export interface WeightedFuelPct {
  /** Σcurrent / Σcapacity × 100, or `null` when nothing is scorable. */
  pct: number | null;
  currentLitres: number;
  capacityLitres: number;
  scoredTanks: number;
  /** Tanks excluded because capacity <= 0 or a value was not finite. */
  unscoredTanks: number;
}

/**
 * Fleet/site fuel percentage as litres, not as a mean of ratios.
 *
 * The old code did `mean(current / capacity)`. With a 10 000 L tank at 90% and a
 * 1 000 L tank at 10% that is (90 + 10) / 2 = 50.0%, while the engine KPI's
 * `sum(current) / sum(capacity)` gives 9 100 / 11 000 = 82.7%. The latter is the
 * correct statistic (it answers "what fraction of the diesel do we have?") and
 * it is the one the engine KPI already uses, so the two now agree.
 *
 * `pct` is `null` — never `NaN`, never `Infinity` — when no tank is scorable.
 * `FuelTank.capacityLitres` has no DB-level minimum, so a capacity=0 row used
 * to yield `0/0 = NaN` and surface the literal string "NaN" in the UI.
 */
export function capacityWeightedFuelPct(tanks: readonly TankLevel[]): WeightedFuelPct {
  let currentLitres = 0;
  let capacityLitres = 0;
  let scoredTanks = 0;
  let unscoredTanks = 0;
  for (const t of tanks) {
    const cap = Number(t.capacity);
    const cur = Number(t.current);
    if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(cur)) {
      unscoredTanks++;
      continue;
    }
    currentLitres += cur;
    capacityLitres += cap;
    scoredTanks++;
  }
  return {
    pct: capacityLitres > 0 ? (currentLitres / capacityLitres) * 100 : null,
    currentLitres,
    capacityLitres,
    scoredTanks,
    unscoredTanks,
  };
}

/** `capacity > 0 ? current / capacity : null` — never NaN, never Infinity. */
export function safeTankPct(current: number, capacity: number): number | null {
  if (!Number.isFinite(capacity) || capacity <= 0) return null;
  if (!Number.isFinite(current)) return null;
  return (current / capacity) * 100;
}