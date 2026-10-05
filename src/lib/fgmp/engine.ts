import { Prisma, type FuelType } from "@prisma/client";
import { db } from "@/lib/db";
import { toJsonNumber } from "./decimal";
import type {
  TankState, GenState, BattState, SiteState, IoTDeviceState,
  DispenserState, FuelTransactionState, GatewayState,
  EventItem, Kpis, Snapshot, GenCommand, GenStatus,
  AlarmType, Severity,
} from "./types";
import { isAlarmSuppressed } from "./suppression-check";
import { isBatteryLowVoltage, battLowVoltageTripVolts } from "./thresholds-battery";
import {
  startOfZonedDay,
  resolvePlatformTimezone,
} from "./thresholds-time";
import { Rng, streamsFor, DEFAULT_SIM_SEED } from "./prng";
import { assertSimulationAllowed } from "./simulation";

// ── Deterministic PRNG for stable backfill ─────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HISTORY_POINTS = 288; // 24h @ 5-min simulated cadence
const MAX_EVENTS = 400;
const MAX_DISPENSER_TXN_MEMORY = 50;     // keep last 50 txns per dispenser in memory
const MAX_RECENT_TXN_SNAPSHOT = 200;     // last 200 txns in the snapshot feed
const DISPENSER_FAULT_PROB = 0.005;      // 0.5% per tick chance of a FAULT

// Point-in-time alarm types: they describe an event, not a persistent
// condition, so they have no "cleared" state. They are re-armed after
// TRANSIENT_REARM_MS instead of being resolved on the next tick — see
// `reconcileAlarms()`.
const TRANSIENT_ALARM_TYPES = new Set(["FUEL_THEFT", "FUEL_REFILL"]);
const TRANSIENT_REARM_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Split `${type}:${severity}:${entityId}` into its parts.
 *
 * Entity ids are cuid-like (`c…`) or the seeded `u-…`/`tank-…`/`gen-…` forms
 * and never contain `:`, so the first separator delimits the type and the
 * second the severity.
 */
/**
 * Split a `${type}:${severity}:${entityId}` alarm key back into its parts.
 *
 * Returns the type/severity as the narrowed unions rather than plain strings:
 * the key is only ever built by `raiseAlarm` from validated enum members, so
 * the values flowing back out here are always valid members too. Typing them
 * keeps the `db.alarm.where` filters type-checked against the Prisma enum.
 */
function splitAlarmKey(key: string): [AlarmType, Severity | "", string] {
  const firstSep = key.indexOf(":");
  const secondSep = key.indexOf(":", firstSep + 1);
  if (firstSep < 0) return [key as AlarmType, "", ""];
  if (secondSep < 0) {
    return [key.slice(0, firstSep) as AlarmType, "", key.slice(firstSep + 1)];
  }
  return [
    key.slice(0, firstSep) as AlarmType,
    key.slice(firstSep + 1, secondSep) as Severity,
    key.slice(secondSep + 1),
  ];
}
const DISPENSER_COMM_STALE_MS = 90 * 1000; // > 90s since lastCommAt → OFFLINE
const UNIT_PRICE_YER_PER_L = 520;        // Yemeni Rial per litre (diesel, ~2024)

/**
 * Module-level stream for `uid()`.
 *
 * Seeded from the same default as the engine's streams so ids are stable
 * across a dev restart for a given seed, instead of changing every reload the
 * way Math.random() did.
 */
const uidStream = new Rng(DEFAULT_SIM_SEED ^ 0x9999);

function uid(prefix: string) {
  return `${prefix}-${uidStream.suffix()}`;
}

/**
 * GEN_OFFLINE condition (Phase 0.6).
 *
 * A generator counts as offline only when it is STOPPED *and* its site
 * genuinely depends on generator power. A stopped generator on a grid-powered
 * site is correctly parked, not failed, and must not alarm.
 *
 * Both the raise path in tick() and the reconcile loop call this so the two
 * can never drift apart again — drift is what caused the alarm to be
 * auto-resolved on the tick after it was raised.
 */
function isGeneratorOffline(g: GenState, sites: SiteState[]): boolean {
  if (g.status !== "STOPPED") return false;
  const site = sites.find((s) => s.id === g.siteId);
  if (!site) return false;
  return !site.gridAvailable && site.powerSource === "GENERATOR";
}

class FgmpEngine {
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private now = Date.now();
  private tickCount = 0;
  private startedAt = Date.now();

  /**
   * Seeded random streams for the simulation (Phase 2).
   *
   * One stream per subsystem, not a single shared sequence: if generators and
   * tanks shared one, changing how often a generator event fires would shift
   * every later tank value, and a change to one subsystem would silently
   * rewrite another subsystem's behaviour.
   *
   * Re-seeded from the configured seed on construction and by
   * `resetSimulation()`, so a demo replays identically. Never `Math.random()`.
   */
  private rng: Record<string, Rng> = streamsFor(DEFAULT_SIM_SEED);
  /** Seed the current streams were built from, to detect a config change. */
  private rngSeedApplied: number | null = null;

  sites: SiteState[] = [];
  tanks: TankState[] = [];
  generators: GenState[] = [];
  batteries: BattState[] = [];
  iotDevices: IoTDeviceState[] = [];
  dispensers: DispenserState[] = [];
  fuelTransactions: FuelTransactionState[] = [];
  events: EventItem[] = [];
  // Task 48 — site-level ESP32/RS485 edge gateway live state. Loaded in init()
  // from db.siteGateway; tick updates apply small random fluctuations. The
  // GET /api/fgmp/edge/gateways route merges these live values over the DB row.
  gateways: GatewayState[] = [];

  regions: Snapshot["regions"] = [];
  tenantId = "t-default";

  // Dedup of open alarms in DB, keyed by `${type}:${severity}:${entityId}`.
  //
  // `severity` is part of the key because GEN_OVERHEAT is raised at two
  // different severities for the same generator (L2 at >95°C, L3 at >104°C).
  // The old `${type}:${entityId}` key collided, so the L3 raise returned
  // early and a CRITICAL over-temperature was never created — operators only
  // ever saw the L2 warning.
  private openAlarmKeys = new Set<string>();
  // First-seen time for point-in-time alarms, used to re-arm them.
  private transientRaisedAt = new Map<string, number>();
  // Escalation step thresholds (minutes). Read from settings where possible;
  // these defaults match .fgmp-settings.json.
  private escalationThresholds = { l1ToL2Minutes: 15, l2ToL3Minutes: 30 };
  // site -> tank index pointer for consumption round-robin
  private tankPtr = new Map<string, number>();

  async ensureInit() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.init();
    return this.initializing;
  }

  private async init() {
    // Load geo hierarchy
    const regions = await db.region.findMany({
      include: { governorates: { include: { districts: true } } },
      orderBy: { name: "asc" },
    });
    this.regions = regions.map((r) => ({
      id: r.id,
      name: r.name,
      governorates: r.governorates.map((g) => ({
        id: g.id,
        name: g.name,
        districts: g.districts.map((d) => ({ id: d.id, name: d.name })),
      })),
    }));

    const sites = await db.site.findMany({
      include: {
        region: true, governorate: true, district: true,
        tanks: true, generators: true, batteries: true, iotDevices: true,
        dispensers: { include: { transactions: { orderBy: { startedAt: "desc" }, take: MAX_DISPENSER_TXN_MEMORY } } },
      },
    });
    this.tenantId = sites[0]?.tenantId ?? "t-default";

    this.sites = sites.map((s) => ({
      id: s.id, tenantId: s.tenantId, code: s.code, name: s.name,
      regionId: s.regionId, region: s.region.name,
      governorateId: s.governorateId, governorate: s.governorate.name,
      districtId: s.districtId, district: s.district.name,
      latitude: s.latitude, longitude: s.longitude, address: s.address,
      status: s.status, criticality: s.criticality, loadKw: s.loadKw,
      powerSource: s.powerSource, gridAvailable: s.gridAvailable,
    }));

    this.tanks = sites.flatMap((s) => s.tanks.map((t) => ({
      id: t.id, siteId: t.siteId, label: t.label, fuelType: t.fuelType,
      capacity: t.capacityLitres, current: t.currentLitres,
      low: t.lowThreshold, critical: t.criticalThreshold, status: t.status,
      lastReadingAt: t.lastReadingAt?.getTime() ?? Date.now(),
      history: [], prevLevel: t.currentLitres,
    })));

    this.generators = sites.flatMap((s) => s.generators.map((g) => ({
      id: g.id, siteId: g.siteId, label: g.label, manufacturer: g.manufacturer,
      model: g.model, ratedPowerKw: g.ratedPowerKw, status: g.status as GenStatus,
      mode: g.mode as GenState["mode"], runtimeHours: g.runtimeHours,
      temperatureC: g.temperatureC, oilPressureKpa: g.oilPressureKpa,
      loadKw: g.loadKw, fuelRateLph: g.fuelRateLph, batteryVoltage: g.batteryVoltage,
      oilChangeIntervalHrs: g.oilChangeIntervalHrs, lastOilChangeHrs: g.lastOilChangeHrs,
      nextMaintenanceHrs: g.nextMaintenanceHrs,
      lastStartedAt: g.lastStartedAt?.getTime(), lastStoppedAt: g.lastStoppedAt?.getTime(),
      lastReadingAt: g.lastReadingAt?.getTime() ?? Date.now(), history: [],
    })));

    this.batteries = sites.flatMap((s) => s.batteries.map((b) => ({
      id: b.id, siteId: b.siteId, label: b.label, chemistry: b.chemistry,
      capacityAh: b.capacityAh, nominalVoltage: b.nominalVoltage,
      voltage: b.voltage, currentA: b.currentA, stateOfCharge: b.stateOfCharge,
      stateOfHealth: b.stateOfHealth, temperatureC: b.temperatureC,
      charging: b.charging, status: b.status,
      installedAt: b.installedAt.getTime(), lastReadingAt: b.lastReadingAt?.getTime() ?? Date.now(),
      history: [],
    })));

    this.iotDevices = sites.flatMap((s) => s.iotDevices.map((d) => ({
      id: d.id, siteId: d.siteId, name: d.name, type: d.type, protocol: d.protocol,
      vendor: d.vendor, serialNo: d.serialNo, firmware: d.firmware,
      ipAddress: d.ipAddress ?? undefined, modbusUnit: d.modbusUnit ?? undefined,
      status: d.status, lastSeenAt: d.lastSeenAt?.getTime() ?? Date.now(),
      signalRssi: d.signalRssi, otaTargetFw: d.otaTargetFw ?? undefined,
      otaStatus: d.otaStatus ?? undefined,
    })));

    this.dispensers = sites.flatMap((s) => s.dispensers.map((d) => ({
      id: d.id, siteId: d.siteId, label: d.label, manufacturer: d.manufacturer,
      model: d.model, nozzleCount: d.nozzleCount, fuelType: d.fuelType,
      maxFlowLpm: d.maxFlowLpm,
      status: d.status as DispenserState["status"],
      mode: d.mode as DispenserState["mode"],
      espDeviceId: d.espDeviceId, espFirmware: d.espFirmware,
      rs485Baudrate: d.rs485Baudrate, rs485Address: d.rs485Address,
      rs485Parity: d.rs485Parity, wifiRssi: d.wifiRssi,
      ipAddress: d.ipAddress ?? undefined,
      lastCommAt: d.lastCommAt?.getTime() ?? Date.now(),
      currentVolumeLitres: d.currentVolumeLitres,
      presetVolumeLitres: d.presetVolumeLitres ?? undefined,
      flowRateLpm: d.flowRateLpm, totalizerLitres: d.totalizerLitres,
      currentTransactionId: d.currentTransactionId ?? undefined,
      lastTransactionAt: d.lastTransactionAt?.getTime(),
      tempC: d.tempC, history: [],
    })));

    this.fuelTransactions = sites.flatMap((s) =>
      s.dispensers.flatMap((d) =>
        d.transactions.map((tx) => ({
          id: tx.id, dispenserId: tx.dispenserId, siteId: tx.siteId,
          nozzle: tx.nozzle, volumeLitres: tx.volumeLitres, amountYer: tx.amountYer,
          unitPriceYer: tx.unitPriceYer, vehiclePlate: tx.vehiclePlate ?? undefined,
          operatorName: tx.operatorName ?? undefined,
          status: tx.status as FuelTransactionState["status"],
          startedAt: tx.startedAt.getTime(),
          completedAt: tx.completedAt?.getTime(),
          durationSec: tx.durationSec,
        })),
      ),
    ).sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT_TXN_SNAPSHOT);

    // Task 48 — load all site gateways (with site relation for the dashboard's
    // site badge). The gateway tick loop in tick() simulates small live
    // fluctuations on top of these persisted values.
    const gatewayRows = await db.siteGateway.findMany({
      include: { site: { select: { id: true, name: true, code: true } } },
    });
    this.gateways = gatewayRows.map((g) => ({
      id: g.id,
      siteId: g.siteId,
      hostname: g.hostname,
      model: g.model ?? undefined,
      ipAddress: g.ipAddress ?? undefined,
      status: g.status as GatewayState["status"],
      uptimeSec: g.uptimeSec,
      cpuTempC: g.cpuTempC,
      heapKb: g.heapKb,
      wifiRssi: g.wifiRssi,
      lastSeenAt: g.lastSeenAt.getTime(),
    }));

    // Load existing open alarm keys for dedup. The key shape must match
    // `raiseAlarm`/`autoResolve` exactly, so severity is part of it.
    const openAlarms = await db.alarm.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } },
      select: { type: true, entityId: true, severity: true },
    });
    this.openAlarmKeys = new Set(
      openAlarms.map(
        (a) => `${a.type}:${a.severity}:${a.entityId ?? "site"}`,
      ),
    );

    this.backfillHistory();
    this.initialized = true;
  }

  // ── Backfill 24h synthetic history so charts render immediately ──────────
  private backfillHistory() {
    const rnd = mulberry32(99173);
    const stepMs = 5 * 60 * 1000;
    const start = this.now - HISTORY_POINTS * stepMs;
    for (const tk of this.tanks) {
      for (let i = 0; i < HISTORY_POINTS; i++) {
        const t = start + i * stepMs;
        // Gentle DOWNWARD drift with noise.
        //
        // This used to ADD `(i / HISTORY_POINTS) * capacity * 0.15`, so the
        // synthetic 24h history ROSE by 15% of capacity. Regression then fit
        // a positive slope to it and reported every tank as "refilling",
        // zero consumption and LOW risk on cold start — a tank about to run
        // dry read as healthy.
        //
        // `i` runs oldest → newest. The tank was FULLER 24h ago and reaches
        // its true current level at i = HISTORY_POINTS - 1 (i.e. at `now`),
        // so the series declines by 15% of capacity across the window.
        const elapsed = 1 - i / (HISTORY_POINTS - 1);
        const drawdown = elapsed * (tk.capacity * 0.15);
        const noise = (rnd() - 0.5) * tk.capacity * 0.02;
        const l = Math.max(
          tk.critical * 0.3,
          Math.min(tk.capacity, tk.current + drawdown + noise),
        );
        tk.history.push({ t, l: Math.round(l) });
      }
    }
    for (const g of this.generators) {
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
    for (const b of this.batteries) {
      for (let i = 0; i < HISTORY_POINTS; i++) {
        const t = start + i * stepMs;
        const charging = rnd() > 0.45;
        const v = charging ? b.nominalVoltage * (1.0 + rnd() * 0.05) : b.nominalVoltage * (0.88 + rnd() * 0.08);
        const soc = Math.max(20, Math.min(100, b.stateOfCharge + (rnd() - 0.5) * 20));
        b.history.push({ t, v: Math.round(v * 100) / 100, soc: Math.round(soc) });
      }
    }
  }

  // ── Advance simulation ───────────────────────────────────────────────────
  //
  // FABRICATES STATE. Every value below is invented, not measured. Real
  // telemetry arrives via POST /api/fgmp/iot/ingest and is persisted; this
  // method only ever adds plausible-looking data on top.
  //
  // Guarded at the ENGINE, not just at the route (Phase 2). A route guard
  // protects the HTTP surface; this guard protects every caller — including
  // the ones that are not HTTP, and the ones added later. Two independent
  // conditions must both hold: not production, and explicitly opted in.
  async tick(seconds: number): Promise<{ tickCount: number; eventsCreated: number; alarmsCreated: number }> {
    const { seed } = assertSimulationAllowed("engine.tick()");
    // Honour the configured seed on first use so a demo is reproducible from
    // the very first tick, not only after a manual reset.
    if (this.rngSeedApplied !== seed) {
      this.rng = streamsFor(seed);
      this.rngSeedApplied = seed;
    }
    await this.ensureInit();
    const tickHours = seconds / 3600;
    const prevNow = this.now;
    this.now = Date.now();
    this.tickCount++;

    let eventsCreated = 0;
    let alarmsCreated = 0;

    // ── IoT devices: occasional offline flutter ───────────────────────────
    for (const d of this.iotDevices) {
      if (this.rng.site.float() < 0.004) {
        d.status = d.status === "ONLINE" ? "OFFLINE" : "ONLINE";
        d.lastSeenAt = d.status === "ONLINE" ? this.now : d.lastSeenAt;
        if (d.status === "OFFLINE") {
          this.pushEvent(d.siteId, "WARN", `IoT device ${d.name} went offline (${d.protocol})`, { deviceId: d.id });
        }
      } else {
        d.lastSeenAt = this.now;
      }
    }

    // ── Sites: comm loss simulation ──────────────────────────────────────
    for (const s of this.sites) {
      if (s.commLossUntil && this.now > s.commLossUntil) {
        s.commLossUntil = undefined;
        s.status = "ONLINE";
        this.pushEvent(s.id, "INFO", `Communication restored at ${s.name}`, {});
      }
      if (!s.commLossUntil && this.rng.iot.float() < 0.003) {
        const lossMs = (2 + this.rng.site.float() * 8) * 60 * 1000;
        s.commLossUntil = this.now + lossMs;
        s.status = "DEGRADED";
        this.pushEvent(s.id, "WARN", `Communication loss detected at ${s.name}`, { durationMs: lossMs });
        alarmsCreated += await this.raiseAlarm({
          siteId: s.id, type: "COMM_LOSS", severity: "L2", entityKind: "SITE", entityId: s.id,
          message: `Communication loss at ${s.name}`,
        });
      }
      if (s.commLossUntil && this.now <= s.commLossUntil) {
        s.status = "DEGRADED";
      }
    }

    // ── Generators + fuel consumption ────────────────────────────────────
    for (const g of this.generators) {
      const site = this.sites.find((s) => s.id === g.siteId)!;
      const siteCommsDown = !!(site.commLossUntil && this.now <= site.commLossUntil);

      if (g.status === "FAULT") {
        // attempt auto-recovery
        if (g.faultUntil && this.now > g.faultUntil) {
          g.status = "STOPPED";
          g.faultUntil = undefined;
          this.pushEvent(g.siteId, "INFO", `${g.label} fault cleared, returning to STOPPED`, { genId: g.id });
        }
      } else if (g.status !== "MAINTENANCE" && g.status !== "OFFLINE") {
        // Determine desired running state
        const needsPower = !site.gridAvailable || site.powerSource === "GENERATOR";
        const shouldRun = g.mode === "AUTO" ? needsPower : g.status === "RUNNING";

        if (g.status === "STOPPED" && shouldRun && !siteCommsDown) {
          g.status = "RUNNING";
          g.lastStartedAt = this.now;
          this.pushEvent(g.siteId, "CONTROL", `${g.label} started (mode=${g.mode})`, { genId: g.id });
        } else if (g.status === "RUNNING" && !shouldRun && g.mode === "AUTO") {
          g.status = "STOPPED";
          g.lastStoppedAt = this.now;
          this.pushEvent(g.siteId, "CONTROL", `${g.label} stopped (mode=${g.mode})`, { genId: g.id });
        }

        // random fault
        if (g.status === "RUNNING" && this.rng.generator.float() < 0.0015) {
          g.status = "FAULT";
          g.faultUntil = this.now + (5 + this.rng.generator.float() * 15) * 60 * 1000;
          this.pushEvent(g.siteId, "CRITICAL", `${g.label} FAULT detected`, { genId: g.id });
          alarmsCreated += await this.raiseAlarm({
            siteId: g.siteId, type: "GEN_FAILURE", severity: "L3",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} failure at ${site.name}`,
          });
        }
      }

      // Telemetry update
      if (g.status === "RUNNING") {
        const targetTemp = 78 + Math.sin(this.now / 900000) * 6 + (this.rng.site.float() - 0.5) * 4;
        g.temperatureC = Math.round((g.temperatureC + (targetTemp - g.temperatureC) * 0.3) * 10) / 10;
        // overheat fault path
        if (g.temperatureC > 104 && this.rng.generator.float() < 0.4) {
          alarmsCreated += await this.raiseAlarm({
            siteId: g.siteId, type: "GEN_OVERHEAT", severity: "L3",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} overheat: ${g.temperatureC}°C at ${site.name}`,
            value: g.temperatureC, threshold: 104,
          });
        } else if (g.temperatureC > 95) {
          alarmsCreated += await this.raiseAlarm({
            siteId: g.siteId, type: "GEN_OVERHEAT", severity: "L2",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} high temperature: ${g.temperatureC}°C at ${site.name}`,
            value: g.temperatureC, threshold: 95,
          });
        }
        g.runtimeHours = Math.round((g.runtimeHours + tickHours) * 100) / 100;
        g.oilPressureKpa = Math.round(300 + this.rng.generator.float() * 80);
        g.loadKw = Math.round(Math.min(g.ratedPowerKw, site.loadKw * (0.8 + this.rng.generator.float() * 0.4)) * 10) / 10;
        g.fuelRateLph = Math.round((2.5 + (g.loadKw / g.ratedPowerKw) * 16) * 10) / 10;
        g.batteryVoltage = Math.round((24.5 + this.rng.generator.float() * 1.5) * 10) / 10;

        // consume fuel from a tank at this site
        const siteTanks = this.tanks.filter((t) => t.siteId === g.siteId);
        if (siteTanks.length) {
          const ptr = (this.tankPtr.get(g.siteId) ?? 0) % siteTanks.length;
          const tank = siteTanks[ptr];
          const consumed = g.fuelRateLph * tickHours;
          tank.prevLevel = tank.current;
          tank.current = Math.max(0, tank.current - consumed);
          this.tankPtr.set(g.siteId, (ptr + 1) % siteTanks.length);
        }
      } else {
        g.temperatureC = Math.round((g.temperatureC + (32 - g.temperatureC) * 0.2) * 10) / 10;
        g.oilPressureKpa = 0;
        g.loadKw = 0;
        g.fuelRateLph = 0;
        if (g.status === "STOPPED" && site.gridAvailable && site.powerSource !== "GENERATOR") {
          // generator offline but site powered by grid — no alarm
        } else if (isGeneratorOffline(g, this.sites)) {
          // Shares its predicate with reconcileAlarms() — see isGeneratorOffline.
          alarmsCreated += await this.raiseAlarm({
            siteId: g.siteId, type: "GEN_OFFLINE", severity: "L2",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} offline while site requires generator power at ${site.name}`,
          });
        }
      }
      g.lastReadingAt = this.now;
      g.history.push({
        t: this.now, temp: g.temperatureC, load: g.loadKw,
        runtime: g.runtimeHours, rate: g.fuelRateLph,
      });
      if (g.history.length > HISTORY_POINTS) g.history.shift();
    }

    // ── Fuel tanks: theft/refill events + thresholds ─────────────────────
    for (const tk of this.tanks) {
      const site = this.sites.find((s) => s.id === tk.siteId)!;
      // Random theft event (rare)
      if (this.rng.tank.float() < 0.0012 && tk.current > tk.critical * 1.5) {
        const stolen = Math.min(tk.current * (0.1 + this.rng.tank.float() * 0.25), 400);
        tk.prevLevel = tk.current;
        tk.current = Math.max(0, tk.current - stolen);
        this.pushEvent(tk.siteId, "CRITICAL", `Fuel theft detected: -${Math.round(stolen)}L from ${tk.label} at ${site.name}`, { tankId: tk.id, stolen });
        alarmsCreated += await this.raiseAlarm({
          siteId: tk.siteId, type: "FUEL_THEFT", severity: "L3",
          entityKind: "TANK", entityId: tk.id,
          message: `Fuel theft of ${Math.round(stolen)}L at ${site.name} (${tk.label})`,
          value: stolen, threshold: 0,
        });
      }
      // Random unexpected refill (rare) — unauthorized top-up
      if (this.rng.site.float() < 0.0008) {
        const added = 80 + this.rng.site.float() * 300;
        tk.prevLevel = tk.current;
        tk.current = Math.min(tk.capacity, tk.current + added);
        this.pushEvent(tk.siteId, "WARN", `Unexpected fuel increase: +${Math.round(added)}L in ${tk.label} at ${site.name}`, { tankId: tk.id, added });
        alarmsCreated += await this.raiseAlarm({
          siteId: tk.siteId, type: "FUEL_REFILL", severity: "L2",
          entityKind: "TANK", entityId: tk.id,
          message: `Unexpected fuel refill of ${Math.round(added)}L at ${site.name} (${tk.label})`,
          value: added, threshold: 0,
        });
      }
      // Process scheduled deliveries that are due → apply to tank
      await this.applyDueDeliveries(tk, site);

      // Threshold alarms
      if (tk.current <= tk.critical) {
        alarmsCreated += await this.raiseAlarm({
          siteId: tk.siteId, type: "FUEL_CRITICAL", severity: "L3",
          entityKind: "TANK", entityId: tk.id,
          message: `Critical fuel level: ${Math.round(tk.current)}L (${Math.round((tk.current / tk.capacity) * 100)}%) at ${site.name}`,
          value: tk.current, threshold: tk.critical,
        });
      } else if (tk.current <= tk.low) {
        alarmsCreated += await this.raiseAlarm({
          // Phase 0.6: this was raised as L1 while reconcileAlarms() looked for
          // L2, so the `${type}:${severity}:${entityId}` dedup key never matched:
          // every tick re-fired a duplicate alarm and left a permanent OPEN row
          // on any tank sitting between its low and critical thresholds. L2 is
          // also the semantically correct step below FUEL_CRITICAL (L3).
          siteId: tk.siteId, type: "FUEL_LOW", severity: "L2",
          entityKind: "TANK", entityId: tk.id,
          message: `Low fuel level: ${Math.round(tk.current)}L at ${site.name}`,
          value: tk.current, threshold: tk.low,
        });
      } else {
        // auto-resolve if recovered
        await this.autoResolve("FUEL_LOW", tk.id);
        await this.autoResolve("FUEL_CRITICAL", tk.id);
      }

      tk.status = tk.current <= tk.critical ? "EMPTY" : "OPERATIONAL";
      tk.lastReadingAt = this.now;
      tk.history.push({ t: this.now, l: Math.round(tk.current) });
      if (tk.history.length > HISTORY_POINTS) tk.history.shift();
    }

    // ── Batteries ────────────────────────────────────────────────────────
    for (const b of this.batteries) {
      const site = this.sites.find((s) => s.id === b.siteId)!;
      const genRunning = this.generators.some((g) => g.siteId === b.siteId && g.status === "RUNNING");
      const charging = genRunning || site.gridAvailable;
      b.charging = charging;
      if (charging) {
        b.voltage = Math.round(Math.min(b.nominalVoltage * 1.06, b.voltage + 0.02 + this.rng.battery.float() * 0.03) * 100) / 100;
        b.stateOfCharge = Math.min(100, b.stateOfCharge + 0.4 + this.rng.battery.float() * 0.6);
        b.currentA = Math.round((2 + this.rng.battery.float() * 8) * 10) / 10;
      } else {
        b.voltage = Math.round(Math.max(b.nominalVoltage * 0.8, b.voltage - 0.04 - this.rng.battery.float() * 0.06) * 100) / 100;
        b.stateOfCharge = Math.max(5, b.stateOfCharge - 0.6 - this.rng.battery.float() * 0.8);
        b.currentA = Math.round(-(4 + this.rng.battery.float() * 12) * 10) / 10;
      }
      b.temperatureC = Math.round((b.temperatureC + (24 + this.rng.generator.float() * 6 - b.temperatureC) * 0.1) * 10) / 10;
      b.lastReadingAt = this.now;

      if (isBatteryLowVoltage(b.voltage, b.nominalVoltage)) {
        b.status = "LOW";
        alarmsCreated += await this.raiseAlarm({
          siteId: b.siteId, type: "BATT_LOW_VOLTAGE", severity: "L2",
          entityKind: "BATTERY", entityId: b.id,
          message: `Battery ${b.label} low voltage: ${b.voltage}V at ${site.name}`,
          value: b.voltage, threshold: battLowVoltageTripVolts(b.nominalVoltage) ?? undefined,
        });
      } else if (b.stateOfHealth < 70) {
        b.status = "REPLACEMENT_DUE";
        alarmsCreated += await this.raiseAlarm({
          siteId: b.siteId, type: "BATT_FAILURE", severity: "L1",
          entityKind: "BATTERY", entityId: b.id,
          message: `Battery ${b.label} health low: ${b.stateOfHealth}% at ${site.name}`,
          value: b.stateOfHealth, threshold: 70,
        });
      } else {
        b.status = "OK";
        await this.autoResolve("BATT_LOW_VOLTAGE", b.id);
      }
      b.history.push({ t: this.now, v: b.voltage, soc: Math.round(b.stateOfCharge) });
      if (b.history.length > HISTORY_POINTS) b.history.shift();
    }

    // ── Fuel dispensers + transactions (Task 34-B) ──────────────────────
    // ESP heartbeat: update wifiRssi ± small noise + lastCommAt. If comm
    // is stale (> 90s), flip status OFFLINE. Random 0.5% FAULT.
    // Idle/AUTHORIZED dispensers have a small chance per tick to start a
    // dispensing transaction; DISPENSING ones accumulate volume at the
    // current flow rate. When volume reaches the (random) target or
    // preset, complete the txn, push a FuelTransaction row, update the
    // totalizer, and decrement the site's DIESEL tank.
    for (const d of this.dispensers) {
      const site = this.sites.find((s) => s.id === d.siteId)!;
      // ── ESP reboot recovery (Task 48) ──────────────────────────────────
      // While an applyEspReboot() window is in flight the ESP is off the bus:
      // hold OFFLINE until the window elapses, then come back as IDLE.
      if (d.rebootingUntil) {
        if (this.now >= d.rebootingUntil) {
          d.rebootingUntil = undefined;
          d.status = "IDLE";
          d.lastCommAt = this.now;
          this.pushEvent(d.siteId, "INFO", `ESP controller reboot complete — ${d.label} back online`, { dispenserId: d.id });
        } else {
          d.lastCommAt = this.now - DISPENSER_COMM_STALE_MS;
          d.flowRateLpm = 0;
          d.history.push({ t: this.now, flow: 0, vol: d.currentVolumeLitres });
          if (d.history.length > HISTORY_POINTS) d.history.shift();
          continue;
        }
      }
      // ── ESP heartbeat ──────────────────────────────────────────────────
      d.lastCommAt = this.now;
      d.wifiRssi = Math.max(-95, Math.min(-45, d.wifiRssi + Math.round((this.rng.dispenser.float() - 0.5) * 4)));
      d.tempC = Math.round((d.tempC + (32 + this.rng.dispenser.float() * 6 - d.tempC) * 0.1) * 10) / 10;

      // Skip simulation for OFFLINE / MAINTENANCE / LOCKED dispensers
      if (d.status === "OFFLINE" || d.status === "MAINTENANCE" || d.mode === "LOCKED") {
        if (d.status === "OFFLINE" && d.lastCommAt > this.now - DISPENSER_COMM_STALE_MS) {
          // recovered
          d.status = "IDLE";
        }
        d.flowRateLpm = 0;
        d.history.push({ t: this.now, flow: 0, vol: d.currentVolumeLitres });
        if (d.history.length > HISTORY_POINTS) d.history.shift();
        continue;
      }
      // ── Random FAULT ───────────────────────────────────────────────────
      if (d.status !== "FAULT" && this.rng.dispenser.float() < DISPENSER_FAULT_PROB) {
        d.status = "FAULT";
        d.flowRateLpm = 0;
        this.pushEvent(d.siteId, "CRITICAL", `Dispenser ${d.label} FAULT detected`, { dispenserId: d.id });
        alarmsCreated += await this.raiseAlarm({
          siteId: d.siteId, type: "DISPENSER_FAULT", severity: "L3",
          entityKind: "DISPENSER", entityId: d.id,
          message: `Dispenser ${d.label} fault at ${site.name}`,
        });
        d.history.push({ t: this.now, flow: 0, vol: d.currentVolumeLitres });
        if (d.history.length > HISTORY_POINTS) d.history.shift();
        continue;
      }

      // ── State machine ──────────────────────────────────────────────────
      if (d.status === "IDLE") {
        // small chance per tick to enter AUTHORIZED → DISPENSING
        if (this.rng.site.float() < 0.08) {
          d.status = "AUTHORIZED";
          // most authorized dispensers begin dispensing within the same tick
          if (this.rng.site.float() < 0.7) {
            this.startDispense(d);
          }
        }
      } else if (d.status === "AUTHORIZED") {
        // wait a tick then begin dispensing
        if (this.rng.site.float() < 0.5) this.startDispense(d);
      } else if (d.status === "DISPENSING") {
        // advance the in-progress transaction
        const flow = d.flowRateLpm;
        const deltaL = (flow * seconds) / 60;
        d.currentVolumeLitres = Math.round((d.currentVolumeLitres + deltaL) * 100) / 100;
        const target = d.targetVolumeLitres ?? d.presetVolumeLitres ?? 50;
        if (d.currentVolumeLitres >= target) {
          await this.completeDispense(d);
        } else if (this.rng.site.float() < 0.002) {
          // rare premature stop (customer cancelled)
          await this.completeDispense(d, true);
        }
      } else if (d.status === "STOPPED") {
        // operator-initiated stop resets to IDLE next tick
        d.status = "IDLE";
        d.flowRateLpm = 0;
      }

      d.history.push({ t: this.now, flow: d.flowRateLpm, vol: d.currentVolumeLitres });
      if (d.history.length > HISTORY_POINTS) d.history.shift();
    }

    // ── Site gateways (Task 48) ───────────────────────────────────────────
    // Each tick: bump uptime, jitter cpuTempC/heapKb/wifiRssi around their
    // current values, and flip a 0.2% chance of a transient DEGRADED window.
    // If a reboot is in flight (rebootingUntil > now), keep status DEGRADED
    // until the window elapses; then return to ONLINE.
    for (const gw of this.gateways) {
      // Reboot recovery — clear the DEGRADED window.
      if (gw.rebootingUntil && this.now >= gw.rebootingUntil) {
        gw.rebootingUntil = undefined;
        gw.status = "ONLINE";
        gw.uptimeSec = 0; // reboot resets uptime
        gw.lastSeenAt = this.now;
        this.pushEvent(gw.siteId, "INFO", `Gateway ${gw.hostname} reboot complete — back ONLINE`, { gatewayId: gw.id });
      }

      if (gw.status === "OFFLINE") {
        // 5% chance per tick to come back online by itself.
        if (this.rng.site.float() < 0.05) {
          gw.status = "ONLINE";
          gw.lastSeenAt = this.now;
          this.pushEvent(gw.siteId, "INFO", `Gateway ${gw.hostname} reconnected`, { gatewayId: gw.id });
        } else {
          continue; // no telemetry updates while offline
        }
      }

      if (gw.status === "ONLINE") {
        // Random transient DEGRADED (rare) — e.g. WiFi dropout.
        if (!gw.rebootingUntil && this.rng.gateway.float() < 0.002) {
          gw.status = "DEGRADED";
          this.pushEvent(gw.siteId, "WARN", `Gateway ${gw.hostname} degraded (WiFi jitter)`, { gatewayId: gw.id });
        }
      } else if (gw.status === "DEGRADED" && !gw.rebootingUntil) {
        // Auto-recover from transient DEGRADED after a few ticks.
        if (this.rng.site.float() < 0.3) {
          gw.status = "ONLINE";
        }
      }

      // Telemetry jitter (only when not actively rebooting).
      if (!gw.rebootingUntil) {
        gw.uptimeSec += seconds;
        gw.cpuTempC = Math.round(Math.max(35, Math.min(85, gw.cpuTempC + (this.rng.gateway.float() - 0.5) * 1.2)) * 10) / 10;
        gw.heapKb = Math.max(8, Math.min(60, gw.heapKb + Math.round((this.rng.gateway.float() - 0.5) * 4)));
        gw.wifiRssi = Math.max(-95, Math.min(-45, gw.wifiRssi + Math.round((this.rng.gateway.float() - 0.5) * 3)));
        gw.lastSeenAt = this.now;
      }

      // Persist gateway health to DB occasionally (every ~10 ticks) so the
      // dashboard sees fresh values without a full engine reload.
      if (this.tickCount % 10 === 0) {
        db.siteGateway.update({
          where: { id: gw.id },
          data: {
            status: gw.status,
            uptimeSec: gw.uptimeSec,
            cpuTempC: gw.cpuTempC,
            heapKb: gw.heapKb,
            wifiRssi: gw.wifiRssi,
            lastSeenAt: new Date(gw.lastSeenAt),
          },
        }).catch(() => {});
      }
    }

    // ── Update site status from assets ───────────────────────────────────
    for (const s of this.sites) {
      if (s.commLossUntil && this.now <= s.commLossUntil) { s.status = "DEGRADED"; continue; }
      const hasFault = this.generators.some((g) => g.siteId === s.id && g.status === "FAULT");
      const hasCriticalTank = this.tanks.some((t) => t.siteId === s.id && t.current <= t.critical);
      const hasDispenserFault = this.dispensers.some((d) => d.siteId === s.id && d.status === "FAULT");
      if (hasFault || hasCriticalTank || hasDispenserFault) s.status = "DEGRADED";
      else s.status = "ONLINE";
    }

    // ── Escalate stale open alarms ───────────────────────────────────────
    await this.escalateStaleAlarms();

    // ── Reconcile open alarms against current conditions ─────────────────
    await this.reconcileAlarms();

    void prevNow;
    eventsCreated = 0; // events pushed inline
    return { tickCount: this.tickCount, eventsCreated, alarmsCreated };
  }

  /**
   * Resolve alarms whose underlying condition has cleared, and re-arm
   * point-in-time alarms after a cooldown.
   *
   * ── Why this exists ────────────────────────────────────────────────────
   * `autoResolve` was only ever called for FUEL_LOW, FUEL_CRITICAL and
   * BATT_LOW_VOLTAGE. Nothing ever cleared the dedup key for COMM_LOSS,
   * GEN_FAILURE, GEN_OVERHEAT, GEN_OFFLINE, FUEL_THEFT, FUEL_REFILL,
   * BATT_FAILURE or DISPENSER_FAULT, so `raiseAlarm` returned early forever
   * after the first occurrence: a generator that faulted at 03:00 and again
   * at 04:00 raised no second alarm, ever.
   *
   * Two categories:
   *  - STATEFUL conditions (a tank is below its low threshold, a generator is
   *    in FAULT, …) are resolved the moment they stop being true.
   *  - POINT-IN-TIME events (FUEL_THEFT, FUEL_REFILL) have no "cleared" state,
   *    so their key expires after TRANSIENT_REARM_MS and they may fire again.
   */
  private async reconcileAlarms(): Promise<void> {
    const stillTrue = new Set<string>();
    const add = (type: AlarmType, severity: Severity, id: string) =>
      stillTrue.add(`${type}:${severity}:${id}`);

    for (const tk of this.tanks) {
      if (tk.current <= tk.critical) add("FUEL_CRITICAL", "L3", tk.id);
      else if (tk.current <= tk.low) add("FUEL_LOW", "L2", tk.id);
    }

    for (const g of this.generators) {
      if (g.status === "FAULT") add("GEN_FAILURE", "L3", g.id);
      if (g.temperatureC > 104) add("GEN_OVERHEAT", "L3", g.id);
      else if (g.temperatureC > 95) add("GEN_OVERHEAT", "L2", g.id);
      // GEN_OFFLINE (Phase 0.6): this was raised in tick() but never added to
      // `stillTrue` here, so on the very next reconcile its key was absent and
      // the alarm was auto-resolved with "condition cleared" while the
      // generator was still offline — it could never be acknowledged. The
      // condition must mirror isGeneratorOffline() exactly, so both paths call
      // the same predicate.
      if (isGeneratorOffline(g, this.sites)) add("GEN_OFFLINE", "L2", g.id);
    }

    for (const b of this.batteries) {
      if (isBatteryLowVoltage(b.voltage, b.nominalVoltage)) add("BATT_LOW_VOLTAGE", "L2", b.id);
      if (b.stateOfHealth < 70) add("BATT_FAILURE", "L1", b.id);
    }

    for (const d of this.dispensers) {
      if (d.status === "FAULT") add("DISPENSER_FAULT", "L3", d.id);
    }

    for (const s of this.sites) {
      if (s.commLossUntil && s.commLossUntil > this.now) add("COMM_LOSS", "L2", s.id);
    }

    for (const key of [...this.openAlarmKeys]) {
      if (stillTrue.has(key)) continue;

      const [type, , entityId] = splitAlarmKey(key);

      if (TRANSIENT_ALARM_TYPES.has(type)) {
        // Re-arm after the cooldown so the event can fire again.
        const firstRaised = this.transientRaisedAt.get(key);
        if (firstRaised === undefined) {
          this.transientRaisedAt.set(key, this.now);
          continue;
        }
        if (this.now - firstRaised < TRANSIENT_REARM_MS) continue;
        this.transientRaisedAt.delete(key);
      }

      this.openAlarmKeys.delete(key);
      await db.alarm.updateMany({
        where: {
          type,
          entityId,
          status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] },
        },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(this.now),
          resolution: "Auto-resolved: condition cleared",
        },
      });
    }
  }

  // ── Dispenser transaction helpers (Task 34-B) ──────────────────────────
  /** Begin dispensing: set status, pick a target volume, set flow rate. */
  private startDispense(d: DispenserState) {
    d.status = "DISPENSING";
    d.startedAt = this.now;
    d.targetVolumeLitres = d.presetVolumeLitres ?? Math.round((20 + this.rng.dispenser.float() * 60) * 10) / 10;
    d.flowRateLpm = Math.round(d.maxFlowLpm * (0.8 + this.rng.dispenser.float() * 0.2) * 10) / 10;
    d.currentTransactionId = uid("tx");
    d.currentVolumeLitres = 0;
  }

  /**
   * Finalize the in-progress transaction on `d`:
   *  - compute volume + amount (volume × unit price)
   *  - persist a FuelTransaction row
   *  - update the dispenser totalizer + lastTransactionAt + (occasionally) DB
   *  - decrement the site's first DIESEL tank by the dispensed volume
   *  - reset the dispenser to IDLE
   * If `cancelled` is true the txn status is CANCELLED (still recorded).
   */
  private async completeDispense(d: DispenserState, cancelled = false) {
    const volume = Math.round(d.currentVolumeLitres * 100) / 100;
    const unitPrice = UNIT_PRICE_YER_PER_L;
    const amount = Math.round(volume * unitPrice);
    const startedAt = d.startedAt ?? this.now;
    const durationSec = Math.max(1, Math.round((this.now - startedAt) / 1000));
    const status: FuelTransactionState["status"] = cancelled ? "CANCELLED" : "COMPLETED";
    // Phase 1 step 4: FuelTransaction requires tenantId. Resolved from the
    // parent Site already loaded in engine state.
    const site = this.sites.find((s) => s.id === d.siteId)!;

    // Persist the FuelTransaction row (single source of truth).
    let txRow;
    try {
      txRow = await db.fuelTransaction.create({
        data: {
          tenantId: site.tenantId,
          dispenserId: d.id,
          siteId: d.siteId,
          nozzle: 1 + this.rng.dispenser.int(0, d.nozzleCount - 1),
          volumeLitres: volume,
          amountYer: amount,
          unitPriceYer: unitPrice,
          vehiclePlate: this.rng.dispenser.chance(0.6) ? this.randomPlate() : null,
          operatorName: null,
          status,
          startedAt: new Date(startedAt),
          completedAt: new Date(this.now),
          durationSec,
        },
      });
    } catch {
      // DB write failure shouldn't break the in-memory state machine
      txRow = null;
    }

    // In-memory transaction record (cap memory at MAX_RECENT_TXN_SNAPSHOT).
    // Money columns are `numeric` since Phase 1 step 9, so the state carries
    // Decimal. Prefer the values Prisma already parsed off the persisted row —
    // they are the source of truth and avoid re-quantising the same money twice
    // — and only construct them when the row write failed. Constructing via
    // `new Prisma.Decimal(<number>)` would go through a float, so the computed
    // fallback is routed through the tested toJsonNumber() first.
    const txn: FuelTransactionState = {
      id: txRow?.id ?? d.currentTransactionId ?? uid("tx"),
      dispenserId: d.id,
      siteId: d.siteId,
      nozzle: txRow?.nozzle ?? 1,
      volumeLitres: volume,
      amountYer: txRow?.amountYer ?? new Prisma.Decimal(toJsonNumber(amount)),
      unitPriceYer: txRow?.unitPriceYer ?? new Prisma.Decimal(toJsonNumber(unitPrice)),
      vehiclePlate: txRow?.vehiclePlate ?? undefined,
      status,
      startedAt,
      completedAt: this.now,
      durationSec,
    };
    this.fuelTransactions.unshift(txn);
    if (this.fuelTransactions.length > MAX_RECENT_TXN_SNAPSHOT) this.fuelTransactions.pop();

    // Update dispenser cumulative totalizer
    d.totalizerLitres = Math.round((d.totalizerLitres + volume) * 100) / 100;
    d.lastTransactionAt = this.now;

    // Persist totalizer + reset state to DB occasionally (every ~5 txns)
    if (txRow && this.rng.dispenser.chance(0.2)) {
      db.fuelDispenser.update({
        where: { id: d.id },
        data: {
          totalizerLitres: d.totalizerLitres,
          lastTransactionAt: new Date(this.now),
          currentVolumeLitres: 0,
          flowRateLpm: 0,
          currentTransactionId: null,
          status: "IDLE",
        },
      }).catch(() => {});
    }

    // Decrement the site's DIESEL tank by the dispensed volume
    if (!cancelled && volume > 0) {
      const tank = this.tanks.find((t) => t.siteId === d.siteId && t.fuelType === "DIESEL");
      if (tank) {
        tank.prevLevel = tank.current;
        tank.current = Math.max(0, tank.current - volume);
      }
    }

    // Push an event so the live feed shows the completed txn
    this.pushEvent(
      d.siteId,
      cancelled ? "WARN" : "INFO",
      `Dispenser ${d.label} ${cancelled ? "cancelled" : "completed"}: ${volume} L · ${amount} YER`,
      { dispenserId: d.id, txnId: txn.id, volume, amount, status },
    );

    // Reset dispenser state
    d.status = "IDLE";
    d.flowRateLpm = 0;
    d.currentVolumeLitres = 0;
    d.currentTransactionId = undefined;
    d.startedAt = undefined;
    d.targetVolumeLitres = undefined;
  }

  private randomPlate(): string {
    const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
    const n = 1000 + this.rng.dispenser.int(0, 8998);
    const l1 = letters[this.rng.dispenser.int(0, letters.length - 1)];
    const l2 = letters[this.rng.dispenser.int(0, letters.length - 1)];
    return `${l1}${l2}-${n}`;
  }

  /**
   * Control a fuel dispenser remotely. Used by POST /api/fgmp/dispensers/[id]/control.
   * Commands: AUTHORIZE | STOP | RESET | LOCK | UNLOCK.
   */
  async controlDispenser(
    dispenserId: string,
    command: "AUTHORIZE" | "STOP" | "RESET" | "LOCK" | "UNLOCK",
    preset?: number,
  ): Promise<{ ok: boolean; message: string }> {
    await this.ensureInit();
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) return { ok: false, message: "Dispenser not found" };
    const site = this.sites.find((s) => s.id === d.siteId)!;
    if (site.commLossUntil && this.now <= site.commLossUntil) {
      return { ok: false, message: "Site communication down — command queued but cannot execute" };
    }
    if (command === "AUTHORIZE") {
      if (d.mode === "LOCKED") return { ok: false, message: "Dispenser is LOCKED — unlock first" };
      if (d.status === "DISPENSING") return { ok: false, message: "Dispenser is already dispensing" };
      d.status = "AUTHORIZED";
      d.mode = "AUTO";
      if (preset && preset > 0) {
        d.presetVolumeLitres = Math.round(preset * 100) / 100;
      } else {
        d.presetVolumeLitres = undefined;
      }
      this.pushEvent(d.siteId, "CONTROL", `REMOTE AUTHORIZE ${d.label} (preset=${d.presetVolumeLitres ?? "none"} L)`, { dispenserId: d.id });
    } else if (command === "STOP") {
      if (d.status === "DISPENSING" || d.status === "AUTHORIZED") {
        if (d.status === "DISPENSING" && d.currentVolumeLitres > 0.5) {
          await this.completeDispense(d, true);
        } else {
          d.status = "STOPPED";
          d.flowRateLpm = 0;
        }
        this.pushEvent(d.siteId, "CONTROL", `REMOTE STOP ${d.label}`, { dispenserId: d.id });
      } else {
        return { ok: false, message: "Dispenser is not dispensing" };
      }
    } else if (command === "RESET") {
      if (d.status !== "FAULT") return { ok: false, message: "Dispenser is not in FAULT state" };
      d.status = "IDLE";
      d.flowRateLpm = 0;
      d.currentVolumeLitres = 0;
      d.currentTransactionId = undefined;
      this.pushEvent(d.siteId, "CONTROL", `REMOTE RESET ${d.label} (fault cleared)`, { dispenserId: d.id });
    } else if (command === "LOCK") {
      d.mode = "LOCKED";
      d.status = "STOPPED";
      d.flowRateLpm = 0;
      this.pushEvent(d.siteId, "CONTROL", `REMOTE LOCK ${d.label}`, { dispenserId: d.id });
    } else if (command === "UNLOCK") {
      d.mode = "AUTO";
      d.status = "IDLE";
      this.pushEvent(d.siteId, "CONTROL", `REMOTE UNLOCK ${d.label}`, { dispenserId: d.id });
    }
    // Persist mode/status change
    db.fuelDispenser.update({
      where: { id: d.id },
      data: { mode: d.mode, status: d.status, presetVolumeLitres: d.presetVolumeLitres ?? null },
    }).catch(() => {});
    return { ok: true, message: `${command} executed on ${d.label}` };
  }

  // ── Dispenser CRUD (Task 34-B) ─────────────────────────────────────────
  /** Create a new dispenser (DB + in-memory). ADMIN-only at the API layer. */
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
  }): Promise<DispenserState> {
    await this.ensureInit();
    // Phase 1 step 4: FuelDispenser requires tenantId. The caller passes only
    // siteId, so the tenant comes from the Site already in engine state.
    const site = this.sites.find((s) => s.id === data.siteId);
    if (!site) {
      throw new Error(`createDispenser: site ${data.siteId} not found`);
    }
    const row = await db.fuelDispenser.create({
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
        status: "IDLE",
        mode: "AUTO",
      },
    });
    const state: DispenserState = {
      id: row.id, siteId: row.siteId, label: row.label,
      manufacturer: row.manufacturer, model: row.model,
      nozzleCount: row.nozzleCount, fuelType: row.fuelType,
      maxFlowLpm: row.maxFlowLpm,
      status: row.status as DispenserState["status"],
      mode: row.mode as DispenserState["mode"],
      espDeviceId: row.espDeviceId, espFirmware: row.espFirmware,
      rs485Baudrate: row.rs485Baudrate, rs485Address: row.rs485Address,
      rs485Parity: row.rs485Parity, wifiRssi: row.wifiRssi,
      ipAddress: row.ipAddress ?? undefined,
      lastCommAt: row.lastCommAt?.getTime() ?? Date.now(),
      currentVolumeLitres: row.currentVolumeLitres,
      presetVolumeLitres: row.presetVolumeLitres ?? undefined,
      flowRateLpm: row.flowRateLpm, totalizerLitres: row.totalizerLitres,
      currentTransactionId: row.currentTransactionId ?? undefined,
      lastTransactionAt: row.lastTransactionAt?.getTime(),
      tempC: row.tempC, history: [],
    };
    this.dispensers.push(state);
    return state;
  }

  /** Update a dispenser's mutable fields (DB + in-memory). */
  async updateDispenser(id: string, data: {
    label?: string; manufacturer?: string; model?: string;
    nozzleCount?: number; fuelType?: string; maxFlowLpm?: number;
    espFirmware?: string; rs485Baudrate?: number; rs485Address?: number;
    rs485Parity?: string; ipAddress?: string;
    status?: string; mode?: string;
  }): Promise<DispenserState | null> {
    await this.ensureInit();
    const updateData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        if (k === "ipAddress") updateData[k] = (v as string) || null;
        else updateData[k] = v;
      }
    }
    const row = await db.fuelDispenser.update({ where: { id }, data: updateData });
    const live = this.dispensers.find((d) => d.id === id);
    if (live) {
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
      if (data.ipAddress !== undefined) live.ipAddress = data.ipAddress || undefined;
      if (data.status !== undefined) live.status = data.status as DispenserState["status"];
      if (data.mode !== undefined) live.mode = data.mode as DispenserState["mode"];
    }
    return live ?? null;
  }

  /** Delete a dispenser (DB + in-memory). Cascades to FuelTransaction rows. */
  async deleteDispenser(id: string): Promise<boolean> {
    await this.ensureInit();
    await db.fuelDispenser.delete({ where: { id } });
    const idx = this.dispensers.findIndex((d) => d.id === id);
    if (idx >= 0) this.dispensers.splice(idx, 1);
    this.fuelTransactions = this.fuelTransactions.filter((t) => t.dispenserId !== id);
    return true;
  }

  private async applyDueDeliveries(tk: TankState, site: SiteState) {
    const due = await db.fuelDelivery.findMany({
      where: { tankId: tk.id, status: "IN_TRANSIT" },
    });
    for (const d of due) {
      // probabilistic arrival
      if (this.rng.tank.chance(0.05)) {
        const delivered = d.volumeOrderedLitres;
        tk.prevLevel = tk.current;
        tk.current = Math.min(tk.capacity, tk.current + delivered);
        await db.fuelDelivery.update({
          where: { id: d.id },
          data: {
            status: "DELIVERED",
            volumeDeliveredLitres: delivered,
            deliveredAt: new Date(this.now),
          },
        });
        this.pushEvent(tk.siteId, "DELIVERY", `Fuel delivery arrived: +${Math.round(delivered)}L to ${tk.label} at ${site.name}`, { deliveryId: d.id });
      }
    }
  }

  // ── Alarm helpers ───────────────────────────────────────────────────────
  // `type`/`severity` are typed with the local unions from ./types, whose
  // members match the Prisma `AlarmType`/`AlarmSeverity` enums exactly. Keeping
  // the existing local vocabulary avoids a second import while still letting
  // TypeScript prove the value is a valid enum member — previously these were
  // bare `string`, which the now-strict enum columns reject.
  private async raiseAlarm(a: {
    siteId: string; type: AlarmType; severity: Severity;
    entityKind?: string; entityId?: string; message: string;
    value?: number; threshold?: number;
  }): Promise<number> {
    const key = `${a.type}:${a.severity}:${a.entityId ?? "site"}`;
    if (this.openAlarmKeys.has(key)) return 0;

    // ── Alarm suppression check (Task 32-B) ─────────────────────────────
    // Before creating the alarm, consult the suppression matcher. If an
    // active AlarmSuppression rule matches this (siteId, type, tenantId)
    // triple, we skip creating the alarm entirely (and skip the notification
    // queue). The matcher caches the active suppression list for 30s, so this
    // is cheap even on the engine's hot path.
    //
    // tenantId is required: `AlarmSuppression` rows with `siteId: null` are
    // documented as applying to ALL sites *in that tenant*, but the old
    // lookup only matched on (siteId, type) — so one tenant's maintenance
    // window silenced every other tenant's alarms.
    const tenantId = this.tenantIdForSite(a.siteId);
    try {
      const suppressed = await isAlarmSuppressed(a.siteId, a.type, tenantId);
      if (suppressed) {
        // Log a SUPPRESSED event so operators can see what would have
        // fired during a maintenance window (audit trail).
        this.pushEvent(a.siteId, "SUPPRESSED", `Alarm suppressed: ${a.type} — ${a.message}`, {
          type: a.type, severity: a.severity, reason: "maintenance-window",
        });
        return 0;
      }
    } catch {
      // If the matcher fails (DB unreachable during boot, etc.), fail
      // OPEN: don't block alarm creation just because the suppression
      // table couldn't be read.
    }

    this.openAlarmKeys.add(key);
    try {
      const alarm = await db.alarm.create({
        data: {
          tenantId,
          siteId: a.siteId,
          type: a.type,
          severity: a.severity,
          status: "OPEN",
          escalationLevel: 1,
          entityKind: a.entityKind ?? null,
          entityId: a.entityId ?? null,
          message: a.message,
          value: a.value ?? null,
          threshold: a.threshold ?? null,
        },
      });
      // queue a notification
      await db.notification.create({
        data: {
          tenantId,
          channel: "SMS",
          recipient: "+967-ops-oncall",
          subject: `[${a.severity}] ${a.type}`,
          body: a.message,
          alarmId: alarm.id,
          status: "QUEUED",
        },
      });
      return 1;
    } catch {
      this.openAlarmKeys.delete(key);
      return 0;
    }
  }

  /**
   * Resolve alarms of a given type for an entity once the condition clears.
   *
   * `severity` is optional: when omitted every severity for (type, entityId)
   * is cleared from the dedup set and from the DB — which is what all existing
   * callers want (they call this when a threshold is no longer breached).
   * Passing a severity narrows it to that severity only.
   *
   * The previous version used the key `${type}:${entityId}`, which no longer
   * matches the severity-qualified keys written by `raiseAlarm`, so nothing
   * was ever removed from `openAlarmKeys` and the affected alarm types could
   * never re-fire for the lifetime of the process.
   */
  private async autoResolve(type: AlarmType, entityId: string, severity?: Severity) {
    if (severity) {
      const key = `${type}:${severity}:${entityId}`;
      if (!this.openAlarmKeys.has(key)) return;
      this.openAlarmKeys.delete(key);
      await db.alarm.updateMany({
        where: {
          type, entityId, severity,
          status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] },
        },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(this.now),
          resolution: "Auto-resolved: condition cleared",
        },
      });
      return;
    }

    // Severity-agnostic: clear every severity recorded for this entity+type.
    const prefix = `${type}:`;
    let touched = false;
    for (const key of [...this.openAlarmKeys]) {
      if (key.startsWith(prefix) && key.endsWith(`:${entityId}`)) {
        this.openAlarmKeys.delete(key);
        touched = true;
      }
    }
    if (!touched) return;
    await db.alarm.updateMany({
      where: { type, entityId, status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } },
      data: { status: "RESOLVED", resolvedAt: new Date(this.now), resolution: "Auto-resolved: condition cleared" },
    });
  }

  /**
   * Age un-acknowledged alarms, stepping `escalationLevel` and notifying.
   *
   * Two corrections vs the previous version:
   *
   *  1. `severity` describes the CONDITION and is immutable. The old code
   *     rewrote it (`nextLevel===3 ? "L3" : nextLevel===2 ? "L2" : "L1"`),
   *     so a FUEL_CRITICAL raised as L3 was DOWNGRADED to L2 at 15 minutes
   *     and only restored on a later tick — and the L1/L2/L3 KPI tile,
   *     which counts by severity, was really counting alarm *age*.
   *  2. The step thresholds now come from settings (l1ToL2Minutes,
   *     l2ToL3Minutes) instead of one hardcoded 15 minutes for every step.
   *
   * Notifications are written under the OWNING SITE's tenant, not the
   * engine-wide fallback.
   */
  private async escalateStaleAlarms() {
    const { l1ToL2Minutes, l2ToL3Minutes } = this.escalationThresholds;
    const stale = await db.alarm.findMany({
      where: { status: "OPEN" },
      select: {
        id: true, escalationLevel: true, type: true, entityId: true,
        message: true, siteId: true, createdAt: true,
      },
    });

    for (const a of stale) {
      const ageMs = this.now - a.createdAt.getTime();
      // Time already spent at the CURRENT level decides the next one, so a
      // fresh alarm is not immediately escalated on its first tick.
      const minutesAtLevel =
        a.escalationLevel <= 1
          ? ageMs - l1ToL2Minutes * 60_000
          : ageMs - l2ToL3Minutes * 60_000;

      let nextLevel = a.escalationLevel;
      if (a.escalationLevel <= 1 && minutesAtLevel >= 0) nextLevel = 2;
      if (a.escalationLevel <= 2 && minutesAtLevel >= l1ToL2Minutes * 60_000) {
        nextLevel = 3;
      }
      if (nextLevel === a.escalationLevel) continue;

      await db.alarm.update({
        where: { id: a.id },
        data: {
          escalationLevel: nextLevel,
          status: nextLevel >= 3 ? "ESCALATED" : "OPEN",
          // `severity` intentionally NOT written — it is immutable.
        },
      });

      if (nextLevel >= 2) {
        await db.notification.create({
          data: {
            tenantId: this.tenantIdForSite(a.siteId ?? ""),
            channel: nextLevel >= 3 ? "WHATSAPP" : "EMAIL",
            recipient:
              nextLevel >= 3 ? "+967-escalation-l3" : "ops-manager@fgmp.telecom",
            subject: `[ESCALATION L${nextLevel}] ${a.type}`,
            body: a.message,
            alarmId: a.id,
            status: "QUEUED",
          },
        });
      }
    }
  }

  /**
   * Resolve the owning tenant for a site.
   *
   * `this.tenantId` was set once from `sites[0]` at init and then used for
   * EVERY alarm and notification. With more than one tenant that stamped all
   * of tenant B's alarms with tenant A's id — so B saw none of its own alarms
   * while A could acknowledge and resolve B's. Tenant must now be derived per
   * record. The fallback is only for an unknown site id.
   */
  private tenantIdForSite(siteId: string): string {
    if (siteId) {
      const site = this.sites.find((s) => s.id === siteId);
      if (site) return site.tenantId;
    }
    return this.tenantId;
  }

  // ── Control commands ────────────────────────────────────────────────────
  async applyCommand(genId: string, command: GenCommand, userId: string, reason?: string): Promise<{ ok: boolean; message: string }> {
    await this.ensureInit();
    const g = this.generators.find((x) => x.id === genId);
    if (!g) return { ok: false, message: "Generator not found" };
    const site = this.sites.find((s) => s.id === g.siteId)!;
    if (site.commLossUntil && this.now <= site.commLossUntil) {
      return { ok: false, message: "Site communication down — command queued but cannot execute" };
    }

    const cmd = await db.controlCommand.create({
      data: { tenantId: site.tenantId, generatorId: genId, command, status: "SENT", reason: reason ?? null, issuedById: userId, executedAt: new Date(this.now), result: "OK" },
    });

    if (command === "START") {
      g.status = "RUNNING";
      g.mode = "REMOTE";
      g.lastStartedAt = this.now;
      this.pushEvent(g.siteId, "CONTROL", `REMOTE START ${g.label} (cmd ${cmd.id.slice(-6)})`, { genId });
    } else if (command === "STOP") {
      g.status = "STOPPED";
      g.mode = "REMOTE";
      g.lastStoppedAt = this.now;
      this.pushEvent(g.siteId, "CONTROL", `REMOTE STOP ${g.label} (cmd ${cmd.id.slice(-6)})`, { genId });
    } else if (command === "EMERGENCY_STOP") {
      g.status = "FAULT";
      g.faultUntil = this.now + 30 * 60 * 1000;
      this.pushEvent(g.siteId, "CRITICAL", `EMERGENCY STOP ${g.label} (cmd ${cmd.id.slice(-6)})`, { genId });
    } else if (command === "RESET") {
      g.status = "STOPPED";
      g.faultUntil = undefined;
      this.pushEvent(g.siteId, "CONTROL", `RESET ${g.label} (cmd ${cmd.id.slice(-6)})`, { genId });
    }
    return { ok: true, message: `${command} executed on ${g.label}` };
  }

  // ── Reload (Task 48) ─────────────────────────────────────────────────────
  /**
   * Force a full re-initialization: re-read every Prisma table into the
   * in-memory state. Called by routes that mutate the schema in a way the
   * tick loop wouldn't otherwise observe (e.g. dispenser create/delete,
   * gateway delete, firmware release delete) so the next snapshot reflects
   * the change without a process restart.
   *
   * Safe to call repeatedly. Resets `initialized` so the next ensureInit()
   * re-runs init(); callers don't need to await the init promise directly.
   */
  async reload(): Promise<void> {
    this.initialized = false;
    this.initializing = null;
    await this.ensureInit();
  }

  // ── Edge: ESP controller reboot (Task 48) ───────────────────────────────
  /**
   * Reboot the ESP32/ESP8266 controller embedded in a fuel dispenser.
   * Used by POST /api/fgmp/edge/esp/[dispenserId]/reboot.
   *
   * Modelled as a 30s comm-loss window: the controller drops off the RS485
   * bus, so the dispenser reads OFFLINE for that window (and `lastCommAt` is
   * rolled back by the same amount) before the tick loop brings it back —
   * the dispenser-side counterpart of applyGatewayReboot()'s DEGRADED window.
   * The DB row is updated immediately so a fresh page load sees the right
   * state. Auditing is the caller's responsibility.
   *
   * Returns `{ ok: true, status: "OFFLINE", message }` on success, or
   * `{ ok: false, message }` if the dispenser isn't loaded in memory.
   */
  async applyEspReboot(
    dispenserId: string,
    _userId: string,
  ): Promise<{ ok: boolean; status?: string; message: string }> {
    await this.ensureInit();
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) {
      return { ok: false, message: "Dispenser not found in engine state" };
    }
    const ESP_REBOOT_MS = 30_000;
    d.rebootingUntil = this.now + ESP_REBOOT_MS;
    d.status = "OFFLINE";
    d.flowRateLpm = 0;
    d.lastCommAt = this.now - ESP_REBOOT_MS;
    this.pushEvent(
      d.siteId,
      "WARN",
      `ESP controller reboot initiated on ${d.label} (${ESP_REBOOT_MS / 1000}s)`,
      { dispenserId: d.id, userId: _userId },
    );
    // Persist OFFLINE immediately so a fresh page load sees the right state.
    db.fuelDispenser.update({
      where: { id: dispenserId },
      data: { status: "OFFLINE", lastCommAt: new Date(this.now - ESP_REBOOT_MS) },
    }).catch(() => {});
    return { ok: true, status: "OFFLINE", message: `Reboot initiated on ${d.label}` };
  }

  // ── Edge: ESP firmware OTA deployment (Task 48) ─────────────────────────
  /**
   * Queue an OTA firmware deployment for a single dispenser.
   * Used by POST /api/fgmp/edge/firmware/deploy.
   *
   * Creates the EspFirmwareDeployment row in status QUEUED; the row is the
   * durable record the /edge/firmware/deployments list reads back, so the
   * caller can return the new id immediately (202) and let the field layer
   * progress it. Auditing is the caller's responsibility.
   *
   * Returns `{ ok: true, deploymentId, status, message }`, or
   * `{ ok: false, message }` when the dispenser or release does not exist.
   */
  async applyFirmwareDeployment(
    dispenserId: string,
    releaseId: string,
    _userId: string,
  ): Promise<{ ok: boolean; deploymentId?: string; status?: string; message: string }> {
    await this.ensureInit();
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) {
      return { ok: false, message: "Dispenser not found in engine state" };
    }
    const release = await db.espFirmwareRelease.findUnique({
      where: { id: releaseId },
      select: { id: true, version: true },
    });
    if (!release) {
      return { ok: false, message: "Firmware release not found" };
    }
    // Phase 1 step 4: EspFirmwareDeployment requires tenantId (Tier A — a
    // deployment is the tenant-scoped instance of a global release). Resolved
    // through the target dispenser's site.
    const dispenserSite = this.sites.find((s) => s.id === d.siteId);
    if (!dispenserSite) {
      return { ok: false, message: "Dispenser site not found in engine state" };
    }
    const deployment = await db.espFirmwareDeployment.create({
      data: {
        tenantId: dispenserSite.tenantId,
        dispenserId,
        releaseId,
        status: "QUEUED",
        startedAt: new Date(this.now),
        initiatedById: _userId || null,
      },
    });
    this.pushEvent(
      d.siteId,
      "CONTROL",
      `Firmware ${release.version} queued for ${d.label}`,
      { dispenserId: d.id, deploymentId: deployment.id, userId: _userId },
    );
    return {
      ok: true,
      deploymentId: deployment.id,
      status: "QUEUED",
      message: `Firmware ${release.version} queued for ${d.label}`,
    };
  }

  /**
   * Simulate a 20-second gateway reboot: flip status to DEGRADED, set
   * `rebootingUntil` to now + 20s, and let the tick loop clear it. The
   * DB row is also updated immediately so the dashboard shows DEGRADED
   * before the next tick. Auditing is the caller's responsibility.
   *
   * Returns `{ ok: true, status: "DEGRADED", message }` on success, or
   * `{ ok: false, message }` if the gateway isn't loaded in memory (the
   * DB row may still exist; the caller should fall back to a no-op).
   */
  async applyGatewayReboot(
    gatewayId: string,
    _userId: string,
  ): Promise<{ ok: boolean; status?: string; message: string }> {
    await this.ensureInit();
    const gw = this.gateways.find((g) => g.id === gatewayId);
    if (!gw) {
      return { ok: false, message: "Gateway not found in engine state" };
    }
    gw.status = "DEGRADED";
    gw.rebootingUntil = this.now + 20_000; // 20s simulated reboot window
    gw.lastSeenAt = this.now;
    this.pushEvent(
      gw.siteId,
      "WARN",
      `Gateway ${gw.hostname} reboot initiated (20s)`,
      { gatewayId: gw.id, userId: _userId },
    );
    // Persist DEGRADED immediately so a fresh page load sees the right state.
    db.siteGateway.update({
      where: { id: gatewayId },
      data: { status: "DEGRADED", lastSeenAt: new Date(this.now) },
    }).catch(() => {});
    return { ok: true, status: "DEGRADED", message: `Reboot initiated on ${gw.hostname}` };
  }

  // ── Events ──────────────────────────────────────────────────────────────
  private pushEvent(siteId: string, kind: string, message: string, meta?: Record<string, unknown>) {
    this.events.unshift({ id: uid("ev"), siteId, kind, message, ts: this.now, meta });
    if (this.events.length > MAX_EVENTS) this.events.pop();
    // also persist to DB siteEvent. Phase 1 step 4 requires tenantId, resolved
    // from the Site in engine state. This is a best-effort fire-and-forget
    // write, so an unknown site simply skips the row rather than throwing into
    // the caller's tick.
    const site = this.sites.find((s) => s.id === siteId);
    if (site) {
      db.siteEvent
        .create({ data: { tenantId: site.tenantId, siteId, kind, message, meta: meta ? JSON.stringify(meta) : null } })
        .catch(() => {});
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────────────
  /**
   * Tenant-aware snapshot.
   *
   * Pass `null` (or omit the argument) to get the global cross-tenant view
   * (used by the platform super-admin and by the realtime mini-service which
   * fans snapshots out per-tenant on the socket.io side).
   *
   * Pass a concrete `tenantId` to get a snapshot scoped to that tenant only —
   * sites/tanks/generators/batteries/dispensers/IoT/events/transactions are
   * filtered to those whose parent Site belongs to the tenant, and the DB
   * counts (alarms, deliveries, tickets) are scoped with `where.tenantId`.
   *
   * This is the cornerstone of FGMP's multi-tenant isolation: every browser
   * hitting `/api/fgmp/state` gets a snapshot containing ONLY their tenant's
   * data, even though the in-memory engine caches all tenants' sites for
   * efficiency.
   */
  async snapshotForTenant(tenantId: string | null = null): Promise<Snapshot> {
    await this.ensureInit();

    // Tenant-scoped in-memory slices. For tenantId === null (super-admin /
    // realtime service) we use the full arrays unchanged.
    const sites = tenantId
      ? this.sites.filter((s) => s.tenantId === tenantId)
      : this.sites;
    const siteIds = new Set(sites.map((s) => s.id));
    const tanks = tenantId
      ? this.tanks.filter((t) => siteIds.has(t.siteId))
      : this.tanks;
    const generators = tenantId
      ? this.generators.filter((g) => siteIds.has(g.siteId))
      : this.generators;
    const batteries = tenantId
      ? this.batteries.filter((b) => siteIds.has(b.siteId))
      : this.batteries;
    const dispensers = tenantId
      ? this.dispensers.filter((d) => siteIds.has(d.siteId))
      : this.dispensers;
    const iotDevices = tenantId
      ? this.iotDevices.filter((d) => siteIds.has(d.siteId))
      : this.iotDevices;
    const fuelTransactions = tenantId
      ? this.fuelTransactions.filter((t) => siteIds.has(t.siteId))
      : this.fuelTransactions;
    const events = tenantId
      ? this.events.filter((e) => {
          // SiteEventState carries siteId; if it's missing we err on the side
          // of inclusion only when the caller is cross-tenant (null tenantId).
          const sid = (e as { siteId?: string }).siteId;
          return !sid || siteIds.has(sid);
        })
      : this.events;
    const gateways = tenantId
      ? this.gateways.filter((g) => siteIds.has(g.siteId))
      : this.gateways;
    // regions are platform-level (shared across tenants) — always return full.
    const regions = this.regions;

    // DB counts scoped to the tenant (or unscoped for super-admin).
    const alarmWhere = tenantId ? { tenantId } : {};
    const deliveryWhere = tenantId
      ? { site: { tenantId } }
      : {};
    const ticketWhere = tenantId
      ? { site: { tenantId } }
      : {};

    const [openAlarms, alarmsL1, alarmsL2, alarmsL3, pendingDeliveries, openTickets] = await Promise.all([
      db.alarm.count({ where: { ...alarmWhere, status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } } }),
      db.alarm.count({ where: { ...alarmWhere, status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] }, severity: "L1" } }),
      db.alarm.count({ where: { ...alarmWhere, status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] }, severity: "L2" } }),
      db.alarm.count({ where: { ...alarmWhere, status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] }, severity: "L3" } }),
      db.fuelDelivery.count({ where: { ...deliveryWhere, status: { in: ["SCHEDULED", "IN_TRANSIT"] } } }),
      db.maintenanceTicket.count({ where: { ...ticketWhere, status: { in: ["OPEN", "SCHEDULED", "IN_PROGRESS"] } } }),
    ]);

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

    // health score: weighted
    // AVAILABILITY ONLY — not the composite "site health" score.
    //
    // This weights site *status* (online=1, degraded=0.5) and nothing else; it
    // ignores fuel, generators, batteries and alarms. The composite weighted
    // score lives in /api/fgmp/analytics (`siteHealth.overall`) and is what the
    // dashboard's Site Health widget renders. The two numbers are deliberately
    // NOT equal and must not be presented as the same metric.
    const siteHealth = sites.length
      ? Math.round((onlineSites * 1 + degradedSites * 0.5) / sites.length * 100)
      : 100;

    // fuel consumed today + gen hours today (approx from history last 288 pts)
    const fuelConsumedTodayL = tanks.reduce((sum, t) => {
      if (t.history.length < 2) return sum;
      const first = t.history[0].l;
      const last = t.history[t.history.length - 1].l;
      const delivered = 0; // deliveries handled separately
      return sum + Math.max(0, first - last - delivered);
    }, 0);
    const generatorHoursToday = generators.reduce((sum, g) => {
      const runningPts = g.history.filter((h) => h.rate > 0).length;
      return sum + (runningPts * 5) / 60;
    }, 0);

    // Dispenser KPIs (Task 34-B)
    const dispensersTotal = dispensers.length;
    const dispensersDispensing = dispensers.filter((d) => d.status === "DISPENSING").length;
    const dispensersFault = dispensers.filter((d) => d.status === "FAULT").length;
    // "Today" must mean the platform's local calendar day, not the host's.
    // The container runs UTC while the platform timezone is Asia/Aden (UTC+3),
    // so `setHours(0,0,0,0)` pushed the 00:00–03:00 Aden window into
    // "yesterday". `startOfZonedDay` resolves the configured zone.
    const todayMs = startOfZonedDay(this.now, await resolvePlatformTimezone());
    const txnsToday = fuelTransactions.filter((t) => t.startedAt >= todayMs);
    const dispenserTransactionsToday = txnsToday.length;
    const dispenserVolumeTodayL = Math.round(
      txnsToday.filter((t) => t.status === "COMPLETED").reduce((a, t) => a + t.volumeLitres, 0),
    );

    const kpis: Kpis = {
      totalSites: sites.length,
      onlineSites, degradedSites, offlineSites,
      totalTanks: tanks.length,
      totalFuelLitres: Math.round(totalFuelLitres),
      totalFuelCapacity: Math.round(totalFuelCapacity),
      fuelPct: totalFuelCapacity ? Math.round((totalFuelLitres / totalFuelCapacity) * 1000) / 10 : 0,
      tanksCritical, tanksLow,
      generatorsRunning, generatorsTotal: generators.length, generatorsFault,
      batteriesLow,
      openAlarms, alarmsL1, alarmsL2, alarmsL3,
      pendingDeliveries, openTickets,
      avgSiteHealth: siteHealth,
      fuelConsumedTodayL: Math.round(fuelConsumedTodayL),
      generatorHoursToday: Math.round(generatorHoursToday * 10) / 10,
      dispensersTotal,
      dispensersDispensing,
      dispensersFault,
      dispenserTransactionsToday,
      dispenserVolumeTodayL,
    };

    return {
      now: this.now,
      tickCount: this.tickCount,
      kpis,
      sites,
      tanks: tanks.map(stripHistory),
      generators: generators.map(stripHistory),
      batteries: batteries.map(stripHistory),
      iotDevices,
      dispensers: dispensers.map(stripHistory),
      fuelTransactions: fuelTransactions.slice(0, MAX_RECENT_TXN_SNAPSHOT),
      events,
      gateways,
      regions,
    };
  }

  /**
   * Global cross-tenant snapshot. Kept for backward compatibility with the
   * realtime mini-service and any internal callers that genuinely need the
   * full multi-tenant view. Browser-facing endpoints should call
   * `snapshotForTenant(user.tenantId)` (or `snapshotForTenant(null)` for
   * super-admin) instead.
   */
  async snapshot(): Promise<Snapshot> {
    return this.snapshotForTenant(null);
  }
}

// strip heavy history from default snapshot to keep payloads small;
// history is fetched per-entity on demand.
function stripHistory<T extends { history?: unknown[] }>(x: T): T {
  const { history, ...rest } = x as Record<string, unknown>;
  void history;
  return rest as T;
}

// ── Singleton ──────────────────────────────────────────────────────────────
const globalForEngine = globalThis as unknown as { __fgmpEngine?: FgmpEngine };
export const engine: FgmpEngine = globalForEngine.__fgmpEngine ?? new FgmpEngine();
if (process.env.NODE_ENV !== "production") globalForEngine.__fgmpEngine = engine;
