/**
 * ─────────────────────────────────────────────────────────────────────────────
 INTERLOCK STATE ADAPTER — the narrow seam onto generator runtime state
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS FILE EXISTS
 * The safety interlocks need current generator state — status, coolant
 * temperature, oil pressure, load, run-hours, last stop time. That state lives
 * in the in-memory engine (`GenState` in src/lib/fgmp/types.ts, owned by the
 * engine).
 *
 * This adapter deliberately does NOT edit engine.ts. The engine is being
 * rewritten for simulation work, and a safety module reaching into
 * `engine.generators` directly would couple the interlock boundary to a field
 * that is expected to move.
 *
 * LEADERSHIP NOTE: the accessor used by the interlock boundary is
 * `readGeneratorForInterlock()`, below. It takes a snapshot of the narrow
 * `InterlockGeneratorState` shape the rules need and nothing else, so if the
 * engine's internal representation changes, only this adapter has to follow.
 * Reconcile by replacing this function's body with whatever narrow reader the
 * engine ends up exposing — the call sites and the rules do not change.
 *
 * The engine's `applyCommand` remains the only path that mutates state. This
 * module reads.
 */

import { engine } from "./engine";
import type {
  InterlockContext,
  InterlockGeneratorState,
  InterlockSiteState,
} from "./interlock-rules";

/**
 * Snapshot one generator's state in the shape the interlock rules consume.
 *
 * Returns null when the engine has not loaded that generator. Callers MUST
 * treat null as "state unknown" and refuse the command rather than assume the
 * preconditions are satisfied — an interlock that passes because it could not
 * read the state is not an interlock.
 */
export function readGeneratorForInterlock(generatorId: string): InterlockGeneratorState | null {
  const g = engine.generators.find((x) => x.id === generatorId);
  if (!g) return null;
  return {
    id: g.id,
    siteId: g.siteId,
    status: g.status,
    mode: g.mode,
    runtimeHours: g.runtimeHours,
    temperatureC: g.temperatureC,
    oilPressureKpa: g.oilPressureKpa,
    loadKw: g.loadKw,
    ratedPowerKw: g.ratedPowerKw,
    oilChangeIntervalHrs: g.oilChangeIntervalHrs,
    nextMaintenanceHrs: g.nextMaintenanceHrs,
    lastStartedAt: g.lastStartedAt,
    lastStoppedAt: g.lastStoppedAt,
    faultUntil: g.faultUntil,
  };
}

/** Snapshot the site that owns a generator. */
export function readSiteForInterlock(siteId: string): InterlockSiteState | null {
  const s = engine.sites.find((x) => x.id === siteId);
  if (!s) return null;
  return {
    id: s.id,
    criticality: s.criticality,
    loadKw: s.loadKw,
    gridAvailable: s.gridAvailable,
  };
}

/**
 * Litres remaining in the tank feeding a generator's site.
 *
 * Returns undefined when the site has no bound tank. That is deliberately
 * distinct from zero: the fuel interlock treats "no tank data" as "cannot
 * assess" rather than "no fuel", so a site without telemetry is not denied
 * every start.
 */
export function readFuelLitresForInterlock(siteId: string): number | undefined {
  const tank = engine.tanks.find((t) => t.siteId === siteId);
  if (!tank) return undefined;
  return tank.current;
}

/**
 * Build the full context for one generator + command, or null if the engine
 * cannot describe the asset.
 *
 * `now` is injected so the caller controls the clock — cooldown and backoff
 * arithmetic is a safety decision, and a caller must be able to evaluate it
 * deterministically in tests.
 */
export function buildInterlockContext(
  generatorId: string,
  now: number = Date.now(),
): InterlockContext | null {
  const generator = readGeneratorForInterlock(generatorId);
  if (!generator) return null;

  const site = readSiteForInterlock(generator.siteId);
  if (!site) return null;

  const hoursSinceOilChange = Math.max(0, generator.runtimeHours - (generator.runtimeHours - generator.oilChangeIntervalHrs));

  return {
    now,
    generator,
    site,
    commandInFlight: null,
    hoursSinceOilChange,
    fuelLitres: readFuelLitresForInterlock(generator.siteId),
    // Protected-load floor is not modelled yet in the site state; the rule
    // treats an absent floor as "no floor" and does not deny on it. Recorded
    // explicitly rather than left implicit.
    protectedLoadKw: undefined,
  };
}