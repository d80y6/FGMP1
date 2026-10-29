/**
 * EngineCore — tenant state management, initialization, and snapshot generation.
 *
 * Why this exists:
 * - The engine's initialization logic (ensureInit, loadInto, backfillHistory) was tangled with simulation.
 * - Multi-tenant snapshot filtering was inline in engine.ts.
 * - Bridge site directory for IoT was mixed in.
 *
 * This service provides:
 * - Explicit tenant-scoped initialization (no ambient fallback).
 * - In-memory state storage per tenant.
 * - Snapshot generation with tenant filtering.
 * - Bridge site directory for IoT bridge.
 */

import { Prisma } from "@prisma/client";
import { db, rlsEnforced } from "@/lib/db";
import { getOpsDb } from "../owner-db";
import { withTenant } from "../tenant-context";
import { toNum } from "../decimal";
import { startOfZonedDay, resolvePlatformTimezone } from "../thresholds-time";
import type {
  TankState, GenState, BattState, SiteState, IoTDeviceState,
  DispenserState, FuelTransactionState, GatewayState, EventItem,
  Kpis, Snapshot,
} from "../types";
import { isBatteryLowVoltage } from "../thresholds-battery";
import type { GenStatus } from "../types";
import { mulberry32 } from "../engine";

const ACTIVE_TENANT_IDS_TTL_MS = 15_000;
const HISTORY_POINTS = 288;
const MAX_EVENTS = 400;
const MAX_DISPENSER_TXN_MEMORY = 50;
const MAX_RECENT_TXN_SNAPSHOT = 200;
const UNIT_PRICE_YER_PER_L = 520;

let activeTenantIdsCache: { fetchedAt: number; ids: string[] } | null = null;
let activeTenantIdsRequest: Promise<string[]> | null = null;

async function resolveActiveTenantIds(): Promise<string[]> {
  if (activeTenantIdsCache && Date.now() - activeTenantIdsCache.fetchedAt < ACTIVE_TENANT_IDS_TTL_MS) {
    return activeTenantIdsCache.ids;
  }
  if (activeTenantIdsRequest) return activeTenantIdsRequest;
  activeTenantIdsRequest = db.tenant
    .findMany({ select: { id: true }, orderBy: { id: "asc" } })
    .then((rows) => {
      const ids = rows.map((r) => r.id);
      activeTenantIdsCache = { fetchedAt: Date.now(), ids };
      return ids;
    })
    .finally(() => { activeTenantIdsRequest = null; });
  return activeTenantIdsRequest;
}

/** Error when engine is asked to initialize without explicit tenant. */
export class EngineTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTenantContextError";
  }
}

/** Error when query returns rows for unexpected tenant. */
export class EngineTenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTenantScopeError";
  }
}

export interface EngineState {
  sites: SiteState[];
  tanks: TankState[];
  generators: GenState[];
  batteries: BattState[];
  iotDevices: IoTDeviceState[];
  dispensers: DispenserState[];
  fuelTransactions: FuelTransactionState[];
  events: EventItem[];
  gateways: GatewayState[];
  regions: Snapshot["regions"];
  openAlarmKeys: Set<string>;
  transientRaisedAt: Map<string, number>;
  tankPtr: Map<string, number>;
  lastGenRuntimeHours: Map<string, number>;
  loadedTenantIds: string[];
  loadedKey: string;
  initialized: boolean;
  initializing: Promise<void> | null;
  initializingKey: string | null;
  now: number;
  tickCount: number;
  startedAt: number;
}

export class EngineCore {
  private state: EngineState = {
    sites: [], tanks: [], generators: [], batteries: [], iotDevices: [],
    dispensers: [], fuelTransactions: [], events: [], gateways: [], regions: [],
    openAlarmKeys: new Set(), transientRaisedAt: new Map(), tankPtr: new Map(),
    lastGenRuntimeHours: new Map(), loadedTenantIds: [], loadedKey: "",
    initialized: false, initializing: null, initializingKey: null,
    now: Date.now(), tickCount: 0, startedAt: Date.now(),
  };

  /** Get current state (read-only for services). */
  getState(): Readonly<EngineState> {
    return this.state;
  }

  /** Get mutable state for simulation service. */
  getMutableState(): EngineState {
    return this.state;
  }

  /** Which tenants are currently loaded. */
  loadedTenants(): readonly string[] {
    return this.state.loadedTenantIds;
  }

  /** True if engine has been initialized. */
  isLoaded(): boolean {
    return this.state.initialized;
  }

  /** Current timestamp (updated each tick). */
  getNow(): number {
    return this.state.now;
  }

  /** Set current timestamp (called by tick). */
  setNow(now: number): void {
    this.state.now = now;
  }

  /** Increment tick counter. */
  incrementTick(): number {
    return ++this.state.tickCount;
  }

  /** Get tick count. */
  getTickCount(): number {
    return this.state.tickCount;
  }

  /** Initialize engine for EXPLICITLY NAMED tenants. */
  async ensureInit(tenants: readonly string[]): Promise<void> {
    if (!tenants || tenants.length === 0) {
      throw new EngineTenantContextError(
        "EngineCore.ensureInit() requires an explicit tenantId list. " +
        "Use ensureAllTenants() if you genuinely want all tenants.",
      );
    }
    const wanted = [...new Set(tenants)];
    const key = wanted.slice().sort().join(",");
    if (this.state.initialized && this.state.loadedKey === key) return;
    if (this.state.initializing && this.state.initializingKey === key) return this.state.initializing;
    this.state.initializingKey = key;
    this.state.initializing = this.init(wanted).finally(() => {
      this.state.initializing = null;
      this.state.initializingKey = null;
    });
    return this.state.initializing;
  }

  /** Load EVERY active tenant. Bootstrap and scheduler use only. */
  async ensureAllTenants(): Promise<void> {
    const all = await resolveActiveTenantIds();
    if (all.length === 0) {
      throw new EngineTenantContextError(
        "ensureAllTenants() found no tenants at all. Either the database is " +
        "unseeded or the tenant table is unreadable by this role.",
      );
    }
    await this.ensureInit(all);
  }

  private async init(tenants: readonly string[]) {
    this.state.loadedTenantIds = [...tenants];
    this.clearSnapshot();

    for (const tenantId of tenants) {
      await withTenant(tenantId, async (tx) => {
        await this.loadInto(tx, [tenantId], true);
      });
    }

    this.backfillHistory();
    this.state.loadedKey = [...new Set(tenants)].sort().join(",");
    this.state.initialized = true;
  }

  private clearSnapshot() {
    this.state.sites = [];
    this.state.tanks = [];
    this.state.generators = [];
    this.state.batteries = [];
    this.state.iotDevices = [];
    this.state.dispensers = [];
    this.state.fuelTransactions = [];
    this.state.events = [];
    this.state.gateways = [];
    this.state.regions = [];
    this.state.openAlarmKeys = new Set();
    this.state.transientRaisedAt = new Map();
    this.state.tankPtr = new Map();
    this.state.lastGenRuntimeHours = new Map();
  }

  private async loadInto(tx: Prisma.TransactionClient, tenants: readonly string[], _append = false) {
    // Load geo hierarchy from v_geography view (RLS-safe)
    const geoRows = await tx.$queryRawUnsafe<
      Array<{
        regionId: string; regionName: string;
        governorateId: string | null; governorateName: string | null;
        districtId: string | null; districtName: string | null;
      }>
    >(`SELECT "regionId","regionName","governorateId","governorateName","districtId","districtName" FROM v_geography`);

    const regionMap = new Map<string, { id: string; name: string; governorates: Array<{ id: string; name: string; districts: Array<{ id: string; name: string }> }> }>();
    const govMap = new Map<string, { id: string; name: string; districts: Array<{ id: string; name: string }> }>();
    for (const row of geoRows) {
      let region = regionMap.get(row.regionId);
      if (!region) { region = { id: row.regionId, name: row.regionName, governorates: [] }; regionMap.set(row.regionId, region); }
      if (row.governorateId && row.governorateName) {
        let gov = govMap.get(row.governorateId);
        if (!gov) { gov = { id: row.governorateId, name: row.governorateName, districts: [] }; govMap.set(row.governorateId, gov); region.governorates.push(gov); }
        if (row.districtId && row.districtName) gov.districts.push({ id: row.districtId, name: row.districtName });
      }
    }
    this.state.regions.push(...[...regionMap.values()]);

    const regionNameById = new Map([...regionMap].map(([id, r]) => [id, r.name]));
    const govNameById = new Map([...govMap].map(([id, g]) => [id, g.name]));
    const districtNameById = new Map<string, string>();
    for (const g of govMap.values()) for (const d of g.districts) districtNameById.set(d.id, d.name);

    const tenantScope = rlsEnforced ? undefined : { in: [...tenants] };

    const sites = await tx.site.findMany({
      where: tenantScope ? { tenantId: tenantScope } : undefined,
      include: {
        tanks: true, generators: true, batteries: true, iotDevices: true,
        dispensers: { include: { transactions: { orderBy: { startedAt: "desc" }, take: MAX_DISPENSER_TXN_MEMORY } } },
      },
    });

    // Verify tenant scope
    for (const s of sites) {
      if (!tenants.includes(s.tenantId)) {
        throw new EngineTenantScopeError(
          `Engine asked for tenants [${tenants.join(", ")}] but query returned site ${s.id} owned by "${s.tenantId}". ` +
          `RLS did NOT scope this query — process connects as a role that bypasses Row Level Security. ` +
          `Fix: connect as fgmp_app, or run with FGMP_REQUIRE_RLS=0 (LOCAL DEVELOPMENT ONLY).`,
        );
      }
    }

    this.state.sites.push(...sites.map((s) => ({
      id: s.id, tenantId: s.tenantId, code: s.code, name: s.name,
      regionId: s.regionId, region: regionNameById.get(s.regionId) ?? "",
      governorateId: s.governorateId, governorate: govNameById.get(s.governorateId) ?? "",
      districtId: s.districtId, district: districtNameById.get(s.districtId) ?? "",
      latitude: s.latitude, longitude: s.longitude, address: s.address,
      status: s.status, criticality: s.criticality, loadKw: s.loadKw,
      powerSource: s.powerSource, gridAvailable: s.gridAvailable,
    })));

    this.state.tanks.push(...sites.flatMap((s) => s.tanks.map((t) => ({
      id: t.id, siteId: t.siteId, label: t.label, fuelType: t.fuelType,
      capacity: toNum(t.capacityLitres, { scale: 3 }),
      current: toNum(t.currentLitres, { scale: 3 }),
      low: toNum(t.lowThreshold, { scale: 3 }),
      critical: toNum(t.criticalThreshold, { scale: 3 }),
      status: t.status, lastReadingAt: t.lastReadingAt?.getTime() ?? Date.now(),
      history: [], prevLevel: toNum(t.currentLitres, { scale: 3 }),
    }))));

    this.state.generators.push(...sites.flatMap((s) => s.generators.map((g) => ({
      id: g.id, siteId: g.siteId, label: g.label, manufacturer: g.manufacturer,
      model: g.model, ratedPowerKw: g.ratedPowerKw, status: g.status as GenStatus,
      mode: g.mode as GenState["mode"], runtimeHours: g.runtimeHours,
      temperatureC: g.temperatureC, oilPressureKpa: g.oilPressureKpa,
      loadKw: g.loadKw, fuelRateLph: g.fuelRateLph, batteryVoltage: g.batteryVoltage,
      oilChangeIntervalHrs: g.oilChangeIntervalHrs, lastOilChangeHrs: g.lastOilChangeHrs,
      nextMaintenanceHrs: g.nextMaintenanceHrs,
      lastStartedAt: g.lastStartedAt?.getTime(), lastStoppedAt: g.lastStoppedAt?.getTime(),
      lastReadingAt: g.lastReadingAt?.getTime() ?? Date.now(), history: [],
    }))));

    this.state.batteries.push(...sites.flatMap((s) => s.batteries.map((b) => ({
      id: b.id, siteId: b.siteId, label: b.label, chemistry: b.chemistry,
      capacityAh: b.capacityAh, nominalVoltage: b.nominalVoltage,
      voltage: b.voltage, currentA: b.currentA, stateOfCharge: b.stateOfCharge,
      stateOfHealth: b.stateOfHealth, temperatureC: b.temperatureC,
      charging: b.charging, status: b.status,
      installedAt: b.installedAt.getTime(), lastReadingAt: b.lastReadingAt?.getTime() ?? Date.now(),
      history: [],
    }))));

    this.state.iotDevices.push(...sites.flatMap((s) => s.iotDevices.map((d) => ({
      id: d.id, siteId: d.siteId, name: d.name, type: d.type, protocol: d.protocol,
      vendor: d.vendor, serialNo: d.serialNo, firmware: d.firmware,
      ipAddress: d.ipAddress ?? undefined, modbusUnit: d.modbusUnit ?? undefined,
      status: d.status, lastSeenAt: d.lastSeenAt?.getTime() ?? Date.now(),
      signalRssi: d.signalRssi, otaTargetFw: d.otaTargetFw ?? undefined,
      otaStatus: d.otaStatus ?? undefined,
    }))));

    this.state.dispensers.push(...sites.flatMap((s) => s.dispensers.map((d) => ({
      id: d.id, siteId: d.siteId, label: d.label, manufacturer: d.manufacturer,
      model: d.model, nozzleCount: d.nozzleCount, fuelType: d.fuelType,
      maxFlowLpm: d.maxFlowLpm, status: d.status as DispenserState["status"],
      mode: d.mode as DispenserState["mode"],
      espDeviceId: d.espDeviceId, espFirmware: d.espFirmware,
      rs485Baudrate: d.rs485Baudrate, rs485Address: d.rs485Address,
      rs485Parity: d.rs485Parity, wifiRssi: d.wifiRssi,
      ipAddress: d.ipAddress ?? undefined, macAddress: d.macAddress ?? undefined,
      lastCommAt: d.lastCommAt?.getTime() ?? Date.now(),
      currentVolumeLitres: toNum(d.currentVolumeLitres, { scale: 3 }),
      presetVolumeLitres: d.presetVolumeLitres === null ? undefined : toNum(d.presetVolumeLitres, { scale: 3 }),
      flowRateLpm: toNum(d.flowRateLpm, { scale: 3 }),
      totalizerLitres: toNum(d.totalizerLitres, { scale: 3 }),
      currentTransactionId: d.currentTransactionId ?? undefined,
      lastTransactionAt: d.lastTransactionAt?.getTime(),
      tempC: d.tempC, history: [],
    }))));

    this.state.fuelTransactions.push(
      ...sites.flatMap((s) => s.dispensers.flatMap((d) => d.transactions.map((tx) => ({
        id: tx.id, dispenserId: tx.dispenserId, siteId: tx.siteId,
        nozzle: tx.nozzle, volumeLitres: toNum(tx.volumeLitres, { scale: 3 }),
        amountYer: tx.amountYer, unitPriceYer: tx.unitPriceYer,
        vehiclePlate: tx.vehiclePlate ?? undefined, operatorName: tx.operatorName ?? undefined,
        status: tx.status as FuelTransactionState["status"],
        startedAt: tx.startedAt.getTime(), completedAt: tx.completedAt?.getTime(),
        durationSec: tx.durationSec, totalizerLitres: tx.totalizerLitres ?? undefined,
      }))).sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT_TXN_SNAPSHOT)
    ));

    // Load gateways
    const gatewayRows = await tx.siteGateway.findMany({
      where: tenantScope ? { tenantId: tenantScope } : undefined,
      include: { site: { select: { id: true, name: true, code: true } } },
    });
    this.state.gateways.push(...gatewayRows.map((g) => ({
      id: g.id, siteId: g.siteId, hostname: g.hostname, model: g.model ?? undefined,
      ipAddress: g.ipAddress ?? undefined, status: g.status as GatewayState["status"],
      uptimeSec: g.uptimeSec, cpuTempC: g.cpuTempC, heapKb: g.heapKb,
      wifiRssi: g.wifiRssi, lastSeenAt: g.lastSeenAt.getTime(),
    })));

    // Load open alarm keys for dedup
    const openAlarms = await tx.alarm.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] }, ...(tenantScope ? { tenantId: tenantScope } : {}) },
      select: { type: true, entityId: true, severity: true },
    });
    for (const a of openAlarms) {
      this.state.openAlarmKeys.add(`${a.type}:${a.severity}:${a.entityId ?? "site"}`);
    }
  }

  private backfillHistory() {
    const rnd = mulberry32(99173);
    const stepMs = 5 * 60 * 1000;
    const start = this.state.now - HISTORY_POINTS * stepMs;

    for (const tk of this.state.tanks) {
      for (let i = 0; i < HISTORY_POINTS; i++) {
        const t = start + i * stepMs;
        const elapsed = 1 - i / (HISTORY_POINTS - 1);
        const drawdown = elapsed * (tk.capacity * 0.15);
        const noise = (rnd() - 0.5) * tk.capacity * 0.02;
        const l = Math.max(tk.critical * 0.3, Math.min(tk.capacity, tk.current + drawdown + noise));
        tk.history.push({ t, l: Math.round(l) });
      }
    }
    for (const g of this.state.generators) {
      const runningBase = g.status === "RUNNING";
      for (let i = 0; i < HISTORY_POINTS; i++) {
        const t = start + i * stepMs;
        const running = runningBase && rnd() > 0.12;
        const temp = running ? 72 + rnd() * 18 : 28 + rnd() * 8;
        const load = running ? g.ratedPowerKw * (0.3 + rnd() * 0.45) : 0;
        const rate = running ? 3 + rnd() * 14 : 0;
        const runtime = Math.max(0, g.runtimeHours - (HISTORY_POINTS - i) * (5 / 60) * (running ? 1 : 0));
        g.history.push({ t, temp: Math.round(temp), load: Math.round(load * 10) / 10, runtime: Math.round(runtime * 10) / 10, rate: Math.round(rate * 10) / 10 });
      }
    }
    for (const b of this.state.batteries) {
      for (let i = 0; i < HISTORY_POINTS; i++) {
        const t = start + i * stepMs;
        const charging = rnd() > 0.45;
        const v = charging ? b.nominalVoltage * (1.0 + rnd() * 0.05) : b.nominalVoltage * (0.88 + rnd() * 0.08);
        const soc = Math.max(20, Math.min(100, b.stateOfCharge + (rnd() - 0.5) * 20));
        b.history.push({ t, v: Math.round(v * 100) / 100, soc: Math.round(soc) });
      }
    }
  }

  /** Generate snapshot for a specific tenant (or all if null). */
  async snapshotForTenant(tenantId: string | null = null): Promise<Snapshot> {
    if (tenantId) {
      await this.ensureInit([tenantId]);
    } else {
      await this.ensureAllTenants();
    }

    const sites = tenantId ? this.state.sites.filter((s) => s.tenantId === tenantId) : this.state.sites;
    const siteIds = new Set(sites.map((s) => s.id));

    const tanks = tenantId ? this.state.tanks.filter((t) => siteIds.has(t.siteId)) : this.state.tanks;
    const generators = tenantId ? this.state.generators.filter((g) => siteIds.has(g.siteId)) : this.state.generators;
    const batteries = tenantId ? this.state.batteries.filter((b) => siteIds.has(b.siteId)) : this.state.batteries;
    const dispensers = tenantId ? this.state.dispensers.filter((d) => siteIds.has(d.siteId)) : this.state.dispensers;
    const iotDevices = tenantId ? this.state.iotDevices.filter((d) => siteIds.has(d.siteId)) : this.state.iotDevices;
    const fuelTransactions = tenantId ? this.state.fuelTransactions.filter((t) => siteIds.has(t.siteId)) : this.state.fuelTransactions;
    const events = tenantId ? this.state.events.filter((e) => {
      const sid = (e as { siteId?: string }).siteId;
      return typeof sid === "string" && siteIds.has(sid);
    }) : this.state.events;
    const gateways = tenantId ? this.state.gateways.filter((g) => siteIds.has(g.siteId)) : this.state.gateways;
    const regions = this.state.regions;

    // KPI counts in single query
    interface SnapshotCountRow {
      openAlarms: number; alarmsL1: number; alarmsL2: number; alarmsL3: number;
      pendingDeliveries: number; openTickets: number;
    }
    const readCounts = async (client: Pick<Prisma.TransactionClient, "$queryRaw">): Promise<SnapshotCountRow> => {
      const rows = await client.$queryRaw<SnapshotCountRow[]>`
        SELECT
          (SELECT COUNT(*)::int FROM "Alarm" WHERE "status" IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED')) AS "openAlarms",
          (SELECT COUNT(*)::int FROM "Alarm" WHERE "status" IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED') AND "severity" = 'L1') AS "alarmsL1",
          (SELECT COUNT(*)::int FROM "Alarm" WHERE "status" IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED') AND "severity" = 'L2') AS "alarmsL2",
          (SELECT COUNT(*)::int FROM "Alarm" WHERE "status" IN ('OPEN', 'ACKNOWLEDGED', 'ESCALATED') AND "severity" = 'L3') AS "alarmsL3",
          (SELECT COUNT(*)::int FROM "FuelDelivery" WHERE "status" IN ('SCHEDULED', 'IN_TRANSIT')) AS "pendingDeliveries",
          (SELECT COUNT(*)::int FROM "MaintenanceTicket" WHERE "status" IN ('OPEN', 'SCHEDULED', 'IN_PROGRESS')) AS "openTickets"
      `;
      return rows[0]!;
    };
    let counts: SnapshotCountRow;
    if (tenantId) counts = await withTenant(tenantId, readCounts);
    else {
      const ops = getOpsDb();
      if (!ops) throw new Error("Platform-wide snapshot requires FGMP_OPS_DATABASE_URL");
      counts = await readCounts(ops);
    }

    const totalFuelLitres = tanks.reduce((a, t) => a + t.current, 0);
    const totalFuelCapacity = tanks.reduce((a, t) => a + t.capacity, 0);
    const tanksCritical = tanks.filter((t) => t.current <= t.critical).length;
    const tanksLow = tanks.filter((t) => t.current <= t.low && t.current > t.critical).length;
    const generatorsRunning = generators.filter((g) => g.status === "RUNNING").length;
    const generatorsFault = generators.filter((g) => g.status === "FAULT").length;
    const batteriesLow = batteries.filter((b) => b.status === "LOW" || isBatteryLowVoltage(b.voltage, b.nominalVoltage)).length;
    const onlineSites = sites.filter((s) => s.status === "ONLINE").length;
    const degradedSites = sites.filter((s) => s.status === "DEGRADED").length;
    const offlineSites = sites.filter((s) => s.status === "OFFLINE").length;
    const siteHealth = sites.length ? Math.round((onlineSites * 1 + degradedSites * 0.5) / sites.length * 100) : 100;

    const fuelConsumedTodayL = tanks.reduce((sum, t) => {
      if (t.history.length < 2) return sum;
      const first = t.history[0].l; const last = t.history[t.history.length - 1].l;
      return sum + Math.max(0, first - last);
    }, 0);
    const generatorHoursToday = generators.reduce((sum, g) => {
      const runningPts = g.history.filter((h) => h.rate > 0).length;
      return sum + (runningPts * 5) / 60;
    }, 0);

    const dispensersTotal = dispensers.length;
    const dispensersDispensing = dispensers.filter((d) => d.status === "DISPENSING").length;
    const dispensersFault = dispensers.filter((d) => d.status === "FAULT").length;

    const todayMs = startOfZonedDay(this.state.now, await resolvePlatformTimezone(tenantId));
    const txnsToday = fuelTransactions.filter((t) => t.startedAt >= todayMs);
    const dispenserTransactionsToday = txnsToday.length;
    const dispenserVolumeTodayL = Math.round(txnsToday.filter((t) => t.status === "COMPLETED").reduce((a, t) => a + t.volumeLitres, 0));

    const kpis: Kpis = {
      totalSites: sites.length, onlineSites, degradedSites, offlineSites,
      totalTanks: tanks.length, totalFuelLitres: Math.round(totalFuelLitres),
      totalFuelCapacity: Math.round(totalFuelCapacity),
      fuelPct: totalFuelCapacity ? Math.round((totalFuelLitres / totalFuelCapacity) * 1000) / 10 : 0,
      tanksCritical, tanksLow,
      generatorsRunning, generatorsTotal: generators.length, generatorsFault,
      batteriesLow,
      openAlarms: counts.openAlarms, alarmsL1: counts.alarmsL1, alarmsL2: counts.alarmsL2, alarmsL3: counts.alarmsL3,
      pendingDeliveries: counts.pendingDeliveries, openTickets: counts.openTickets,
      avgSiteHealth: siteHealth,
      fuelConsumedTodayL: Math.round(fuelConsumedTodayL),
      generatorHoursToday: Math.round(generatorHoursToday * 10) / 10,
      dispensersTotal, dispensersDispensing, dispensersFault,
      dispenserTransactionsToday, dispenserVolumeTodayL,
    };

    return {
      now: this.state.now, tickCount: this.state.tickCount, kpis,
      sites, tanks: tanks.map(stripHistory), generators: generators.map(stripHistory),
      batteries: batteries.map(stripHistory), iotDevices,
      dispensers: dispensers.map(stripHistory),
      fuelTransactions: fuelTransactions.slice(0, MAX_RECENT_TXN_SNAPSHOT),
      events, gateways, regions,
    };
  }

  /** Global cross-tenant snapshot (for realtime service / super-admin). */
  async snapshot(): Promise<Snapshot> {
    return this.snapshotForTenant(null);
  }

  /** Minimal site directory for IoT bridge tenant-key routing. */
  async bridgeSiteDirectory(): Promise<Array<{ id: string; tenantId: string }>> {
    const now = Date.now();
    // Cache with 30s TTL
    if (this._bridgeCache && this._bridgeCache.expiresAt > now) {
      return this._bridgeCache.sites.map((s) => ({ ...s }));
    }
    const tenantIds = await resolveActiveTenantIds();
    if (tenantIds.length === 0) throw new EngineTenantContextError("No tenants found for bridge directory");
    const sites: Array<{ id: string; tenantId: string }> = [];
    for (const tid of tenantIds) {
      const tenantSites = await withTenant(tid, (tx) =>
        tx.site.findMany({ where: { tenantId: tid }, select: { id: true, tenantId: true }, orderBy: { id: "asc" } }),
      );
      sites.push(...tenantSites);
    }
    sites.sort((a, b) => a.id.localeCompare(b.id));
    this._bridgeCache = { expiresAt: Date.now() + 30_000, sites };
    return sites.map((s) => ({ ...s }));
  }
  private _bridgeCache: { expiresAt: number; sites: Array<{ id: string; tenantId: string }> } | null = null;

  /** Force reload (used after mutations). */
  async reload(): Promise<void> {
    const scope = this.state.loadedTenantIds.slice();
    this.state.initialized = false;
    this.state.initializing = null;
    this.state.loadedKey = "";
    if (scope.length === 0) await this.ensureInit(this.resolveTenantsFor());
    else await this.ensureInit(scope);
  }

  private resolveTenantsFor(): readonly string[] {
    // This would be called from a request context with a known tenant
    return this.state.loadedTenantIds.length > 0 ? this.state.loadedTenantIds : [];
  }
}

function stripHistory<T extends { history?: unknown[] }>(x: T): T {
  const { history, ...rest } = x as Record<string, unknown>;
  void history;
  return rest as T;
}

// Singleton
const globalForCore = globalThis as unknown as { __fgmpCore?: EngineCore };
export const engineCore: EngineCore = globalForCore.__fgmpCore ?? new EngineCore();
if (process.env.NODE_ENV !== "production") globalForCore.__fgmpCore = engineCore;