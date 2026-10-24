import { getSystemSetting, getSystemSettingNumber } from "./metrics-settings";

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

/**
 * Fallback fuel price in YER, used ONLY to keep the platform rendering when no
 * price is configured.
 *
 * This is a DISPLAY DEFAULT, not a measurement, and `source: "default"` says so
 * in every response that carries it. Unlike the FX rate below there is a
 * defensible floor: fuel genuinely costs money, and a non-null number with a
 * visible provenance flag is more useful to an operator than a null.
 */
export const DEFAULT_FUEL_PRICE_YER_PER_L = 520;

/**
 * ── WHY THERE IS NO DEFAULT FX RATE ───────────────────────────────────────────
 *
 * An earlier revision exported `DEFAULT_FX_YER_PER_USD = 281`, derived by
 * dividing the two historical hardcoded constants (520 ÷ 1.85). That number was
 * never observed anywhere. It was an artefact of two invented values, and it
 * multiplied straight into operator-visible financial figures — most seriously
 * `stolenValueUsd`, a currency valuation of alleged fuel theft presented as
 * fact.
 *
 * The defect was not the arithmetic, it was the provenance: an exchange rate is
 * a MARKET observation with a source and a date, and this had neither. Any
 * default is a fabrication, because a rate that is wrong by even 5% silently
 * misstates a theft investigation.
 *
 * So the conversion is now OPTIONAL and refuses to guess. When no rate is
 * configured, `fxYerPerUsd` is null and every USD figure derived from it is
 * null. The measured quantity — litres — is always present, because litres are
 * measured; the currency conversion is the part that needed permission.
 */
export const DEFAULT_FX_YER_PER_USD = null;

export interface FuelPrice {
  /**
   * USD per litre, or null when no FX rate is configured.
   *
   * Null, not 0 and not a guess: an operator must be able to tell "not
   * converted" apart from "worth nothing". `analytics-view.tsx` renders these
   * with toFixed(2) on the numeric path, so callers must handle null.
   */
  usdPerLitre: number | null;
  yerPerLitre: number;
  /** YER per 1 USD, or null when unconfigured. See DEFAULT_FX_YER_PER_USD. */
  fxYerPerUsd: number | null;
  /** Where the numbers came from — surfaced so a disagreement is debuggable. */
  source: "env" | "db" | "default";
  fxSource: "env" | "db" | "unset";
  /**
   * When the configured rate was recorded, when supplied.
   *
   * A rate without a date is a number that silently rots, and an operator
   * cannot tell a current rate from one set last year. Optional because a rate
   * set in an environment variable genuinely has no recorded date.
   */
  fxAsOf?: string;
}

/**
 * Convert a YER amount to USD, or return null when no rate is configured.
 *
 * Used by every currency figure in analytics. Null propagates rather than
 * collapsing to 0, because "no rate configured" and "this fuel was worth
 * nothing" must never render identically — an operator investigating fuel theft
 * would otherwise read a missing rate as a nil loss.
 */
export function usd(amount: number | null | undefined, price: FuelPrice): number | null {
  if (amount === null || amount === undefined) return null;
  if (price.usdPerLitre === null) return null;
  return Math.round(amount * price.usdPerLitre * 100) / 100;
}

/**
 * Why a currency figure is absent, so a consumer can tell the cases apart.
 *
 * A bare `null` is ambiguous: it could mean "nothing to report", "not
 * computed", or "we declined to convert". Those are different statements and
 * collapsing them is how a missing rate becomes indistinguishable from a nil
 * loss. Same rule the notification states use.
 */
export type CurrencyUnavailableReason =
  | "NO_FX_RATE_CONFIGURED"
  | "NO_QUANTITY";

export interface CurrencyValue {
  value: number | null;
  /** Absent when `value` is a number. */
  reason?: CurrencyUnavailableReason;
}

/**
 * Whether any currency figure can be produced at all.
 *
 * True when a rate is configured, whatever the amount.
 */
export function currencyReady(price: FuelPrice): boolean {
  return price.usdPerLitre !== null;
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * One resolved price PER TENANT. Keyed by tenant id (`""` = platform defaults).
 *
 * It used to be a single module-level promise shared by the whole process, which
 * was only safe while `SystemSetting` was a platform-global table. Settings are
 * per-tenant now, so a shared value would charge one tenant's fuel price (and
 * therefore its `fuelCost` and `stolenValueUsd`) to every other tenant for the
 * lifetime of the process — this cache had no TTL at all.
 */
const FUEL_CACHE_KEY = Symbol.for("fgmp.fuel-price-cache.v1");
const fuelCacheGlobal = globalThis as unknown as Record<symbol, Map<string, Promise<FuelPrice>> | undefined>;
const cached: Map<string, Promise<FuelPrice>> = (fuelCacheGlobal[FUEL_CACHE_KEY] ??= new Map());
/**
 * TTL for this cache. It used to be FOREVER (a single promise per process), so
 * a corrected price never reached the running server. 60 s matches the settings
 * cache; an explicit PATCH also clears it (`resetFuelPriceCache`).
 */
const FUEL_CACHE_TTL_MS = 60_000;
const fuelCacheAt = new Map<string, number>();

/**
 * Resolve the single fuel price used by every cost view in analytics, FOR ONE
 * TENANT.
 *
 * Pass the authenticated tenant. `null` means "platform defaults only" and is
 * for platform-wide jobs; a request-scoped caller that passes null would ignore
 * its own tenant's override.
 *
 * The YER price always resolves. The USD price resolves ONLY when a rate is
 * actually configured — there is no fallback rate, by design; see
 * DEFAULT_FX_YER_PER_USD.
 */
export function resolveFuelPrice(tenantId?: string | null): Promise<FuelPrice> {
  const key = tenantId ?? "";
  const hit = cached.get(key);
  if (hit && Date.now() - (fuelCacheAt.get(key) ?? 0) < FUEL_CACHE_TTL_MS) return hit;
  const pending: Promise<FuelPrice> = (async () => {
    const yerEnv = positiveEnv("FGMP_FUEL_PRICE_YER_PER_L");
    const yerDb = await getSystemSettingNumber("fuelPriceYerPerL", tenantId);
    const yerPerLitre = yerEnv ?? (yerDb !== undefined && yerDb > 0 ? yerDb : DEFAULT_FUEL_PRICE_YER_PER_L);

    const fxEnv = positiveEnv("FGMP_FX_YER_PER_USD");
    const fxDb = await getSystemSettingNumber("fxYerPerUsd", tenantId);
    // No default: an unconfigured rate leaves the conversion unperformed.
    const fxYerPerUsd = fxEnv ?? (fxDb !== undefined && fxDb > 0 ? fxDb : DEFAULT_FX_YER_PER_USD);

    // Recorded alongside the rate when the operator supplies one, so a figure
    // can be traced to the rate that produced it.
    const fxAsOfEnv = process.env.FGMP_FX_AS_OF?.trim();
    const fxAsOfDb = await getSystemSetting("fxAsOf", tenantId);
    const fxAsOf = fxAsOfEnv || fxAsOfDb || undefined;

    return {
      usdPerLitre:
        fxYerPerUsd === null
          ? null
          : // 4 dp keeps the price visible at sub-cent resolution instead of
            // rounding 1.8506 down to 1.85 and hiding the difference from 1.8507.
            Math.round((yerPerLitre / fxYerPerUsd) * 10000) / 10000,
      yerPerLitre,
      fxYerPerUsd,
      source: yerEnv !== undefined ? "env" : yerDb !== undefined && yerDb > 0 ? "db" : "default",
      fxSource:
        fxEnv !== undefined
          ? "env"
          : fxDb !== undefined && fxDb > 0
            ? "db"
            : "unset",
      ...(fxAsOf ? { fxAsOf } : {}),
    };
  })();
  cached.set(key, pending);
  fuelCacheAt.set(key, Date.now());
  return pending;
}

/** Test hook. With no argument every tenant's cache is dropped. */
export function resetFuelPriceCache(tenantId?: string | null): void {
  if (tenantId === undefined) {
    cached.clear();
    fuelCacheAt.clear();
    return;
  }
  cached.delete(tenantId ?? "");
  fuelCacheAt.delete(tenantId ?? "");
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