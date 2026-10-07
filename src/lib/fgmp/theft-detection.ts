/**
 * Fuel theft DETECTION — measurement-derived, not event-injected.
 *
 * ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
 * The engine used to *cause* theft and then report it:
 *
 *     if (rng.float() < 0.0012 && tk.current > tk.critical * 1.5) {
 *       const stolen = Math.min(tk.current * (0.1 + rng.float() * 0.25), 400);
 *       tk.current -= stolen;
 *       pushEvent(..., `Fuel theft detected: -${stolen}L ...`);
 *       raiseAlarm({ type: "FUEL_THEFT", ... });
 *     }
 *
 * That is not detection. It subtracts a random volume and then labels the
 * subtraction, so the alarm is a restatement of the generator's own dice roll.
 * The number in the alarm is the number that was taken, which means the
 * "detection" could not possibly disagree with its own input — and, worse, an
 * operator paging on it would be paging on a fabricated event.
 *
 * ── WHAT REAL DETECTION REQUIRES ─────────────────────────────────────────────
 * A measured level change has to be compared against a PREDICTED change derived
 * from independent evidence. If they disagree beyond the error of both, fuel
 * left the tank without being burned.
 *
 * The prediction uses engine runtime as the independent signal: a generator
 * running at a known rate burns a known rate. That is genuinely independent of
 * the tank level — it comes from the generator controller, not the level
 * sensor — which is what makes the comparison meaningful rather than circular.
 *
 * ── WHY THE TOLERANCE IS NOT A CONSTANT GUESS ────────────────────────────────
 * `toleranceFor()` composes the error budget from the actual quantities:
 *   - tank volume resolution (a float litres figure is not ±0 by definition)
 *   - sensor accuracy as a fraction of capacity (configurable, INFERRED)
 *   - runtime resolution, converted to litres via the burn rate
 *
 * A threshold that does not widen with tank size is wrong in both directions: a
 * 2000 L tank's sensor noise is not the same absolute error as a 500 L tank's.
 *
 * ── WHAT THIS DELIBERATELY REFUSES TO DO ─────────────────────────────────────
 * It does not accuse. A detection returns a CONFIDENCE and the evidence that
 * produced it, and the CALLER decides the severity. Separating "the numbers
 * disagree" from "someone stole fuel" is deliberate: the first is a measurement
 * claim this module can support, the second is an accusation that needs a human
 * and, in most jurisdictions, corroboration.
 */

export interface TheftEvidence {
  tankId: string;
  siteId: string;
  /** Measured level at the start of the window, litres. */
  levelStartLitres: number;
  /** Measured level now, litres. */
  levelEndLitres: number;
  /** Litres the engine burned during the window, from runtime × burn rate. */
  expectedConsumptionLitres: number;
  /** Hours the window spans. */
  windowHours: number;
  /** Tank capacity, for scaling the tolerance. */
  capacityLitres: number;
  /** Declared tank-level sensor accuracy as a fraction of capacity. */
  sensorAccuracyFraction: number;
}

export interface TheftCandidate {
  tankId: string;
  siteId: string;
  /** Litres that disappeared without being accounted for. Never negative. */
  unexplainedLitres: number;
  /**
   * How far the discrepancy exceeds the combined error budget.
   *
   * 1.0 means exactly at the edge. Below 1.0 the gap is explainable by
   * measurement error and this is NOT a detection.
   */
  significance: number;
  /** The error budget that `unexplainedLitres` had to beat, litres. */
  toleranceLitres: number;
  /** Expected vs measured, for the audit record. */
  expectedLitres: number;
  measuredLitres: number;
}

/** Default sensor accuracy. INFERRED — no datasheet was supplied. */
export const DEFAULT_SENSOR_ACCURACY = 0.02; // ±2% of capacity

/**
 * Combined error budget for one window, in litres.
 *
 * Three independent contributions, added in quadrature rather than summed
 * linearly. Summing is the conservative choice but overstates the budget badly
 * once any one term grows, and a tolerance that is too wide is a detector that
 * never fires — which is worse than useless, because it looks calibrated.
 */
export function toleranceFor(e: TheftEvidence): number {
  const runtimeErrorLitres = Math.max(0, e.expectedConsumptionLitres) * 0.05; // runtime ±5%
  const resolutionLitres = 1; // level is reported to the litre

  const sensorError = e.capacityLitres * e.sensorAccuracyFraction;
  const variance =
    sensorError ** 2 + runtimeErrorLitres ** 2 + resolutionLitres ** 2;
  return Math.sqrt(variance);
}

/**
 * Compare measured depletion against expected consumption.
 *
 * Returns null when the window is too short to say anything, or when the
 * discrepancy is inside the error budget. A null is the common case and it is
 * NOT a failure — a detector that fires constantly trains its reader to ignore
 * it.
 */
export function detectUnexplainedLoss(e: TheftEvidence): TheftCandidate | null {
  // Below an hour the runtime-derived expectation is itself too noisy to compare
  // against. A "detection" from a 30-second window is arithmetic, not evidence.
  if (e.windowHours < 1) return null;

  const measuredDepletion = e.levelStartLitres - e.levelEndLitres;
  // Fuel went UP. That is a delivery, a temperature correction, or a bad sensor
  // — none of which is theft, and reporting it as such would be the fastest way
  // to make an operator ignore the detector.
  if (measuredDepletion < 0) return null;

  const unexplained = measuredDepletion - e.expectedConsumptionLitres;
  const tolerance = toleranceFor(e);

  // Inside the error budget: the gap is measurement noise, not fuel theft.
  if (unexplained <= tolerance) return null;

  return {
    tankId: e.tankId,
    siteId: e.siteId,
    unexplainedLitres: Math.round(unexplained * 100) / 100,
    significance: Math.round((unexplained / tolerance) * 100) / 100,
    toleranceLitres: Math.round(tolerance * 100) / 100,
    expectedLitres: Math.round(e.expectedConsumptionLitres * 100) / 100,
    measuredLitres: Math.round(measuredDepletion * 100) / 100,
  };
}

/**
 * Litres per hour a generator burns.
 *
 * Rated power / thermal efficiency gives the fuel ENERGY the engine must
 * release per hour, in kWh. At 3.6 MJ/kWh that is MJ/h, and dividing by
 * diesel's LHV (~35.8 MJ/kg) and density (~0.84 kg/L) gives L/h.
 *
 * A 100 kW set at 35% works out to ~34 L/h, which is correct and worth stating
 * because it looks alarming: it is roughly 800 L/day. Any figure an order of
 * magnitude away from that means the constants are wrong, and every derived
 * detection inherits the error.
 *
 * The efficiency figure is INFERRED — a real deployment reads it from the OEM
 * datasheet per engine model, and a fleet of mixed models will not share one
 * number. It is stated here as a default precisely so it is visible.
 */
export function burnRateLitresPerHour(
  ratedPowerKw: number,
  thermalEfficiency = 0.35,
): number {
  // A generator cannot produce negative power. Clamping here rather than
  // letting the caller sort it out means a bad nameplate reading yields "no
  // consumption" rather than a negative expected figure, which would make the
  // detector report EVERY subsequent reading as unexplained fuel.
  if (!Number.isFinite(ratedPowerKw) || ratedPowerKw <= 0) return 0;
  if (!Number.isFinite(thermalEfficiency) || thermalEfficiency <= 0 || thermalEfficiency > 1) {
    return 0;
  }

  const MJ_PER_KWH = 3.6;
  const dieselLhvMjPerKg = 35.8;
  const densityKgPerLitre = 0.84;
  const energyKwh = ratedPowerKw / thermalEfficiency;
  const mj = energyKwh * MJ_PER_KWH;
  return mj / dieselLhvMjPerKg / densityKgPerLitre;
}

/**
 * Expected consumption for a window, from runtime hours actually accumulated.
 *
 * Uses the DELTA in runtime, not the absolute value. Absolute runtime hours
 * since installation would imply the tank should have been empty weeks ago.
 */
export function expectedConsumption(
  ratedPowerKw: number,
  runtimeDeltaHours: number,
  thermalEfficiency = 0.35,
): number {
  return burnRateLitresPerHour(ratedPowerKw, thermalEfficiency) * Math.max(0, runtimeDeltaHours);
}

/**
 * Turn a candidate into an alarm severity.
 *
 * Severity scales with how much fuel vanished and how far outside the error
 * budget it sits. Deliberately NOT binary: a 2× over-budget loss and a 40×
 * over-budget loss are not the same operational event, and collapsing them to
 * L3/L3 makes the alert unrankable.
 *
 * Returns null below a hard floor, so ordinary meter noise never reaches an
 * operator's phone at 3am.
 */
export function severityFor(
  candidate: TheftCandidate,
  thresholds = { warnSignificance: 2, criticalSignificance: 6, criticalLitres: 50 },
): "WARNING" | "CRITICAL" | null {
  if (candidate.significance < thresholds.warnSignificance) return null;
  const severe =
    candidate.significance >= thresholds.criticalSignificance &&
    candidate.unexplainedLitres >= thresholds.criticalLitres;
  return severe ? "CRITICAL" : "WARNING";
}
