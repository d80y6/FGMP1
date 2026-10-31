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

import type { FuelType } from "@prisma/client";
import { SimulatedGeneratorDispatch } from "./dispatch/simulated";
import type { GeneratorDispatch } from "./dispatch/types";
import { withTenant } from "./tenant-context";
import { toNum } from "./decimal";
import type { Rng } from "./prng";
import type {
  TankState, GenState, BattState, SiteState, IoTDeviceState,
  DispenserCommand, DispenserState, FuelTransactionState, GatewayState,
  EventItem, Snapshot, GenCommand,
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
export { withTenant };
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
  get initializing(): Promise<void> | null { return engineCore.getState().initializing; }
  get loadedTenantIds(): string[] { return [...engineCore.loadedTenants()]; }
  get loadedKey(): string { return engineCore.getState().loadedKey; }
  get initializingKey(): string | null { return engineCore.getState().initializingKey; }
  get now(): number { return engineCore.getNow(); }
  set now(value: number) { engineCore.setNow(value); }
  get tickCount(): number { return engineCore.getTickCount(); }
  set tickCount(value: number) { engineCore.setTickCount(value); }
  get startedAt(): number { return engineCore.getState().startedAt; }

  get sites(): SiteState[] { return engineCore.getMutableState().sites; }
  get tanks(): TankState[] { return engineCore.getMutableState().tanks; }
  get generators(): GenState[] { return engineCore.getMutableState().generators; }
  get batteries(): BattState[] { return engineCore.getMutableState().batteries; }
  get iotDevices(): IoTDeviceState[] { return engineCore.getMutableState().iotDevices; }
  get dispensers(): DispenserState[] { return engineCore.getMutableState().dispensers; }
  get fuelTransactions(): FuelTransactionState[] { return engineCore.getMutableState().fuelTransactions; }
  get events(): EventItem[] { return engineCore.getMutableState().events; }
  get gateways(): GatewayState[] { return engineCore.getMutableState().gateways; }
  get regions(): Snapshot["regions"] { return engineCore.getMutableState().regions; }

  tenantId = "t-default";
  /** Per-stream PRNGs used by the simulation, keyed by stream name. */
  rng: Record<string, Rng> = {};
  get openAlarmKeys(): Set<string> { return engineCore.getMutableState().openAlarmKeys; }
  get transientRaisedAt(): Map<string, number> { return engineCore.getMutableState().transientRaisedAt; }
  get lastGenRuntimeHours(): Map<string, number> { return engineCore.getMutableState().lastGenRuntimeHours; }
  get tankPtr(): Map<string, number> { return engineCore.getMutableState().tankPtr; }

  get escalationThresholds() { return alarmService.getEscalationThresholds(); }
  set escalationThresholds(t: { l1ToL2Minutes: number; l2ToL3Minutes: number }) { alarmService.setEscalationThresholds(t); }

  private tenantsFor(expectedTenantId?: string | null): readonly string[] {
    const core = engineCore.getMutableState();
    return expectedTenantId ? [expectedTenantId] : core.loadedTenantIds;
  }

  async ensureInit(tenants: readonly string[]): Promise<void> { return engineCore.ensureInit(tenants); }
  async ensureAllTenants(): Promise<void> { return engineCore.ensureAllTenants(); }
  loadedTenants(): readonly string[] { return engineCore.loadedTenants(); }
  isLoaded(): boolean { return engineCore.isLoaded(); }

  async tick(seconds: number = 5): Promise<{ tickCount: number; eventsCreated: number; alarmsCreated: number }> {
    const state = engineCore.getMutableState();
    state.now = Date.now();
    engineCore.setNow(state.now);
    const tickHours = seconds / 3600;
    const tickCount = engineCore.incrementTick();
    const beforeEvents = state.events.length;

    const context = {
      now: state.now, tickHours, rng: this.rng,
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
        sites: state.sites.filter((s: SiteState) => s.tenantId === tid),
        tanks: state.tanks.filter((t: TankState) => state.sites.find((s: SiteState) => s.id === t.siteId && s.tenantId === tid)),
        generators: state.generators.filter((g: GenState) => state.sites.find((s: SiteState) => s.id === g.siteId && s.tenantId === tid)),
        batteries: state.batteries.filter((b: BattState) => state.sites.find((s: SiteState) => s.id === b.siteId && s.tenantId === tid)),
        dispensers: state.dispensers.filter((d: DispenserState) => state.sites.find((s: SiteState) => s.id === d.siteId && s.tenantId === tid)),
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

  /**
   * Create a dispenser: DB row first, then in-memory state.
   *
   * Writes both so a subsequent `GET /api/fgmp/dispensers` (served from engine
   * state) reflects the row immediately rather than only after the next reload.
   * The caller has already checked tenant ownership and `espDeviceId`
   * uniqueness; the site lookup here is what supplies `tenantId`.
   */
  async createDispenser(data: {
    siteId: string;
    label: string;
    manufacturer: string;
    model: string;
    nozzleCount: number;
    fuelType: FuelType;
    maxFlowLpm: number;
    espDeviceId: string;
    espFirmware: string;
    rs485Baudrate: number;
    rs485Address: number;
    rs485Parity: string;
    ipAddress?: string;
    macAddress?: string;
  }): Promise<DispenserState> {
    await this.ensureInit(this.tenantsFor());
    const site = this.sites.find((s) => s.id === data.siteId);
    if (!site) throw new Error(`createDispenser: site ${data.siteId} not found`);
    const row = await withTenant(site.tenantId, (tx) =>
      tx.fuelDispenser.create({
        data: {
          tenantId: site.tenantId,
          siteId: data.siteId,
          label: data.label,
          manufacturer: data.manufacturer,
          model: data.model,
          nozzleCount: data.nozzleCount,
          fuelType: data.fuelType,
          maxFlowLpm: data.maxFlowLpm,
          espDeviceId: data.espDeviceId,
          espFirmware: data.espFirmware,
          rs485Baudrate: data.rs485Baudrate,
          rs485Address: data.rs485Address,
          rs485Parity: data.rs485Parity,
          ipAddress: data.ipAddress || null,
          macAddress: data.macAddress || null,
          status: "IDLE",
          mode: "AUTO",
        },
      }),
    );
    const state: DispenserState = {
      id: row.id,
      siteId: row.siteId,
      label: row.label,
      manufacturer: row.manufacturer,
      model: row.model,
      nozzleCount: row.nozzleCount,
      fuelType: row.fuelType,
      maxFlowLpm: row.maxFlowLpm,
      status: row.status,
      mode: row.mode as DispenserState["mode"],
      espDeviceId: row.espDeviceId,
      espFirmware: row.espFirmware,
      rs485Baudrate: row.rs485Baudrate,
      rs485Address: row.rs485Address,
      rs485Parity: row.rs485Parity,
      wifiRssi: row.wifiRssi,
      ipAddress: row.ipAddress ?? undefined,
      macAddress: row.macAddress ?? undefined,
      lastCommAt: row.lastCommAt?.getTime() ?? this.now,
      currentVolumeLitres: toNum(row.currentVolumeLitres),
      presetVolumeLitres: row.presetVolumeLitres === null ? undefined : toNum(row.presetVolumeLitres),
      flowRateLpm: toNum(row.flowRateLpm),
      totalizerLitres: toNum(row.totalizerLitres),
      currentTransactionId: row.currentTransactionId ?? undefined,
      lastTransactionAt: row.lastTransactionAt?.getTime(),
      tempC: row.tempC,
      history: [],
    };
    engineCore.getMutableState().dispensers.push(state);
    return state;
  }

  /**
   * Update a dispenser: DB row first, then the in-memory fields that changed.
   *
   * Returns the live state when this process holds the dispenser, or `null` when
   * it is resident only in the database.
   */
  async updateDispenser(
    id: string,
    data: Partial<{
      label: string;
      manufacturer: string;
      model: string;
      nozzleCount: number;
      fuelType: FuelType;
      maxFlowLpm: number;
      espFirmware: string;
      rs485Baudrate: number;
      rs485Address: number;
      rs485Parity: string;
      ipAddress: string | null;
      macAddress: string | null;
      status: string;
      mode: string;
    }>,
  ): Promise<DispenserState | null> {
    await this.ensureInit(this.tenantsFor());
    const live = this.dispensers.find((d) => d.id === id);
    const site = live ? this.sites.find((s) => s.id === live.siteId) : undefined;
    const tenantId = site?.tenantId ?? this.tenantId;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
    if (Object.keys(patch).length > 0) {
      await withTenant(tenantId, (tx) => tx.fuelDispenser.update({ where: { id }, data: patch }));
    }
    if (!live) return null;
    if (data.label !== undefined) live.label = data.label;
    if (data.manufacturer !== undefined) live.manufacturer = data.manufacturer;
    if (data.model !== undefined) live.model = data.model;
    if (data.nozzleCount !== undefined) live.nozzleCount = data.nozzleCount;
    if (data.fuelType !== undefined) live.fuelType = data.fuelType;
    if (data.maxFlowLpm !== undefined) live.maxFlowLpm = data.maxFlowLpm;
    if (data.espFirmware !== undefined) live.espFirmware = data.espFirmware;
    if (data.rs485Baudrate !== undefined) live.rs485Baudrate = data.rs485Baudrate;
    if (data.rs485Address !== undefined) live.rs485Address = data.rs485Address;
    if (data.rs485Parity !== undefined) live.rs485Parity = data.rs485Parity;
    if (data.ipAddress !== undefined) live.ipAddress = data.ipAddress ?? undefined;
    if (data.macAddress !== undefined) live.macAddress = data.macAddress ?? undefined;
    if (data.status !== undefined) live.status = data.status as DispenserState["status"];
    if (data.mode !== undefined) live.mode = data.mode as DispenserState["mode"];
    return live;
  }

  /**
   * Delete a dispenser from the database and from engine state.
   *
   * `FuelTransaction` rows cascade in the database; the in-memory transaction
   * list is filtered to match so a deleted dispenser's history cannot linger in
   * a snapshot.
   */
  async deleteDispenser(id: string): Promise<boolean> {
    await this.ensureInit(this.tenantsFor());
    const live = this.dispensers.find((d) => d.id === id);
    const site = live ? this.sites.find((s) => s.id === live.siteId) : undefined;
    const tenantId = site?.tenantId ?? this.tenantId;
    await withTenant(tenantId, (tx) => tx.fuelDispenser.delete({ where: { id } }));
    const state = engineCore.getMutableState();
    const idx = state.dispensers.findIndex((d) => d.id === id);
    if (idx >= 0) state.dispensers.splice(idx, 1);
    state.fuelTransactions = state.fuelTransactions.filter((t) => t.dispenserId !== id);
    return true;
  }

  /**
   * Remote control of a generator — the DISPATCH BOUNDARY.
   *
   * `ControlService.controlGenerator` owns the interlock checks, the scope guard
   * and the command lock, then calls this as its execution step. The facade must
   * therefore perform the dispatch itself: delegating back to the service was a
   * mutual call that recursed forever and never reached a state change.
   *
   * The terminal status is derived from what the DISPATCH reports, never from
   * what the engine decided: a command that was never attempted must never read
   * as executed. That is why `NO_TRANSPORT` maps to FAILED (with the reason
   * preserved) and `TIMEOUT_AMBIGUOUS` to TIMEOUT with an explicit
   * do-not-auto-retry marker.
   */
  async applyCommand(
    genId: string,
    command: GenCommand,
    userId: string,
    reason?: string,
    expectedTenantId?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    const tid = expectedTenantId ?? (this.tenantsFor(expectedTenantId)[0]);
    if (!tid) throw new Error("applyCommand requires tenantId");
    await this.ensureInit([tid]);

    const g = this.generators.find((x) => x.id === genId);
    if (!g) return { ok: false, message: `Generator ${genId} not found` };
    const site = this.sites.find((s) => s.id === g.siteId);
    if (!site) return { ok: false, message: `Generator ${genId} has no resident site` };
    if (site.tenantId !== tid) {
      return { ok: false, message: `Generator ${genId} not accessible to tenant ${tid}` };
    }

    if (site.commLossUntil && this.now <= site.commLossUntil) {
      return { ok: false, message: "Site communication down — command refused until link restored" };
    }

    // Written PENDING, not SENT: nothing has been transmitted yet.
    const cmd = await withTenant(site.tenantId, (tx) =>
      tx.controlCommand.create({
        data: {
          tenantId: site.tenantId,
          generatorId: genId,
          command,
          status: "PENDING",
          reason: reason ?? null,
          issuedById: userId,
          executedAt: null,
          result: null,
        },
      }),
    );

    const outcome = await this.dispatch.dispatch({ command, generatorId: genId, now: this.now });

    if (outcome.kind === "EXECUTED") {
      await withTenant(site.tenantId, (tx) =>
        tx.controlCommand.update({
          where: { id: cmd.id },
          data: {
            status: "EXECUTED",
            executedAt: new Date(outcome.acknowledgement?.at ?? this.now),
            result: JSON.stringify({
              transport: outcome.acknowledgement?.transport,
              detail: outcome.acknowledgement?.detail,
            }),
          },
        }),
      );
      this.applySimulatedState(g, command, cmd.id);
      return {
        ok: true,
        message: `${command} acknowledged by ${outcome.acknowledgement?.transport ?? "device"}`,
      };
    }

    if (outcome.kind === "FAILED") {
      await withTenant(site.tenantId, (tx) =>
        tx.controlCommand.update({
          where: { id: cmd.id },
          data: { status: "FAILED", result: outcome.reason ?? "FAILED" },
        }),
      );
      return { ok: false, message: outcome.reason ?? `${command} was rejected` };
    }

    if (outcome.kind === "TIMEOUT_AMBIGUOUS") {
      await withTenant(site.tenantId, (tx) =>
        tx.controlCommand.update({
          where: { id: cmd.id },
          data: {
            status: "TIMEOUT",
            executedAt: null,
            result: `UNCONFIRMED_DO_NOT_AUTO_RETRY: ${outcome.reason ?? "no reply"}`,
          },
        }),
      );
      return {
        ok: false,
        message:
          `${command} outcome is UNKNOWN — the generator did not reply. It may ` +
          `or may not have acted. Check the set physically before re-sending.`,
      };
    }

    // NO_TRANSPORT — the honest answer when no transport is configured: the
    // command was NOT sent, so it must not read as executed or even attempted.
    await withTenant(site.tenantId, (tx) =>
      tx.controlCommand.update({
        where: { id: cmd.id },
        data: {
          status: "FAILED",
          executedAt: null,
          result: `NO_TRANSPORT: ${outcome.reason ?? "no generator transport configured"}`,
        },
      }),
    );
    return {
      ok: false,
      message:
        `${command} was NOT sent to a generator: ${
          outcome.reason ?? "no generator transport is configured on this deployment"
        }`,
    };
  }

  /** Apply the in-memory generator state a completed command implies. */
  private applySimulatedState(g: GenState, command: GenCommand, cmdId: string): void {
    if (command === "START") {
      g.status = "RUNNING";
      g.mode = "REMOTE";
      g.lastStartedAt = this.now;
      this.pushEvent(g.siteId, "CONTROL", `REMOTE START ${g.label} (cmd ${cmdId.slice(-6)})`, { genId: g.id });
    } else if (command === "STOP") {
      g.status = "STOPPED";
      g.mode = "REMOTE";
      g.lastStoppedAt = this.now;
      this.pushEvent(g.siteId, "CONTROL", `REMOTE STOP ${g.label} (cmd ${cmdId.slice(-6)})`, { genId: g.id });
    } else if (command === "EMERGENCY_STOP") {
      g.status = "FAULT";
      g.faultUntil = this.now + 30 * 60 * 1000;
      this.pushEvent(g.siteId, "CRITICAL", `EMERGENCY STOP ${g.label} (cmd ${cmdId.slice(-6)})`, { genId: g.id });
    } else if (command === "RESET") {
      g.status = "STOPPED";
      g.faultUntil = undefined;
      this.pushEvent(g.siteId, "CONTROL", `RESET ${g.label} (cmd ${cmdId.slice(-6)})`, { genId: g.id });
    }
  }

  /**
   * Reboot a dispenser's ESP controller.
   *
   * EXECUTION step: `ControlService.rebootEspController` owns the scope check
   * and the audit row, then calls this. It must therefore PERFORM the reboot
   * rather than call back into the service — the mutual call this replaces
   * recursed forever and never reached a state change.
   */
  async applyEspReboot(dispenserId: string, _userId: string, tenantId?: string | null): Promise<{ ok: boolean; status?: string; message: string }> {
    await this.ensureInit(this.tenantsFor(tenantId));
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) return { ok: false, message: `Dispenser ${dispenserId} not found` };
    const site = this.sites.find((s) => s.id === d.siteId);
    if (!site) return { ok: false, message: `Dispenser ${dispenserId} has no resident site` };
    if (tenantId != null && site.tenantId !== tenantId) {
      return { ok: false, message: `Dispenser ${dispenserId} not accessible to tenant ${tenantId}` };
    }
    const ESP_REBOOT_MS = 30_000;
    d.rebootingUntil = this.now + ESP_REBOOT_MS;
    d.status = "OFFLINE";
    d.flowRateLpm = 0;
    d.lastCommAt = this.now - ESP_REBOOT_MS;
    this.pushEvent(d.siteId, "WARN", `ESP controller reboot initiated on ${d.label} (${ESP_REBOOT_MS / 1000}s)`, { dispenserId: d.id });
    return { ok: true, status: "OFFLINE", message: `ESP reboot initiated on ${d.label}` };
  }

  /**
   * Queue a firmware deployment for a dispenser.
   *
   * EXECUTION step for `ControlService.deployFirmware`; see `applyEspReboot`.
   */
  async applyFirmwareDeployment(dispenserId: string, releaseId: string, userId: string, tenantId?: string | null): Promise<{ ok: boolean; message: string; deploymentId?: string; status?: string }> {
    await this.ensureInit(this.tenantsFor(tenantId));
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) return { ok: false, message: `Dispenser ${dispenserId} not found` };
    const site = this.sites.find((s) => s.id === d.siteId);
    if (!site) return { ok: false, message: `Dispenser ${dispenserId} has no resident site` };
    if (tenantId != null && site.tenantId !== tenantId) {
      return { ok: false, message: `Dispenser ${dispenserId} not accessible to tenant ${tenantId}` };
    }
    const release = await withTenant(site.tenantId, (tx) =>
      tx.espFirmwareRelease.findUnique({ where: { id: releaseId }, select: { id: true, version: true } }),
    );
    if (!release) return { ok: false, message: "Firmware release not found" };
    const deployment = await withTenant(site.tenantId, (tx) =>
      tx.espFirmwareDeployment.create({
        data: {
          tenantId: site.tenantId,
          releaseId,
          dispenserId,
          status: "QUEUED",
          initiatedById: userId,
        },
      }),
    );
    this.pushEvent(d.siteId, "CONTROL", `Firmware ${release.version} queued for ${d.label}`, { dispenserId: d.id, releaseId });
    return { ok: true, deploymentId: deployment.id, status: "QUEUED", message: `Firmware ${release.version} queued for ${d.label}` };
  }

  /**
   * Reboot a site gateway.
   *
   * EXECUTION step for `ControlService.rebootGateway`; see `applyEspReboot`.
   */
  async applyGatewayReboot(gatewayId: string, _userId: string, tenantId?: string | null): Promise<{ ok: boolean; status?: string; message: string }> {
    await this.ensureInit(this.tenantsFor(tenantId));
    const gw = this.gateways.find((g) => g.id === gatewayId);
    if (!gw) return { ok: false, message: `Gateway ${gatewayId} not found` };
    const site = this.sites.find((s) => s.id === gw.siteId);
    if (!site) return { ok: false, message: `Gateway ${gatewayId} has no resident site` };
    if (tenantId != null && site.tenantId !== tenantId) {
      return { ok: false, message: `Gateway ${gatewayId} not accessible to tenant ${tenantId}` };
    }
    gw.status = "DEGRADED";
    gw.rebootingUntil = this.now + 20_000;
    gw.lastSeenAt = this.now;
    this.pushEvent(gw.siteId, "WARN", `Gateway ${gw.hostname} reboot initiated (20s)`, { gatewayId: gw.id });
    return { ok: true, status: "DEGRADED", message: `Reboot initiated on ${gw.hostname}` };
  }

  pushEvent(siteId: string, kind: string, message: string, meta?: Record<string, unknown>): void {
    const state = engineCore.getMutableState();
    const id = `ev-${Math.random().toString(36).slice(2, 10)}`;
    state.events.unshift({ id, siteId, kind, message, ts: state.now, meta });
    if (state.events.length > MAX_EVENTS) state.events.pop();
    const tenantId = this.tenantIdForSite(siteId);
    persistence.pushEvent({ siteId, kind, message, meta, tenantId });
  }

  private async raiseAlarm(a: { siteId: string; type: AlarmType; severity: Severity; entityKind?: string; entityId?: string; message: string; value?: number; threshold?: number }): Promise<number> {
    const state = engineCore.getMutableState();
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
    const state = engineCore.getMutableState();
    const tenantId = this.tenantIdForSite((state.sites.find((s: SiteState) =>
      state.generators.some((g: GenState) => g.id === entityId && g.siteId === s.id) ||
      state.tanks.some((t: TankState) => t.id === entityId && t.siteId === s.id) ||
      state.batteries.some((b: BattState) => b.id === entityId && b.siteId === s.id) ||
      state.dispensers.some((d: DispenserState) => d.id === entityId && d.siteId === s.id)
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
    const state = engineCore.getMutableState();
    for (const tid of state.loadedTenantIds) await alarmService.escalateStale(tid, state.now);
  }

  private tenantIdForSite(siteId: string): string {
    const state = engineCore.getMutableState();
    const site = state.sites.find((s: SiteState) => s.id === siteId);
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
