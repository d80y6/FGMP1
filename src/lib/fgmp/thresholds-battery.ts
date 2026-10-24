import { getSystemSettingNumber } from "./metrics-settings";

/**
 * FGMP battery low-voltage threshold — ONE definition, used by every read site.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * THE BUG THIS FIXES
 *
 * Before this module there were four independent definitions of "low battery"
 * voltage, spanning 5.2 V on the same nominal 48 V bank:
 *
 *   .fgmp-settings.json battLowVoltagePct 88   → 48 × 0.88 = 42.24 V
 *   api/fgmp/settings/route.ts battVoltageMin  → 46.00 V (absolute)
 *   engine.ts:466  (raises BATT_LOW_VOLTAGE) → nominalVoltage × 0.85 = 40.80 V
 *   engine.ts:1248 (KPI `batteriesLow`)      → nominalVoltage × 0.88 = 42.24 V
 *   api/fgmp/analytics/route.ts "Battery Health" → `b.voltage > 46` (absolute)
 *
 * The absolute `> 46` rule is the worst of them: seeded banks are
 * `nomV = pick([24, 48])` (src/lib/fgmp/seed.ts:231), so for a 24 V bank
 * `voltage > 46` is NEVER true and every 24 V bank scored 0% battery health
 * for the whole fleet — even a fully charged 24.0 V bank.
 *
 * THE RULE
 *
 * The trip point is always RELATIVE TO THE BANK'S OWN NOMINAL VOLTAGE:
 *
 *     tripVolts = nominalVoltage × (battLowVoltagePct / 100)
 *
 * which gives 42.24 V for a 48 V bank and 21.12 V for a 24 V bank. A 24 V
 * bank at 21.6 V (the seeded minimum, `nomV × 0.9`) is therefore healthy, and a
 * 48 V bank at 46 V is healthy too — both now scored 0%.
 *
 * CONFIGURATION
 *
 * Resolved in order:
 *   1. `FGMP_BATT_LOW_VOLTAGE_PCT` env var
 *   2. `SystemSetting.battLowVoltagePct` (live DB store; percent of nominal)
 *   3. `DEFAULT_BATT_LOW_VOLTAGE_PCT` (88) — matches `.fgmp-settings.json`
 *
 * The legacy absolute key `SystemSetting.battVoltageMin` is deliberately NOT
 * read here: it is expressed in volts and is therefore meaningless for a 24 V
 * bank. Reading it would re-import the original bug. See the review notes for
 * the change needed in `api/fgmp/settings/route.ts` / `engine.ts`.
 */

/** Percent-of-nominal at or above which a battery bank is considered healthy. */
export const DEFAULT_BATT_LOW_VOLTAGE_PCT = 88;

/** Sanity bounds for the configured percent — outside this we ignore the setting. */
const MIN_PCT = 1;
const MAX_PCT = 200;

/**
 * Resolved percent per tenant (`""` = platform defaults).
 *
 * A single process-wide value was correct only while settings were global. Now
 * that `SystemSetting` rows carry a tenant, one tenant's threshold must not
 * become every tenant's threshold: this number decides when a battery raises
 * BATT_LOW_VOLTAGE, so sharing it would both hide one tenant's alarms and raise
 * spurious ones for another.
 */
const PCT_CACHE_KEY = Symbol.for("fgmp.batt-threshold-cache.v1");
const pctGlobal = globalThis as unknown as Record<symbol, Map<string, Promise<number>> | undefined>;
const cachedPct: Map<string, Promise<number>> = (pctGlobal[PCT_CACHE_KEY] ??= new Map());

/**
 * Resolve the configured low-voltage percent-of-nominal for a tenant.
 * `null` = platform defaults only (platform-wide jobs).
 */
export function resolveBattLowVoltagePct(tenantId?: string | null): Promise<number> {
  const key = tenantId ?? "";
  const hit = cachedPct.get(key);
  if (hit) return hit;
  const pending = (async () => {
    const fromEnv = Number(process.env.FGMP_BATT_LOW_VOLTAGE_PCT);
    if (Number.isFinite(fromEnv) && fromEnv >= MIN_PCT && fromEnv <= MAX_PCT) return fromEnv;
    const fromDb = await getSystemSettingNumber("battLowVoltagePct", tenantId);
    if (fromDb !== undefined && fromDb >= MIN_PCT && fromDb <= MAX_PCT) return fromDb;
    return DEFAULT_BATT_LOW_VOLTAGE_PCT;
  })();
  cachedPct.set(key, pending);
  return pending;
}

/** Test hook: forget the resolved percent (all tenants, or one). */
export function resetBattThresholdCache(tenantId?: string | null): void {
  if (tenantId === undefined) cachedPct.clear();
  else cachedPct.delete(tenantId ?? "");
}

/**
 * Low-voltage trip point in volts for one bank.
 *
 *   battLowVoltageTripVolts(48, 88) → 42.24
 *   battLowVoltageTripVolts(24, 88) → 21.12
 *
 * Returns `null` for a non-positive nominal voltage so callers cannot silently
 * divide by (or compare against) a nonsense bank.
 */
export function battLowVoltageTripVolts(
  nominalVoltage: number,
  pct: number = DEFAULT_BATT_LOW_VOLTAGE_PCT,
): number | null {
  if (!Number.isFinite(nominalVoltage) || nominalVoltage <= 0) return null;
  return Math.round(nominalVoltage * (pct / 100) * 100) / 100;
}

/** Measured voltage expressed as a percent of nominal. 46 V on a 48 V bank → 95.8. */
export function battVoltagePctOfNominal(voltage: number, nominalVoltage: number): number | null {
  if (!Number.isFinite(nominalVoltage) || nominalVoltage <= 0) return null;
  if (!Number.isFinite(voltage)) return null;
  return (voltage / nominalVoltage) * 100;
}

/**
 * True when the bank is at or below its own low-voltage trip point.
 * A bank with a bogus nominal voltage is never reported low (we do not know),
 * which matches the previous `b.voltage > 46` outcome for missing data.
 */
export function isBatteryLowVoltage(
  voltage: number,
  nominalVoltage: number,
  pct: number = DEFAULT_BATT_LOW_VOLTAGE_PCT,
): boolean {
  const trip = battLowVoltageTripVolts(nominalVoltage, pct);
  if (trip === null || !Number.isFinite(voltage)) return false;
  return voltage <= trip;
}

export interface BatteryBankReading {
  voltage: number;
  nominalVoltage: number;
}

/**
 * Fleet battery health as a percentage of banks above their own trip point.
 *
 * Replaces `batteries.filter((b) => b.voltage > 46).length / batteries.length`
 * which was 0% for a fleet containing any 24 V bank.
 *
 * Banks with a non-positive nominal voltage are excluded from BOTH numerator
 * and denominator (they cannot be scored) and reported separately via
 * `unscored` so the caller can surface the data-quality gap rather than hide it.
 */
export function fleetBatteryHealthPct(
  banks: readonly BatteryBankReading[],
  pct: number = DEFAULT_BATT_LOW_VOLTAGE_PCT,
): { healthPct: number; healthy: number; total: number; unscored: number } {
  let healthy = 0;
  let scored = 0;
  let unscored = 0;
  for (const b of banks) {
    const trip = battLowVoltageTripVolts(b.nominalVoltage, pct);
    if (trip === null) { unscored++; continue; }
    scored++;
    if (b.voltage > trip) healthy++;
  }
  return {
    healthPct: scored > 0 ? (healthy / scored) * 100 : 100,
    healthy,
    total: scored,
    unscored,
  };
}