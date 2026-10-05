/**
 * Simulation boundary (Phase 2 — remove simulated telemetry).
 *
 * There is exactly one place that answers "may fabricated data be produced in
 * this process?", and it answers from two independent conditions. Both must
 * hold. Either one alone is insufficient:
 *
 *   1. NODE_ENV must not be production. A production process must never
 *      fabricate telemetry, whatever the operator intended.
 *   2. FGMP_SIMULATION must be explicitly enabled. Without it, simulation is
 *      OFF even in development — so a developer's normal `bun run dev` shows
 *      real ingested data and a genuine empty state rather than a convincing
 *      lie. Opt-in means "the data you see is real" is the default.
 *
 * This is deliberately not just an environment flag checked at the route. The
 * engine consults it too (defence in depth): a route guard protects the HTTP
 * surface, and the engine guard protects every caller, including future ones
 * and the ones that are not HTTP at all.
 *
 * ## What this does NOT do
 *
 * RLS remains the isolation boundary; this is not a substitute for it. And
 * enabling simulation does not weaken RLS — the simulation writes through the
 * same tenant-scoped path as everything else.
 */

export type SimulationDecision =
  | { allowed: true; seed: number; reason: string }
  | { allowed: false; code: SimulationBlockCode; reason: string };

export type SimulationBlockCode =
  | "PRODUCTION_ENV"
  | "NOT_ENABLED"
  | "INVALID_SEED";

/** Default seed, shared with prng.ts so both agree on "the" default. */
const DEFAULT_SEED = 20240617;

/**
 * Read the environment without caching.
 *
 * Deliberately NOT memoised at module load. `next build` imports every route
 * module with NODE_ENV=production but no runtime secrets, so a value captured
 * at import time would be permanently wrong for the real process. Reading it
 * per call costs nothing and cannot be stale.
 */
function env(): { nodeEnv: string; simFlag: string | undefined; seed: string | undefined } {
  return {
    nodeEnv: process.env.NODE_ENV ?? "",
    simFlag: process.env.FGMP_SIMULATION,
    seed: process.env.FGMP_SIM_SEED,
  };
}

/**
 * Parse the opt-in flag.
 *
 * Only "1" and "true" enable it. An absent, empty, or unrecognised value is
 * disabled. Anything else would mean a typo silently enabled fabrication in a
 * process that believed it was off.
 */
function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * May this process fabricate telemetry?
 *
 * @param override force the decision — used by tests to exercise both states
 *                without mutating global process.env.
 */
export function simulationDecision(override?: {
  nodeEnv?: string;
  flag?: string | undefined;
  seed?: string | undefined;
}): SimulationDecision {
  const e = env();
  const nodeEnv = override?.nodeEnv ?? e.nodeEnv;
  const flag = override?.flag !== undefined ? override.flag : e.simFlag;
  const seedRaw = override?.seed !== undefined ? override.seed : e.seed;

  // Condition 1 — production is never allowed, regardless of the flag.
  if (nodeEnv === "production") {
    return {
      allowed: false,
      code: "PRODUCTION_ENV",
      reason:
        "Simulated telemetry is disabled in production (NODE_ENV=production). " +
        "Fabricated tank levels, generator temperatures and fuel transactions are " +
        "indistinguishable from measured ones once written, so a production " +
        "process that fabricated them would be reporting fiction as fact. " +
        "Telemetry must arrive through POST /api/fgmp/iot/ingest instead.",
    };
  }

  // Condition 2 — opt-in, so the default dev experience shows real data.
  if (!flagEnabled(flag)) {
    return {
      allowed: false,
      code: "NOT_ENABLED",
      reason:
        "Simulation is not enabled. Set FGMP_SIMULATION=1 to fabricate demo " +
        "telemetry in a development process. It is off by default so that a " +
        "developer sees real ingested data — and a genuine empty state when " +
        "there is none — instead of generated numbers that look like readings.",
    };
  }

  const seed = seedRaw === undefined || seedRaw.trim() === "" ? DEFAULT_SEED : Number(seedRaw);
  if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
    return {
      allowed: false,
      code: "INVALID_SEED",
      reason:
        `FGMP_SIM_SEED must be an integer (got ${JSON.stringify(seedRaw)}). ` +
        "An unparseable seed would silently fall back to a different run than the " +
        "operator asked for, which is worse than refusing.",
    };
  }

  return {
    allowed: true,
    seed,
    reason:
      `Simulation enabled for development (FGMP_SIMULATION=1, seed ${seed}). ` +
      "Output is reproducible: the same seed produces the same run.",
  };
}

/** Convenience predicate. Use `simulationDecision()` when you need the reason. */
export function simulationAllowed(override?: Parameters<typeof simulationDecision>[0]): boolean {
  return simulationDecision(override).allowed;
}

/**
 * Throw if simulation is not permitted.
 *
 * Called at the top of every simulation entry point. Throwing rather than
 * returning a sentinel means a caller cannot accidentally proceed with a
 * partial or empty result and present it as a successful tick.
 */
export function assertSimulationAllowed(
  what: string,
  override?: Parameters<typeof simulationDecision>[0],
): { seed: number } {
  const d = simulationDecision(override);
  if (!d.allowed) {
    const err = new Error(`${what} refused: ${d.reason}`);
    err.name = "SimulationDisabledError";
    throw err;
  }
  return { seed: d.seed };
}

export { DEFAULT_SEED as DEFAULT_SIMULATION_SEED };