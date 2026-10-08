/**
 * SIMULATED GENERATOR DISPATCH — opt-in, default OFF.
 *
 * ── WHY DEFAULT OFF ─────────────────────────────────────────────────────────
 * A control surface that fabricates an outcome unless you remember to turn it
 * off is the exact defect this project has spent two phases removing. Today's
 * engine mutates memory and reports success with no device involved; that
 * behaviour must never be the default, because it is indistinguishable from a
 * working installation until the moment it matters.
 *
 * So: no transport, no EXECUTED. Without FGMP_ENABLE_SIMULATED_CONTROL=1 this
 * returns NO_TRANSPORT and says why.
 *
 * ── WHAT "SIMULATED" RETURNS WHEN ENABLED ───────────────────────────────────
 * It still does NOT return EXECUTED. It applies the in-memory mutation the engine
 * has always applied, and reports NO_TRANSPORT — because NO_TRANSPORT is the
 * truth: nothing was wired.
 *
 * This is the part that matters and it is slightly counter-intuitive. An
 * operator who enables simulation wants the engine to behave as before, and
 * they get exactly that. What they must never get is a row saying EXECUTED,
 * because there is no acknowledgement behind it and the whole point of this
 * boundary is that EXECUTED means a device answered.
 *
 * `result` is carried on the outcome for display, but `kind` stays NO_TRANSPORT.
 */

import {
  noTransport,
  type DispatchRequest,
  type DispatchOutcome,
  type GeneratorDispatch,
} from "./types";

export const SIMULATED_FLAG = "FGMP_ENABLE_SIMULATED_CONTROL";

export function simulatedControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Strictly "1". Anything else — "true", "yes", "" — stays OFF. A control
  // surface should not be enabled by a typo.
  return env[SIMULATED_FLAG] === "1";
}

export interface SimulatedDispatchOptions {
  /**
   * Applies the in-memory mutation the engine has always applied.
   * Injected so this module owns no engine state and stays testable.
   */
  applyInMemory?: (req: DispatchRequest) => void;
  env?: NodeJS.ProcessEnv;
}

export class SimulatedGeneratorDispatch implements GeneratorDispatch {
  readonly name = "simulated";

  private readonly applyInMemory?: (req: DispatchRequest) => void;
  private readonly enabled: boolean;

  constructor(opts: SimulatedDispatchOptions = {}) {
    this.applyInMemory = opts.applyInMemory;
    this.enabled = simulatedControlEnabled(opts.env ?? process.env);
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    if (!this.enabled) {
      // The default. Nothing attempted, nothing claimed.
      return noTransport(
        this.name,
        `No generator transport is configured, and simulated control is off. ` +
          `Set ${SIMULATED_FLAG}=1 only in a demo environment — it does not ` +
          `start a real engine.`,
      );
    }

    // Enabled: behave as the engine always has, but report the TRUTH. The
    // in-memory mutation happens so existing dashboards and tests keep working;
    // the outcome deliberately does not claim EXECUTED.
    this.applyInMemory?.(req);

    return {
      kind: "NO_TRANSPORT",
      reason:
        `${this.name}: ${SIMULATED_FLAG}=1 — the in-memory engine state was ` +
        `updated, but no generator was contacted. No acknowledgement exists.`,
      retrySafe: true,
    };
  }
}