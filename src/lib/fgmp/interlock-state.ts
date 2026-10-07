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
import { withTenant } from "./tenant-context";
import { resolveThresholds } from "./interlock-thresholds";
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
 * Usable capacity of the tank feeding a site's generator, in litres.
 *
 * Phase 5: the cranking-fuel rules are expressed as a PERCENTAGE of capacity,
 * so capacity is not optional context any more — a missing value now DENIES a
 * start rather than permitting one.
 */
export function readTankCapacityForInterlock(siteId: string): number | undefined {
  const tank = engine.tanks.find((t) => t.siteId === siteId);
  if (!tank || !Number.isFinite(tank.capacity) || tank.capacity <= 0) return undefined;
  return tank.capacity;
}

/**
 * Load the tenant's interlock thresholds from the database.
 *
 * PHASE 5 — this is the fix for the "stored but never read" gap. `InterlockThreshold`
 * is FORCE-RLS-protected, so the read MUST happen inside `withTenant`: an
 * unscoped read returns zero rows, which would silently restore the shipped
 * defaults and make an operator's confirmed OEM limit vanish without any error.
 *
 * SCOPE: a per-SITE row wins over the tenant-wide row for the same key, because
 * a coastal site or a restricted-schedule genset can legitimately differ.
 *
 * FAILS LOUDLY: if the read throws, the error propagates. A transient database
 * blip must not silently change a safety limit — the caller gets an explicit
 * failure rather than an engine quietly running on defaults.
 *
 * Returns the resolved thresholds AND whether they came from the database, so
 * the verdict can record which source produced the number that denied a command.
 */
export async function loadThresholdsForInterlock(
  tenantId: string,
  siteId: string,
): Promise<{ resolved: import("./interlock-thresholds").ResolvedThresholds; fromDatabase: boolean; rowCount: number }> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.interlockThreshold.findMany({
      where: { tenantId, OR: [{ siteId }, { siteId: null }] },
      select: {
        thresholdKey: true,
        value: true,
        source: true,
        sourceRef: true,
        confirmedById: true,
        confirmedAt: true,
        siteId: true,
      },
    }),
  );

  // Per-site rows must override tenant-wide rows for the same key. Sorting
  // site-specific last means the later row wins in `resolveThresholds`, which
  // applies rows in order.
  const ordered = [
    ...rows.filter((r) => r.siteId === null),
    ...rows.filter((r) => r.siteId !== null),
  ];

  return {
    resolved: resolveThresholds(ordered),
    fromDatabase: rows.length > 0,
    rowCount: rows.length,
  };
}

/**
 * Build the full context for one generator + command, or null if the engine
 * cannot describe the asset.
 *
 * `now` is injected so the caller controls the clock — cooldown and backoff
 * arithmetic is a safety decision, and a caller must be able to evaluate it
 * deterministically in tests.
 *
 * ASYNC as of Phase 5: it must load the tenant's thresholds from the database,
 * which an unscoped (and therefore always-empty) read could not do.
 */
export async function buildInterlockContext(
  generatorId: string,
  tenantId: string,
  now: number = Date.now(),
): Promise<InterlockContext | null> {
  const generator = readGeneratorForInterlock(generatorId);
  if (!generator) return null;

  const site = readSiteForInterlock(generator.siteId);
  if (!site) return null;

  const hoursSinceOilChange = Math.max(0, generator.runtimeHours - (generator.runtimeHours - generator.oilChangeIntervalHrs));

  // Thresholds come from the DATABASE when the tenant has configured any. The
  // load is inside withTenant (see loadThresholdsForInterlock) and a failure
  // propagates rather than degrading to defaults.
  const { resolved, fromDatabase } = await loadThresholdsForInterlock(tenantId, generator.siteId);

  return {
    now,
    generator,
    site,
    commandInFlight: null,
    hoursSinceOilChange,
    fuelLitres: readFuelLitresForInterlock(generator.siteId),
    tankCapacityLitres: readTankCapacityForInterlock(generator.siteId),
    // Protected-load floor is not modelled yet in the site state; the rule
    // treats an absent floor as "no floor" and does not deny on it. Recorded
    // explicitly rather than left implicit.
    protectedLoadKw: undefined,
    // The tenant's CONFIGURED thresholds, and whether they actually came from
    // the database. Carried into the verdict so a denial can say "refused at
    // 120 °C, your OEM limit" rather than implying the hardcoded default was
    // used. An audit trail that reports 85 °C when the operator confirmed 120 °C
    // is not reconstructing the event accurately.
    thresholds: resolved,
    thresholdsFromDatabase: fromDatabase,
  };
}