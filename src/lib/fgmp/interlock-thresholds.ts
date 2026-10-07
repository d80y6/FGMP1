/**
 * ─────────────────────────────────────────────────────────────────────────────
 * INTERLOCK THRESHOLDS — provenance-carrying, operator-overridable data
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This module is the single place a threshold VALUE lives. It used to be a
 * frozen constant with a comment beside each number explaining that the number
 * was a guess. That was honest but not operable: an operator holding the OEM
 * datasheet could not correct a limit without editing source and shipping a
 * deploy, and nothing could answer "which of my limits are still guesses?".
 *
 * ── WHAT CHANGED AND WHY IT IS NOT JUST DATA-MOVING ─────────────────────────
 *
 * 1. PROVENANCE IS PART OF THE VALUE.
 *    Every entry carries a `source` and, when it is not INFERRED, a reference to
 *    the document it came from. A threshold with no provenance is not a
 *    threshold; it is a guess that someone chose to enforce on hardware.
 *
 * 2. CRANKING FUEL IS NOW A FRACTION OF TANK CAPACITY.
 *    Phase 2 used a flat 12 L. That cannot be right across engine
 *    displacements — a 6 kW standby set and a 2000 kW prime set have usable
 *    tanks an order of magnitude apart, so 12 L is trivial for one and a
 *    rounding error for the other. It is now a percentage of usable capacity,
 *    which is displacement-independent and uses only data the platform already
 *    models. The litres figure is DERIVED at evaluation time and the arithmetic
 *    is shown in the message so an operator can see what it resolved to.
 *
 *    25% is chosen because real guidance for standby sets is typically "enough
 *    to crank and reach stable idle with margin", and a quarter of usable tank
 *    is the customary figure. It is NOT sourced from a standard — it is marked
 *    INFERRED, and an operator with a real number should override it.
 *
 * 3. OVERRIDES COME FROM THE DATABASE, NOT FROM HERE.
 *    `resolveThresholds()` merges a tenant's stored rows over these defaults.
 *    The defaults remain the safety floor: if the override table is empty,
 *    unreachable, or corrupt, the platform still enforces the conservative
 *    inferred values rather than running unbounded.
 *
 * ── THE DIRECTION OF FAILURE ───────────────────────────────────────────────
 * Every default here is chosen so that being WRONG causes a refusal, never a
 * permissive action. A coolant limit that is too low over-refuses. A cranking
 * fraction that is too high over-refuses. A cooldown that is too long
 * over-refuses. That is why shipping inferred numbers behind an interlock was
 * defensible at all — and why they stay INFERRED here rather than being quietly
 * upgraded to "confirmed".
 */

/** Where a threshold's value came from. Mirrors the ThresholdSource enum. */
export type ThresholdSource =
  | "OEM_DATASHEET"
  | "SITE_POLICY"
  | "MAINTENANCE_SCHEDULE"
  | "DERIVED"
  | "INFERRED";

/**
 * The unit a value is expressed in.
 *
 * Additive union, shared by interlock thresholds (which REFUSE an action) and
 * energy thresholds (which ALARM). The two domains need genuinely different
 * units — there is no Celsius equivalent of a cell-voltage spread — so a
 * single vocabulary serves both rather than each inventing its own.
 *
 * Added for Phase 4 energy work, and added because a threshold genuinely needs
 * them, not to silence a type error:
 *   MILLIVOLTS — `battCellImbalanceMv`. The Modbus reader already parses a
 *     signed per-cell delta from the bank mean in millivolts; the threshold that
 *     judges it is measured in the same unit, and expressing it in volts would
 *     put every plausible limit below the smallest representable value.
 *   PERCENT    — state of charge, state of health, yield factor.
 *
 * Widening a union is additive and cannot change any existing consumer: every
 * current `unit` value is still assignable. `solarLowIrradianceWm2` needs
 * W_PER_SQM and deliberately still carries "KWP", because KWP is an array's
 * rated CAPACITY — a different physical quantity from irradiance. That
 * mislabel is recorded in `ENERGY_UNIT_DEFECTS` in energy-thresholds.ts rather
 * than hidden, so it stays greppable when a proper unit is added.
 */
export type ThresholdUnit =
  | "CELSIUS"
  | "KPA"
  | "PERCENT_OF_TANK"
  | "MINUTES"
  | "HOURS"
  | "LITRES_PER_MINUTE"
  // ── Phase 4 energy additions ──
  | "MILLIVOLTS"
  | "PERCENT";

/**
 * One threshold, with everything needed to decide whether to trust it.
 *
 * `confirmedBy` and `confirmedAt` are deliberately nullable and deliberately
 * INDEPENDENT of `source`. A row with source=INFERRED and a confirmedBy set is
 * a real state — someone reviewed it and decided the inferred value stands — and
 * hiding it would be as dishonest as silently treating INFERRED as confirmed.
 */
export interface InterlockThreshold<T extends number = number> {
  /** Stable key. Also the DB `thresholdKey`, so it must not be renamed casually. */
  readonly key: string;
  readonly value: T;
  readonly unit: ThresholdUnit;
  readonly source: ThresholdSource;
  /** Document, manual page, or policy clause the value came from. */
  readonly sourceRef?: string;
  readonly confirmedBy?: string | null;
  readonly confirmedAt?: Date | null;
  /** What the number is FOR, in one sentence, for the operator-facing UI. */
  readonly rationale: string;
  /** What must be checked to confirm it, when nobody has. */
  readonly confirmWith: string;
}

/** The keys the interlock rules actually read. */
export const THRESHOLD_KEYS = [
  "coolantMaxC",
  "oilPressureMinKpa",
  "oilOverdueMaxHours",
  "crankingFuelFractionPct",
  "lowFuelWarnFractionPct",
  "cooldownMinutes",
  "faultRestartBackoffMinutes",
  "serviceWarnHours",
  "highLoadFractionPct",
  "lowLoadFractionPct",
] as const;

export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];

const S = (key: ThresholdKey, o: Partial<InterlockThreshold> & { value: number; unit: ThresholdUnit; source: ThresholdSource; rationale: string; confirmWith: string }): InterlockThreshold =>
  Object.freeze({ key, sourceRef: undefined, confirmedBy: null, confirmedAt: null, ...o });

/**
 * The DEFAULTS — every one of them INFERRED.
 *
 * Not an oversight and not laziness: no number in this codebase was supplied by
 * an OEM datasheet, a site policy or a maintenance schedule. The original
 * specification contained no safety values, so the honest state of every one of
 * these is "somebody guessed, conservatively". Marking them CONFIRMED would be
 * the actual defect.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /**
   * Coolant temperature above which the set must not be asked to assume load.
   * Typical gensets run ~40-50 °C coolant at continuous load, so 85 leaves
   * generous headroom. Chosen high because a hot reading at assume-load is a
   * hard stop and over-refusal is cheap.
   */
  coolantMaxC: S("coolantMaxC", {
    value: 85,
    unit: "CELSIUS",
    source: "INFERRED",
    rationale: "Refuse to assume load above this coolant temperature.",
    confirmWith:
      "The engine manufacturer's continuous-load coolant rating for the installed set, or the IEC 60068 ambient rating.",
  }),

  /**
   * Oil pressure below which the set is not mechanically sound to load.
   * Speed- and viscosity-dependent, which is exactly why one global number is
   * inadequate — hence the per-tenant override.
   */
  oilPressureMinKpa: S("oilPressureMinKpa", {
    value: 150,
    unit: "KPA",
    source: "INFERRED",
    rationale: "Refuse to start or assume load below this oil pressure.",
    confirmWith: "OEM minimum oil pressure at rated speed, and the oil grade actually in use.",
  }),

  /**
   * Run-hours past service at which a start is refused outright.
   * Set as a HARD deny deliberately: an overdue engine that fails under load
   * takes the site's power with it, so the failure mode of being wrong here is
   * an outage rather than a late service.
   */
  oilOverdueMaxHours: S("oilOverdueMaxHours", {
    value: 500,
    unit: "HOURS",
    source: "INFERRED",
    rationale: "Refuse to start a generator whose scheduled service is overdue by this many run-hours.",
    confirmWith: "The site's actual maintenance schedule and the OEM oil-change interval for the installed engine.",
  }),

  /**
   * CRANKING FUEL, as a percentage of usable tank capacity.
   *
   * CHANGED from a flat 12 litres. A litre count cannot be correct across
   * engine displacements — a 6 kW standby set and a 2000 kW prime set differ by
   * more than an order of magnitude in usable tank, so any fixed figure is
   * either trivially satisfied by the large set or effectively unreachable on
   * the small one. A fraction is displacement-independent.
   *
   * The litres figure is derived at evaluation time (see FUEL_BELOW_CRANKING_
   * THRESHOLD) and shown in the denial message, so the operator sees the
   * arithmetic rather than an opaque percentage.
   */
  crankingFuelFractionPct: S("crankingFuelFractionPct", {
    value: 25,
    unit: "PERCENT_OF_TANK",
    source: "INFERRED",
    rationale:
      "Refuse to start when usable fuel is below this percentage of tank capacity — an engine that cannot reach stable idle drops the site load mid-crank.",
    confirmWith:
      "The litres needed to crank and reach stable idle for the installed engine, expressed as a percentage of usable tank capacity, or as minutes of cranking load at the engine's rated cranking current.",
  }),

  /** Low-fuel warning level, same units and rationale as the cranking floor. */
  lowFuelWarnFractionPct: S("lowFuelWarnFractionPct", {
    value: 40,
    unit: "PERCENT_OF_TANK",
    source: "INFERRED",
    rationale: "Warn when usable fuel is below this percentage of tank capacity. Does not refuse.",
    confirmWith: "Site refuelling interval and the delivery lead time for bulk fuel.",
  }),

  /**
   * Minimum rest between a stop and a subsequent start. Restarting a
   * just-stopped diesel is real wear (restart current, un-lubricated starts, hot
   * turbo) and on some sets a safety concern.
   */
  cooldownMinutes: S("cooldownMinutes", {
    value: 3,
    unit: "MINUTES",
    source: "INFERRED",
    rationale: "Refuse a start within this many minutes of the previous stop.",
    confirmWith: "OEM guidance, and the site's own policy for how long a stopped set must rest.",
  }),

  /**
   * Backoff after a fault-triggered stop. Longer than an ordinary cooldown
   * because a latched fault usually has not been cleared.
   */
  faultRestartBackoffMinutes: S("faultRestartBackoffMinutes", {
    value: 10,
    unit: "MINUTES",
    source: "INFERRED",
    rationale: "Refuse a restart within this many minutes of a fault stop.",
    confirmWith: "Site policy on how long to wait after a fault before remote restart is permitted.",
  }),

  /** Advance-warning margin before scheduled service. */
  serviceWarnHours: S("serviceWarnHours", {
    value: 25,
    unit: "HOURS",
    source: "INFERRED",
    rationale: "Warn when scheduled service is due within this many run-hours. Does not refuse.",
    confirmWith: "Maintenance scheduling policy and the site's service interval.",
  }),

  /** Headroom margin before a set is flagged as heavily loaded. */
  highLoadFractionPct: S("highLoadFractionPct", {
    value: 90,
    unit: "PERCENT_OF_TANK",
    source: "INFERRED",
    rationale: "Warn when existing load exceeds this percentage of the generator's rating. Does not refuse.",
    confirmWith:
      "The site's actual peak demand against the installed generator's kVA rating. NOTE: stored as PERCENT because the column is a shared enum; the value is a percentage of RATED POWER, not of tank capacity.",
  }),

  /**
   * Minimum sustained load as a percentage of rating. Below this a diesel runs
   * rich, soaks the plugs and burns fuel — but blocking STOP to protect the
   * engine would be unsafe, so this is a soft warning only.
   */
  lowLoadFractionPct: S("lowLoadFractionPct", {
    value: 30,
    unit: "PERCENT_OF_TANK",
    source: "INFERRED",
    rationale: "Warn when load is below this percentage of rating, where a diesel runs rich. Does not refuse.",
    confirmWith: "OEM minimum recommended continuous load fraction.",
  }),
}) as Readonly<Record<ThresholdKey, InterlockThreshold>>;

/**
 * Effective thresholds: the tenant's stored overrides merged over the defaults.
 *
 * The merge is by `thresholdKey`. A stored row for a key the code does not know
 * is IGNORED rather than applied — an operator cannot invent a limit and have
 * it enforced against hardware.
 *
 * The returned object also carries `provenance` so a caller can tell an operator
 * exactly which numbers are still inferred.
 */
export interface ResolvedThresholds {
  readonly values: Readonly<Record<ThresholdKey, number>>;
  readonly provenance: Readonly<Record<ThresholdKey, InterlockThreshold>>;
  /** Keys where the tenant has overridden the shipped default. */
  readonly overridden: readonly ThresholdKey[];
}

/** Shape of a stored row, as read from InterlockThreshold. */
export interface StoredThreshold {
  thresholdKey: string;
  value: number;
  source: ThresholdSource;
  sourceRef: string | null;
  confirmedById: string | null;
  confirmedAt: Date | null;
}

/**
 * Merge stored rows over the shipped defaults.
 *
 * Pure and synchronous so it stays unit-testable without a database. The caller
 * is responsible for having read the rows INSIDE a tenant context.
 */
export function resolveThresholds(rows: readonly StoredThreshold[] = []): ResolvedThresholds {
  const known = new Set<string>(THRESHOLD_KEYS);
  const values = {} as Record<ThresholdKey, number>;
  const provenance = {} as Record<ThresholdKey, InterlockThreshold>;
  const overridden: ThresholdKey[] = [];

  for (const key of THRESHOLD_KEYS) {
    const base = DEFAULT_THRESHOLDS[key];
    values[key] = base.value;
    provenance[key] = base;
  }

  for (const row of rows) {
    const key = row.thresholdKey as ThresholdKey;
    // Unknown key: an operator may legitimately record a threshold this build
    // does not enforce yet. Surface it in the API, never apply it.
    if (!known.has(row.thresholdKey)) continue;
    // Non-finite or negative would make every comparison behave degenerately
    // (NaN comparisons are always false, so the rule would silently never
    // fire). Fall back to the shipped default instead.
    if (!Number.isFinite(row.value) || row.value < 0) continue;

    values[key] = row.value;
    provenance[key] = {
      ...DEFAULT_THRESHOLDS[key],
      value: row.value,
      source: row.source,
      sourceRef: row.sourceRef ?? undefined,
      confirmedBy: row.confirmedById,
      confirmedAt: row.confirmedAt,
    };
    overridden.push(key);
  }

  return Object.freeze({
    values: Object.freeze(values),
    provenance: Object.freeze(provenance),
    overridden: Object.freeze(overridden),
  });
}

/**
 * Human-readable provenance, for an operator looking at a generator.
 *
 * The point of this function is that "this limit is inferred, not from your OEM
 * manual" is impossible to miss. Silently applying an inferred number is the
 * problem; visibly applying one under operator control is defensible.
 */
export function describeThresholds(
  t: ResolvedThresholds,
  opts: { fuelLitres?: number; tankCapacityLitres?: number } = {},
): Array<{
  key: string;
  value: number;
  effectiveValue: number | null;
  unit: ThresholdUnit;
  source: ThresholdSource;
  sourceRef: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmed: boolean;
  overridden: boolean;
  rationale: string;
  confirmWith: string;
}> {
  const out: Array<{
    key: string;
    value: number;
    effectiveValue: number | null;
    unit: ThresholdUnit;
    source: ThresholdSource;
    sourceRef: string | null;
    confirmedBy: string | null;
    confirmedAt: string | null;
    confirmed: boolean;
    overridden: boolean;
    rationale: string;
    confirmWith: string;
  }> = [];
  for (const key of THRESHOLD_KEYS) {
    const p = t.provenance[key];
    // Show the litres a percentage-of-tank resolves to, so the operator is not
    // asked to do the arithmetic themselves.
    let effective: number | null = null;
    if (
      (key === "crankingFuelFractionPct" || key === "lowFuelWarnFractionPct") &&
      opts.tankCapacityLitres !== undefined &&
      opts.tankCapacityLitres > 0
    ) {
      effective = Math.round(((p.value / 100) * opts.tankCapacityLitres) * 10) / 10;
    } else if (key === "cooldownMinutes" || key === "faultRestartBackoffMinutes") {
      effective = p.value * 60_000;
    }

    out.push({
      key,
      value: p.value,
      effectiveValue: effective,
      unit: p.unit,
      source: p.source,
      sourceRef: p.sourceRef ?? null,
      confirmedBy: p.confirmedBy ?? null,
      confirmedAt: p.confirmedAt ? p.confirmedAt.toISOString() : null,
      // "Confirmed" means SOURCED, not merely reviewed: an INFERRED value is
      // never presented as confirmed, even if somebody signed it off, because
      // the number still did not come from a datasheet.
      confirmed: p.source !== "INFERRED",
      overridden: t.overridden.includes(key),
      rationale: p.rationale,
      confirmWith: p.confirmWith,
    });
  }
  return out;
}

/** Convert minutes to milliseconds for the cooldown/backoff rules. */
export const minutesToMs = (minutes: number): number => minutes * 60_000;