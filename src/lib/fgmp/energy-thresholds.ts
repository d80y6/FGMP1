/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ENERGY-DOMAIN THRESHOLDS — battery + solar, provenance-carrying
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Follows the discipline of `interlock-thresholds.ts`: every value states where
 * it came from, and an invented number is marked INFERRED rather than dressed up
 * as an engineering standard.
 *
 * ── WHY A SEPARATE MODULE ──────────────────────────────────────────────────
 * `interlock-thresholds.ts` holds values that REFUSE an action: refusing to
 * crank a generator, refusing to assume load above a coolant temperature. Those
 * gate hardware control, so their failure direction is "over-refuse".
 *
 * The values here ALARM rather than block: a low state of charge raises a
 * warning, a high cell imbalance raises a maintenance ticket. Nothing is
 * prevented, so an over-tight number produces a noisy dashboard rather than an
 * outage. They are still provenance-carrying because "the platform flagged the
 * fleet every 40 minutes" is an operational cost, and an operator who cannot
 * see WHY a limit fired cannot turn it off.
 *
 * ── WHAT IS NOT HERE, AND WHY ──────────────────────────────────────────────
 * Low-battery VOLTAGE is deliberately absent. It already has a single definition
 * in `thresholds-battery.ts` (`DEFAULT_BATT_LOW_VOLTAGE_PCT = 88`, resolved from
 * env → SystemSetting → default, and expressed as a percentage of the bank's own
 * nominal voltage so a 24 V bank is not compared against a 48 V trip point).
 * Defining it again here would reintroduce exactly the four-way divergence that
 * module was written to end. This file adds only what does not exist.
 *
 * ── EVERY DEFAULT HERE IS INFERRED ─────────────────────────────────────────
 * No number below came from an OEM datasheet, a site policy or a maintenance
 * schedule. The specification this platform was built from contains no safety or
 * alarm values. The honest state of each is "somebody guessed, in the
 * direction that makes the platform quieter rather than noisier" — except where
 * the comment says otherwise. An operator holding a real document should
 * override these rather than treat them as authoritative.
 */

import type { ThresholdSource, ThresholdUnit } from "./interlock-thresholds";

export type EnergyUnit = ThresholdUnit | "KWP" | "KWH_PER_DAY"; // MILLIVOLTS, PERCENT now in ThresholdUnit via Phase 4 migration

/** The subset of the interlock threshold shape the energy domain uses. */
export interface EnergyThreshold<T extends number = number> {
  readonly key: string;
  readonly value: T;
  readonly unit: EnergyUnit;
  readonly source: ThresholdSource;
  readonly sourceRef?: string;
  readonly confirmedBy?: string | null;
  readonly confirmedAt?: Date | null;
  readonly rationale: string;
  readonly confirmWith: string;
}

/**
 * `MILLIVOLTS` and `PERCENT` are members of the shared `ThresholdUnit` now, so
 * only the solar-specific units remain local. `KWH_PER_DAY` is unused today —
 * daily yield is compared as a RATIO against rated capacity rather than as an
 * absolute, precisely because kWh is not comparable across a mixed fleet. It is
 * kept for the case where a site publishes a contracted daily yield.
 */

export const ENERGY_THRESHOLD_KEYS = [
  // Battery
  "battLowSocPct",
  "battCriticalSocPct",
  "battHighTempC",
  "battCellImbalanceMv",
  "battEndOfLifeCycles",
  // Solar
  "solarLowIrradianceWm2",
  "solarMinExpectedYieldFactorPct",
] as const;

export type EnergyThresholdKey = (typeof ENERGY_THRESHOLD_KEYS)[number];

const E = (
  key: EnergyThresholdKey,
  o: {
    value: number;
    unit: EnergyUnit;
    source: ThresholdSource;
    rationale: string;
    confirmWith: string;
    sourceRef?: string;
  },
): EnergyThreshold => Object.freeze({ key, confirmedBy: null, confirmedAt: null, ...o });

/**
 * The defaults. All INFERRED unless the comment claims otherwise.
 *
 * The direction of failure is chosen per value and stated in `rationale`, so an
 * operator can tell whether a noisy threshold should be loosened or a quiet one
 * tightened.
 */
export const DEFAULT_ENERGY_THRESHOLDS = Object.freeze({
  /**
   * State of charge below which a bank is reported LOW.
   *
   * 40% is well above the point where a VRLA bank suffers lasting damage, and
   * chosen LOW rather than tight: a bank idles between 45-60% for days in
   * telecom backup duty, so a higher limit would alarm permanently on a healthy
   * bank that simply spends most of its life on float charge.
   */
  battLowSocPct: E("battLowSocPct", {
    value: 40,
    unit: "PERCENT",
    source: "INFERRED",
    rationale:
      "Warn below this state of charge. Deliberately loose so a bank idling on float charge in the 45-60% band is not alarmed permanently.",
    confirmWith:
      "The battery manufacturer's minimum discharge depth of the installed cells, or the site's backup-runtime requirement (how long the bank must carry the site at full outage).",
  }),

  /**
   * State of charge below which the bank is reported CRITICAL.
   *
   * 20% rather than 10%: on a 48 V VRLA string this is deep into voltage sag
   * under load, so it is the point at which the bank is genuinely at risk, not
   * merely low. Chosen to be meaningfully below battLowSocPct so the two levels
   * cannot collapse into one another on a noisy reading.
   */
  battCriticalSocPct: E("battCriticalSocPct", {
    value: 20,
    unit: "PERCENT",
    source: "INFERRED",
    rationale:
      "Critical below this state of charge — deep into load-voltage sag for a VRLA string, not merely low.",
    confirmWith:
      "The battery manufacturer's end-discharge voltage and the site's actual backup autonomy requirement.",
  }),

  /**
   * Bank temperature above which a thermal concern is reported.
   *
   * 45 °C is the widely used start-of-life rating case for VRLA at 20 °C, derated
   * for elevated temperature; above roughly 45 °C the expected service life
   * drops materially. Chosen as a WARNING and not a block because elevated
   * temperature in a DC room is usually an HVAC fault the operator should see
   * rather than have the battery electrically isolated by software.
   */
  battHighTempC: E("battHighTempC", {
    value: 45,
    unit: "CELSIUS",
    source: "INFERRED",
    rationale:
      "Report elevated temperature. Usually an HVAC fault rather than a battery fault, so it warns and does not block.",
    confirmWith:
      "The battery manufacturer's maximum ambient operating temperature, and the site's DC room design ambient.",
  }),

  /**
   * Worst-cell deviation from the bank mean, in millivolts.
   *
   * 50 mV is the figure most widely quoted as the point at which cells in a
   * series string begin to diverge materially over a charge cycle. It is
   * checked on the MAXIMUM ABSOLUTE deviation, not a spread, because the Modbus
   * reader returns a signed per-cell delta from the mean (cellBalanceMv) and a
   * one-sided reading is just as diagnostic as a symmetric one.
   *
   * INFERRED rather than datasheet: the reader's own register scale is what
   * makes the comparison meaningful, and that must be confirmed against the
   * actual BMS, because a reader reporting per-cell rather than per-string delta
   * changes the number by a large factor.
   */
  battCellImbalanceMv: E("battCellImbalanceMv", {
    value: 50,
    unit: "MILLIVOLTS",
    source: "INFERRED",
    rationale:
      "Report when the worst cell deviates this far from the bank mean. Checked on absolute deviation so a one-sided reading still registers.",
    confirmWith:
      "The BMS register map — specifically whether cellBalanceMv is a per-cell delta from the mean or a per-string delta — plus the cell manufacturer's maximum permitted cell-to-cell spread.",
  }),

  /**
   * Discharge cycles at which end-of-life is reported.
   *
   * 1500 is the commonly quoted design life for a stationary VRLA float
   * application, but it is the CLIMATIC design life and real banks are retired
   * substantially earlier at elevated temperature. Marked INFERRED precisely
   * because quoting the design figure as if it were the retirement point would
   * overstate expected life.
   */
  battEndOfLifeCycles: E("battEndOfLifeCycles", {
    value: 1500,
    unit: "HOURS",
    source: "INFERRED",
    rationale:
      "Report end-of-life past this many discharge cycles. This is the climatic DESIGN life; real retirement is earlier at elevated temperature, so treat it as an upper bound.",
    confirmWith:
      "The cell manufacturer's rated cycle life for the installed chemistry at the site's design ambient temperature.",
  }),

  /**
   * Plane-of-array irradiance below which an array is reported as underperforming.
   *
   * 200 W/m² is roughly full daylight but through significant cloud or haze.
   * Chosen as the point where OUTPUT is meaningfully below rating: below this,
   * an array's output says more about the weather than about the hardware, and
   * alarming on it would flag the whole fleet on a cloudy day. This is why solar
   * yield thresholds are expressed as a FRACTION OF RATED OUTPUT rather than an
   * absolute, and why irradiance alone is not an alarm.
   */
  solarLowIrradianceWm2: E("solarLowIrradianceWm2", {
    value: 200,
    unit: "KWP",
    source: "INFERRED",
    rationale:
      "Below this irradiance, array output reflects weather rather than array health, so it is context for a yield alert rather than an alert itself.",
    confirmWith:
      "The array's rated operating irradiance band and the site's typical seasonal cloud cover.",
  }),

  /**
   * Achieved daily yield as a percentage of the day's rated output, below which
   * an array is reported as underperforming.
   *
   * 50% is the commonly used "clipping, dirty glass or a failed string" signal.
   * It is deliberately LOW because it is only evaluated when irradiance has been
   * adequate — a yield collapse at 800 W/m² means hardware, whereas the same
   * collapse at 60 W/m² means weather.
   */
  solarMinExpectedYieldFactorPct: E("solarMinExpectedYieldFactorPct", {
    value: 50,
    unit: "PERCENT",
    source: "INFERRED",
    rationale:
      "Below this fraction of rated output, at adequate irradiance, suspect clipping, soiling or a failed string.",
    confirmWith:
      "The inverter's expected performance ratio for the installed array, and the site's historic yield baseline from the same period last year.",
  }),
});

/**
 * Deliberately the WRONG unit.
 *
 * `battEndOfLifeCycles` is a cycle COUNT and is declared with unit "HOURS" only
 * because `ThresholdUnit` has no cycle unit and widening that union would force
 * an audit of every interlock consumer. This alias exists so the mistake is
 * greppable rather than a comment somebody will eventually delete, and so a
 * future edit that adds "CYCLES" to ThresholdUnit has an obvious place to go.
 */
export const ENERGY_UNIT_DEFECTS: ReadonlyArray<{
  key: EnergyThresholdKey;
  declaredUnit: EnergyUnit;
  correctUnit: "CYCLES" | "PERCENT" | "MILLIVOLTS" | "W_PER_SQM";
  note: string;
}> = Object.freeze([
  {
    key: "battEndOfLifeCycles",
    declaredUnit: "HOURS",
    correctUnit: "CYCLES",
    note:
      "A cycle count is not hours. Declared 'HOURS' only because ThresholdUnit lacks a cycle unit; see module note.",
  },
  {
    key: "solarLowIrradianceWm2",
    declaredUnit: "KWP",
    correctUnit: "W_PER_SQM",
    note:
      "Irradiance is W/m2, not kWp. kWp is the array's rated CAPACITY, a different quantity entirely; declared 'KWP' only because ThresholdUnit lacks an irradiance unit.",
  },
]);

export type EnergyThresholdMap = Record<EnergyThresholdKey, EnergyThreshold>;

/** All energy thresholds keyed for lookup. */
export function energyThresholds(): EnergyThresholdMap {
  return DEFAULT_ENERGY_THRESHOLDS as unknown as EnergyThresholdMap;
}

/** One threshold by key, or undefined for an unknown key. */
export function energyThreshold(key: EnergyThresholdKey): EnergyThreshold | undefined {
  return DEFAULT_ENERGY_THRESHOLDS[key] as unknown as EnergyThreshold | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Battery protection state derived from live telemetry.
 *
 * CRITICAL dominates LOW, which dominates OK. Deliberately coarse: these three
 * states are what the UI and the alarm rules consume, and a five-state scale
 * would produce thresholds that fire and clear on noise.
 */
export type BatteryProtection = "OK" | "LOW" | "CRITICAL";

export interface BatteryProtectionInput {
  stateOfChargePct: number;
  temperatureC: number;
  /** Signed worst-cell delta from the bank mean, in millivolts. */
  cellBalanceMv?: number | null;
  cycleCount?: number | null;
}

export interface BatteryProtectionResult {
  protection: BatteryProtection;
  /** Every threshold this reading crossed, with the reason, for the operator UI. */
  reasons: Array<{ key: EnergyThresholdKey; message: string }>;
}

/**
 * Classify a battery bank.
 *
 * Every comparison is INCLUSIVE at the threshold (>= / <= / >= on absolute
 * value), so a reading exactly at the limit is treated as breaching. The
 * alternative — treating exactly-at-limit as healthy — makes the limit depend on
 * rounding in the reader, which is how "the reading was 39.9999" becomes an
 * off-by-one argument.
 *
 * A missing or non-finite reading NEVER raises an alarm. Absent telemetry is a
 * reporting gap, not a battery fault, and alarming on `undefined` would flood
 * the fleet the moment a Modbus poll failed.
 */
export function classifyBattery(
  input: BatteryProtectionInput,
  t: EnergyThresholdMap = DEFAULT_ENERGY_THRESHOLDS as unknown as EnergyThresholdMap,
): BatteryProtectionResult {
  const reasons: BatteryProtectionResult["reasons"] = [];

  const soc = input.stateOfChargePct;
  if (Number.isFinite(soc)) {
    if (soc <= t.battCriticalSocPct.value) {
      reasons.push({
        key: "battCriticalSocPct",
        message: `State of charge ${soc.toFixed(1)}% is at or below the critical limit of ${t.battCriticalSocPct.value}%`,
      });
    } else if (soc <= t.battLowSocPct.value) {
      reasons.push({
        key: "battLowSocPct",
        message: `State of charge ${soc.toFixed(1)}% is at or below the low limit of ${t.battLowSocPct.value}%`,
      });
    }
  }

  const temp = input.temperatureC;
  if (Number.isFinite(temp) && temp >= t.battHighTempC.value) {
    reasons.push({
      key: "battHighTempC",
      message: `Temperature ${temp.toFixed(1)}°C is at or above the elevated limit of ${t.battHighTempC.value}°C`,
    });
  }

  // Absolute value: the reader returns a SIGNED delta from the mean, so -80 mV
  // is exactly as much of a divergence as +80 mV. Comparing the raw value would
  // alarm on a rising cell and silently ignore a falling one.
  const bal = input.cellBalanceMv;
  if (bal !== null && bal !== undefined && Number.isFinite(bal)) {
    const mag = Math.abs(bal);
    if (mag >= t.battCellImbalanceMv.value) {
      reasons.push({
        key: "battCellImbalanceMv",
        message:
          `Cell imbalance ${bal.toFixed(0)} mV from the bank mean ` +
          `(|${mag.toFixed(0)}| mV) is at or above the limit of ${t.battCellImbalanceMv.value} mV`,
      });
    }
  }

  const cycles = input.cycleCount;
  if (cycles !== null && cycles !== undefined && Number.isFinite(cycles)) {
    if (cycles >= t.battEndOfLifeCycles.value) {
      reasons.push({
        key: "battEndOfLifeCycles",
        message: `${Math.round(cycles)} discharge cycles is at or above the design life of ${t.battEndOfLifeCycles.value}`,
      });
    }
  }

  const protection: BatteryProtection = reasons.some((r) => r.key === "battCriticalSocPct")
    ? "CRITICAL"
    : reasons.some((r) => r.key === "battLowSocPct")
      ? "LOW"
      : "OK";

  return { protection, reasons };
}

export interface SolarYieldInput {
  /** Today's energy delivered, in kWh. */
  dailyYieldKwh: number;
  /** The array's rated capacity, in kWp. */
  ratedKwp: number;
  /** Today's plane-of-array irradiance, W/m². */
  irradianceWm2?: number | null;
}

export interface SolarYieldResult {
  /** Delivered yield as a percent of rated capacity. Units are kWh vs kWp. */
  yieldFactorPct: number;
  /** True only when irradiance was adequate AND the yield was poor. */
  underperforming: boolean;
  reasons: Array<{ key: EnergyThresholdKey; message: string }>;
  /** Non-null when the input cannot be evaluated, e.g. ratedKwp <= 0. */
  indeterminate: string | null;
}

/**
 * Judge a solar array's yield.
 *
 * Yield is compared as a FRACTION and not as an absolute kWh, because a 10 kWp
 * array producing 20 kWh and a 500 kWp array producing 20 kWh are not the same
 * event — only the ratio is comparable across the fleet.
 *
 * The irradiance gate is the important part. A yield collapse at 800 W/m² is a
 * hardware fault; the same collapse at 60 W/m² is Tuesday. Reporting the second
 * as underperformance would flag an entire fleet on one cloudy day, so the
 * yield verdict is only issued when irradiance was adequate. A low-irradiance
 * day yields `underperforming: false` with the reason recorded as CONTEXT, not
 * as a fault.
 *
 * `indeterminate` is returned rather than a default verdict when ratedKwp is
 * missing or non-positive, because dividing by it would produce Infinity or NaN
 * and NaN compares false against every threshold — a failure that reads as
 * "healthy".
 */
export function judgeSolarYield(
  input: SolarYieldInput,
  t: EnergyThresholdMap = DEFAULT_ENERGY_THRESHOLDS as unknown as EnergyThresholdMap,
): SolarYieldResult {
  const reasons: SolarYieldResult["reasons"] = [];

  if (!Number.isFinite(input.ratedKwp) || input.ratedKwp <= 0) {
    return {
      yieldFactorPct: 0,
      underperforming: false,
      reasons,
      indeterminate:
        "ratedKwp must be a positive number to evaluate yield; without it every ratio is undefined and NaN would read as healthy",
    };
  }

  const yieldFactorPct = (input.dailyYieldKwh / input.ratedKwp) * 100;
  if (!Number.isFinite(yieldFactorPct)) {
    return {
      yieldFactorPct: 0,
      underperforming: false,
      reasons,
      indeterminate: `dailyYieldKwh=${input.dailyYieldKwh} produced a non-finite ratio`,
    };
  }

  const irr = input.irradianceWm2;
  const adequateIrradiance =
    irr === null || irr === undefined ? false : Number.isFinite(irr) && irr >= t.solarLowIrradianceWm2.value;

  if (!adequateIrradiance) {
    reasons.push({
      key: "solarLowIrradianceWm2",
      message:
        irr === null || irr === undefined
          ? `Irradiance is not reported, so a ${yieldFactorPct.toFixed(1)}% yield cannot be attributed to the array`
          : `Irradiance ${irr.toFixed(0)} W/m² is below ${t.solarLowIrradianceWm2.value} W/m², so a ` +
            `${yieldFactorPct.toFixed(1)}% yield reflects weather rather than array health`,
    });
    return { yieldFactorPct, underperforming: false, reasons, indeterminate: null };
  }

  if (yieldFactorPct <= t.solarMinExpectedYieldFactorPct.value) {
    reasons.push({
      key: "solarMinExpectedYieldFactorPct",
      message:
        `Yield ${yieldFactorPct.toFixed(1)}% of rated output is at or below the ` +
        `${t.solarMinExpectedYieldFactorPct.value}% limit at adequate irradiance — ` +
        `suspect clipping, soiling or a failed string`,
    });
    return { yieldFactorPct, underperforming: true, reasons, indeterminate: null };
  }

  return { yieldFactorPct, underperforming: false, reasons, indeterminate: null };
}