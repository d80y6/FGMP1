/**
 * FgmpEngine — Thin Facade over decomposed services
 *
 * Refactored from a monolithic 3,192-line class into:
 * - EngineCore: state management, initialization, snapshots
 * - SimulationService: asset physics and telemetry
 * - AlarmService: evaluation, escalation, suppression
 * - ControlService: interlock enforcement and dispatch
 * - PersistenceService: database writes and metrics
 */

import { Prisma } from "@prisma/client";
import { SimulatedGeneratorDispatch } from "./dispatch/simulated";
import type { GeneratorDispatch } from "./dispatch/types";
import type {
  TankState, GenState, BattState, SiteState, IoTDeviceState,
  DispenserCommand, DispenserState, FuelTransactionState, GatewayState,
  EventItem, Kpis, Snapshot, GenCommand, GenStatus,
  AlarmType, Severity,
} from "./types";

import {
  engineCore,
  simulation,
  alarmService,
  controlService,
  persistence,
  EngineTenantContextError,
  EngineTenantScopeError,
} from "./services";

export { EngineTenantContextError, EngineTenantScopeError };
export { EngineCore } from "./services/core";
export { isAlarmSuppressed } from "./suppression-check";
export { assertGeneratorControlScope, assertControlScope } from "./control-scope";
export { enforceInterlock, denialResponseBody } from "./interlock-enforce";
export { evaluateInterlocks, recordDeniedCommand, requiresTwoPerson } from "./interlocks";
export type { InterlockVerdict } from "./interlocks";
export type { ControlCommandName } from "./interlock-rules";
export { withGeneratorCommandLock } from "./command-lock";
export { decideIdempotency, fingerprintPayload, idempotencyRefusalCode } from "./command-idempotency";
export { audit } from "./audit";
export { requireAuth, requireRole, ROLES, assertSiteTenantOwned } from "./auth-helpers";
export { tenantIdOrThrow } from "./route-tenant";
export { rateLimitByUser, applyRateLimitHeaders, READ_LIMIT, MUTATION_LIMIT } from "./rate-limit";
export { errorResponse } from "./api-error";
export { withTenant } from "./tenant-context";
export { toNum, toJsonNumber } from "./decimal";
export { isBatteryLowVoltage, battLowVoltageTripVolts } from "./thresholds-battery";
export { startOfZonedDay, resolvePlatformTimezone } from "./thresholds-time";
export { streamsFor, DEFAULT_SIM_SEED } from "./prng";
export { assertSimulationAllowed } from "./simulation";
export { detectUnexplainedLoss, expectedConsumption, severityFor, DEFAULT_SENSOR_ACCURACY } from "./theft-detection";

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export { mulberry32 };

const MAX_EVENTS = 400;

class FgmpEngine {
  private dispatchImpl: GeneratorDispatch = new SimulatedGeneratorDispatch();
  setDispatch(d: GeneratorDispatch): void { this.dispatchImpl = d; }
  private get dispatch(): GeneratorDispatch { return this.dispatchImpl; }

  get initialized(): boolean { return engineCore.isLoaded(); }
  get initializing(): Promise<void> | null { return (engineCore as any).initializing ?? null; }
  get loadedTenantIds(): string[] { return [...engineCore.loadedTenants()]; }
  get loadedKey(): string { return (engineCore as any).loadedKey ?? ""; }
  get initializingKey(): string | null { return (engineCore as any).initializingKey ?? null; }
  get now(): number { return engineCore.getNow(); }
  set now(value: number) { engineCore.setNow(value); }
  get tickCount(): number { return engineCore.getTickCount(); }
  set tickCount(value: number) { (engineCore as any).tickCount = value; }
  get startedAt(): number { return (engineCore as any).startedAt ?? Date.now(); }

  get sites(): SiteState[] { return (engineCore.getMutableState() as any).sites; }
  get tanks(): TankState[] { return (engineCore.getMutableState() as any).tanks; }
  get generators(): GenState[] { return (engineCore.getMutableState() as any).generators; }
  get batteries(): BattState[] { return (engineCore.getMutableState() as any).batteries; }
  get iotDevices(): IoTDeviceState[] { return (engineCore.getMutableState() as any).iotDevices; }
  get dispensers(): DispenserState[] { return (engineCore.getMutableState() as any).dispensers; }
  get fuelTransactions(): FuelTransactionState[] { return (engineCore.getMutableState() as any).fuelTransactions; }
  get events(): EventItem[] { return (engineCore.getMutableState() as any).events; }
  get gateways(): GatewayState[] { return (engineCore.getMutableState() as any).gateways; }
  get regions(): Snapshot["regions"] { return (engineCore.getMutableState() as any).regions; }

  tenantId = "t-default";
  get openAlarmKeys(): Set<string> { return (engineCore.getMutableState() as any).openAlarmKeys; }
  get transientRaisedAt(): Map<string, number> { return (engineCore.getMutableState() as any).transientRaisedAt; }
  get lastGenRuntimeHours(): Map<string, number> { return (engineCore.getMutableState() as any).lastGenRuntimeHours; }
  get tankPtr(): Map<string, number> { return (engineCore.getMutableState() as any).tankPtr; }

  get escalationThresholds() { return alarmService.getEscalationThresholds(); }
  set escalationThresholds(t: { l1ToL2Minutes: number; l2ToL3Minutes: number }) { alarmService.setEscalationThresholds(t); }

  private tenantsFor(expectedTenantId?: string | null): readonly string[] {
    const core = engineCore.getMutableState() as any;
    return expectedTenantId ? [expectedTenantId] : (core.loadedTenantIds ?? []);
  }

  async ensureInit(tenants: readonly string[]): Promise<void> { return engineCore.ensureInit(tenants); }
  async ensureAllTenants(): Promise<void> { return engineCore.ensureAllTenants(); }
  loadedTenants(): readonly string[] { return engineCore.loadedTenants(); }
  isLoaded(): boolean { return engineCore.isLoaded(); }

  async tick(seconds: number = 5): Promise<{ tickCount: number; eventsCreated: number; alarmsCreated: number }> {
    const state = engineCore.getMutableState() as any;
    state.now = Date.now();
    engineCore.setNow(state.now);
    const tickHours = seconds / 3600;
    const tickCount = engineCore.incrementTick();
    const beforeEvents = state.events.length;

    const context = {
      now: state.now, tickHours, rng: (this as any).rng ?? {},
      openAlarmKeys: state.openAlarmKeys, transientRaisedAt: state.transientRaisedAt,
      tankPtr: state.tankPtr, lastGenRuntimeHours: state.lastGenRuntimeHours,
    };

    const simResult = await simulation.tick({
      sites: state.sites, tanks: state.tanks, generators: state.generators,
      batteries: state.batteries, iotDevices: state.iotDevices,
      dispensers: state.dispensers, fuelTransactions: state.fuelTransactions,
      gateways: state.gateways, events: state.events,
    }, context);

    state.events = simResult.events;
    const eventsCreated = state.events.length - beforeEvents;
    const alarmsCreated = simResult.alarmsCreated;

    for (const tid of state.loadedTenantIds) {
      const candidates = await alarmService.evaluate({
        sites: state.sites.filter((s: any) => s.tenantId === tid),
        tanks: state.tanks.filter((t: any) => state.sites.find((s: any) => s.id === t.siteId && s.tenantId === tid)),
        generators: state.generators.filter((g: any) => state.sites.find((s: any) => s.id === g.siteId && s.tenantId === tid)),
        batteries: state.batteries.filter((b: any) => state.sites.find((s: any) => s.id === b.siteId && s.tenantId === tid)),
        dispensers: state.dispensers.filter((d: any) => state.sites.find((s: any) => s.id === d.siteId && s.tenantId === tid)),
      }, { tenantId: tid, now: state.now, openAlarmKeys: state.openAlarmKeys, transientRaisedAt: state.transientRaisedAt });

      for (const c of candidates) await this.raiseAlarm(c);

      const resolved = alarmService.resolveCleared({
        tanks: state.tanks, generators: state.generators, batteries: state.batteries,
        dispensers: state.dispensers, sites: state.sites,
      }, state.openAlarmKeys, state.now);
      for (const r of resolved) await this.autoResolve(r.type, r.entityId, r.severity);

      await alarmService.escalateStale(tid, state.now);
    }

    return { tickCount, eventsCreated, alarmsCreated };
  }

  async controlDispenser(dispenserId: string, command: DispenserCommand, presetVolumeLitres?: number, tenantId?: string | null): Promise<{ ok: boolean; message: string }> {
    if (!tenantId) throw new Error("controlDispenser requires tenantId");
    return controlService.controlDispenser({ dispenserId, command, presetVolumeLitres, userId: "system", tenantId });
  }

  async createDispenser(data: any): Promise<any> { return null; }
  async updateDispenser(id: string, data: any): Promise<any> { return null; }
  async deleteDispenser(id: string): Promise<boolean> { return false; }

  async applyCommand(genId: string, command: GenCommand, userId: string, reason?: string, expectedTenantId?: string | null): Promise<{ ok: boolean; message: string }> {
    const tid = expectedTenantId ?? (this.tenantsFor(expectedTenantId)[0]);
    if (!tid) throw new Error("applyCommand requires tenantId");
    return controlService.controlGenerator({ generatorId: genId, command, userId, reason, tenantId: tid });
  }

  async applyEspReboot(dispenserId: string, userId: string, tenantId?: string | null): Promise<{ ok: boolean; message: string }> {
    if (!tenantId) throw new Error("applyEspReboot requires tenantId");
    return controlService.rebootEspController({ dispenserId, userId, tenantId });
  }

  async applyFirmwareDeployment(dispenserId: string, releaseId: string, userId: string, tenantId?: string | null): Promise<{ ok: boolean; message: string }> {
    if (!tenantId) throw new Error("applyFirmwareDeployment requires tenantId");
    return controlService.deployFirmware({ dispenserId, releaseId, userId, tenantId });
  }

  async applyGatewayReboot(gatewayId: string, userId: string, tenantId?: string | null): Promise<{ ok: boolean; message: string }> {
    if (!tenantId) throw new Error("applyGatewayReboot requires tenantId");
    return controlService.rebootGateway({ gatewayId, userId, tenantId });
  }

  pushEvent(siteId: string, kind: string, message: string, meta?: Record<string, unknown>): void {
    const state = engineCore.getMutableState() as any;
    const id = `ev-${Math.random().toString(36).slice(2, 10)}`;
    state.events.unshift({ id, siteId, kind, message, ts: state.now, meta });
    if (state.events.length > MAX_EVENTS) state.events.pop();
    const tenantId = this.tenantIdForSite(siteId);
    persistence.pushEvent({ siteId, kind, message, meta, tenantId });
  }

  private async raiseAlarm(a: { siteId: string; type: AlarmType; severity: Severity; entityKind?: string; entityId?: string; message: string; value?: number; threshold?: number }): Promise<number> {
    const state = engineCore.getMutableState() as any;
    const key = `${a.type}:${a.severity}:${a.entityId ?? "site"}`;
    if (state.openAlarmKeys.has(key)) return 0;
    const tenantId = this.tenantIdForSite(a.siteId);
    try {
      const suppressed = await import("./suppression-check").then(m => m.isAlarmSuppressed(a.siteId, a.type, tenantId));
      if (suppressed) {
        this.pushEvent(a.siteId, "SUPPRESSED", `Alarm suppressed: ${a.type} — ${a.message}`, { type: a.type, severity: a.severity, reason: "maintenance-window" });
        return 0;
      }
    } catch {}
    state.openAlarmKeys.add(key);
    try {
      const alarmId = await persistence.createAlarm({
        tenantId, siteId: a.siteId, type: a.type, severity: a.severity,
        status: "OPEN", escalationLevel: 1, entityKind: a.entityKind ?? null,
        entityId: a.entityId ?? null, message: a.message, value: a.value ?? null, threshold: a.threshold ?? null,
      });
      await persistence.createNotification({
        tenantId, channel: "SMS", recipient: "+967-ops-oncall",
        subject: `[${a.severity}] ${a.type}`, body: a.message, alarmId, status: "QUEUED", attempts: 0,
      });
      return 1;
    } catch {
      state.openAlarmKeys.delete(key);
      return 0;
    }
  }

  private async autoResolve(type: AlarmType, entityId: string, severity?: Severity) {
    const state = engineCore.getMutableState() as any;
    const tenantId = this.tenantIdForSite((state.sites.find((s: any) => 
      state.generators.some((g: any) => g.id === entityId && g.siteId === s.id) ||
      state.tanks.some((t: any) => t.id === entityId && t.siteId === s.id) ||
      state.batteries.some((b: any) => b.id === entityId && b.siteId === s.id) ||
      state.dispensers.some((d: any) => d.id === entityId && d.siteId === s.id)
    )?.id) ?? state.sites[0]?.id);
    if (severity) {
      const key = `${type}:${severity}:${entityId}`;
      if (!state.openAlarmKeys.has(key)) return;
      state.openAlarmKeys.delete(key);
      await persistence.autoResolveAlarms(tenantId, type, entityId, severity);
      return;
    }
    for (const s of ["L1", "L2", "L3"] as Severity[]) {
      const key = `${type}:${s}:${entityId}`;
      if (state.openAlarmKeys.has(key)) {
        state.openAlarmKeys.delete(key);
        await persistence.autoResolveAlarms(tenantId, type, entityId, s);
      }
    }
  }

  private async escalateStaleAlarms() {
    const state = engineCore.getMutableState() as any;
    for (const tid of state.loadedTenantIds) await alarmService.escalateStale(tid, state.now);
  }

  private tenantIdForSite(siteId: string): string {
    const state = engineCore.getMutableState() as any;
    const site = state.sites.find((s: any) => s.id === siteId);
    return site?.tenantId ?? this.tenantId ?? "t-default";
  }

  async reload(): Promise<void> { return engineCore.reload(); }
  async flushBackgroundWrites(): Promise<void> { return persistence.flushBackgroundWrites(); }
  async snapshotForTenant(tenantId: string | null = null): Promise<Snapshot> { return engineCore.snapshotForTenant(tenantId); }
  async snapshot(): Promise<Snapshot> { return engineCore.snapshot(); }
  async bridgeSiteDirectory(): Promise<Array<{ id: string; tenantId: string }>> { return engineCore.bridgeSiteDirectory(); }
}

const globalForEngine = globalThis as unknown as { __fgmpEngine?: FgmpEngine };
export const engine: FgmpEngine = globalForEngine.__fgmpEngine ?? new FgmpEngine();
if (process.env.NODE_ENV !== "production") globalForEngine.__fgmpEngine = engine;
