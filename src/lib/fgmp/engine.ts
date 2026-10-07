import { Prisma, type FuelType } from "@prisma/client";
import { db } from "@/lib/db";
import { withTenant } from "./tenant-context";
import {
  detectUnexplainedLoss,
  expectedConsumption,
  severityFor,
  DEFAULT_SENSOR_ACCURACY,
} from "./theft-detection";
import { assertControlScope, assertGeneratorControlScope } from "./control-scope";
import { toJsonNumber, toNum } from "./decimal";
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

/**
 * Raised when the engine is asked to initialise without being told which
 * tenant to load.
 *
 * This exists as a distinct error on purpose. The failure it replaces was
 * silent: loading nothing and reporting an empty platform, which is
 * indistinguishable from a tenant that genuinely has no sites.
 */
export class EngineTenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTenantContextError";
  }
}

/**
 * Raised when a query returns rows belonging to a tenant the engine was not
 * asked to load. Defence in depth against the RLS context silently not
 * applying (wrong role, missing FORCE, a pooled connection mismatch).
 */
export class EngineTenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineTenantScopeError";
  }
}

/**
 * Resolve the tenants to load when a caller did not name one explicitly.
 *
 * The Tenant table has no `tenantId` column and is therefore outside RLS, so
 * this listing is legitimately unscoped. It is the ONLY unscoped read in the
 * engine, and it returns tenant IDs — not operational data.
 *
 * Callers that know which tenant they want should pass it. Relying on this
 * means loading every tenant into one instance, which is correct only because
 * the engine holds one combined snapshot; see `loadedTenants()`.
 */
async function resolveActiveTenantIds(): Promise<string[]> {
  const rows = await db.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  return rows.map((r) => r.id);
}

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
  /** Tenants whose state this instance currently holds. Empty = not loaded. */
  private loadedTenantIds: string[] = [];
  /** Cache key for the loaded set, so a changed scope forces a reload. */
  private loadedKey = "";
  /** Which scope an in-flight initialisation is for, for single-flight dedup. */
  private initializingKey: string | null = null;
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

  /**
   * Last-seen generator runtime hours, per generator.
   *
   * Fuel-theft detection needs the DELTA in runtime to predict how much fuel
   * SHOULD have been burned. Absolute runtime since installation would imply the
   * tank emptied weeks ago, so the previous tick's value is what makes the
   * prediction mean anything.
   *
   * Deliberately in-process and per-tick rather than persisted: it is a
   * one-step delta, so losing it on restart costs one window, not history.
   */
  private lastGenRuntimeHours = new Map<string, number>();
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

  /**
   * Initialise the snapshot for EXPLICITLY NAMED tenants.
   *
   * WHY THIS IS NOW A PARAMETER (Phase 2)
   * -------------------------------------
   * This used to be `init()` with no arguments, reading the module-level `db`
   * client — the RLS-enforced `fgmp_app` role — with NO tenant context in scope.
   * Under Phase 1's FORCE row-level security that is not a partial failure, it
   * is a total one: measured against the live database,
   *
   *     fgmp_app, no tenant context       ->  0 sites   (what this used to load)
   *     fgmp_app, app.tenant_id=t-default -> 52 sites
   *     fgmp_ops (BYPASSRLS)              -> 52 sites
   *
   * so the engine reported an empty platform while the database was full. The
   * previous line made that worse than a silent bug:
   *
   *     this.tenantId = sites[0]?.tenantId ?? "t-default";
   *
   * which invented a hardcoded tenant id whenever the (empty) result set had no
   * first row. Loading nothing therefore looked exactly like loading a
   * tenant that genuinely has nothing, which is why this survived the entire
   * Phase 1 audit.
   *
   * The fix is to make the tenant an explicit input rather than something
   * inferred from whichever rows happened to come back. A caller that does not
   * name a tenant gets an error, not an empty platform.
   */
  async ensureInit(tenants?: readonly string[]): Promise<void> {
    const wanted =
      tenants && tenants.length > 0 ? [...new Set(tenants)] : await resolveActiveTenantIds();
    if (wanted.length === 0) {
      throw new EngineTenantContextError(
        "FgmpEngine.ensureInit() needs at least one tenantId. The engine holds a " +
          "single tenant's state in memory and must be told which tenant to load; " +
          "inferring it from query results silently produced an empty platform.",
      );
    }
    const key = wanted.slice().sort().join(",");
    if (this.initialized && this.loadedKey === key) return;
    if (this.initializing && this.initializingKey === key) return this.initializing;
    this.initializingKey = key;
    this.initializing = this.init(wanted).finally(() => {
      this.initializing = null;
      this.initializingKey = null;
    });
    return this.initializing;
  }

  /**
   * Which tenants the engine is currently holding.
   *
   * Empty means not yet initialised. It is deliberately a list rather than the
   * old single `tenantId` field so a multi-tenant load cannot masquerade as a
   * single-tenant one.
   */
  loadedTenants(): readonly string[] {
    return this.loadedTenantIds;
  }

  /**
   * True when the snapshot was populated.
   *
   * Distinct from `loadedTenants().length > 0`: a tenant with genuinely no
   * sites is a different state from "nothing has been loaded", and conflating
   * them is the defect this refactor exists to remove.
   */
  isLoaded(): boolean {
    return this.initialized;
  }

  private async init(tenants: readonly string[]) {
    this.loadedTenantIds = [...tenants];
    // Compatibility for the many call sites that read `engine.tenantId`. It is
    // the first loaded tenant and must not be used to infer scope.
    this.tenantId = tenants[0] ?? "t-default";

    // Reset every snapshot collection before loading, so a reload for a
    // DIFFERENT tenant set cannot leave rows from the previous scope behind.
    this.clearSnapshot();

    // Each tenant is loaded inside its OWN withTenant(). RLS scopes on a single
    // app.tenant_id, so two tenants cannot be read in one context — asking for
    // both under one setting would silently return only one of them.
    //
    // Reads run on the transaction client, not the module-level `db`. Setting
    // the GUC on one pooled connection and then reading from another does not
    // work, which is the trap scheduler.ts documents; on a transaction client
    // the context and the reads share one connection by construction.
    for (const tenantId of tenants) {
      await withTenant(tenantId, async (tx) => {
        await this.loadInto(tx, [tenantId], true);
      });
    }

    // Once, after every tenant is resident — see the note in loadInto().
    this.backfillHistory();
    this.initialized = true;
  }

  /**
   * Empty every snapshot collection.
   *
   * Required on reload: the engine keeps parallel arrays keyed by id, so
   * loading a new scope without clearing first would leave the previous
   * tenant's assets resident and readable through the getters.
   */
  private clearSnapshot() {
    this.sites = [];
    this.tanks = [];
    this.generators = [];
    this.batteries = [];
    this.iotDevices = [];
    this.dispensers = [];
    this.fuelTransactions = [];
    this.events = [];
    this.gateways = [];
    this.regions = [];
    this.openAlarmKeys = new Set();
    this.transientRaisedAt = new Map();
    this.tankPtr = new Map();
  }

  private async loadInto(
    tx: Prisma.TransactionClient,
    tenants: readonly string[],
    append = false,
  ) {
    // Load geo hierarchy
    //
    // Governorate and District carry NO tenantId and therefore have no RLS
    // policy — migration 20261007000000_geography_rls REVOKEs both from fgmp_app
    // and exposes the tenant-filtered hierarchy through the `v_geography`
    // security_barrier view instead. Prisma resolves a nested `include:` as a
    // separate query that needs its own table privilege, so including them here
    // threw "permission denied for table Governorate" and aborted
    // ensureInit() entirely, leaving the engine with an EMPTY platform.
    //
    // The view's columns are camelCase, so every reference in raw SQL must be
    // double-quoted — PostgreSQL folds unquoted identifiers to lower case.
    const geoRows = await tx.$queryRawUnsafe<
      Array<{
        regionId: string;
        regionName: string;
        governorateId: string | null;
        governorateName: string | null;
        districtId: string | null;
        districtName: string | null;
      }>
    >(
      `SELECT "regionId","regionName","governorateId","governorateName","districtId","districtName"
         FROM v_geography`,
    );
    const regionMap = new Map<string, { id: string; name: string; governorates: Array<{ id: string; name: string; districts: Array<{ id: string; name: string }> }> }>();
    const govMap = new Map<string, { id: string; name: string; districts: Array<{ id: string; name: string }> }>();
    for (const row of geoRows) {
      let region = regionMap.get(row.regionId);
      if (!region) {
        region = { id: row.regionId, name: row.regionName, governorates: [] };
        regionMap.set(row.regionId, region);
      }
      if (row.governorateId && row.governorateName) {
        let gov = govMap.get(row.governorateId);
        if (!gov) {
          gov = { id: row.governorateId, name: row.governorateName, districts: [] };
          govMap.set(row.governorateId, gov);
          region.governorates.push(gov);
        }
        if (row.districtId && row.districtName) {
          gov.districts.push({ id: row.districtId, name: row.districtName });
        }
      }
    }
    this.regions.push(...[...regionMap.values()]);

    const regionNameById = new Map([...regionMap].map(([id, r]) => [id, r.name]));
    const govNameById = new Map([...govMap].map(([id, g]) => [id, g.name]));
    const districtNameById = new Map<string, string>();
    for (const g of govMap.values()) {
      for (const d of g.districts) districtNameById.set(d.id, d.name);
    }

    const sites = await tx.site.findMany({
      include: {
        // Region / Governorate / District are NOT included here: those two
        // tables are revoked from fgmp_app (migration
        // 20261007000000_geography_rls) and Prisma resolves each nested include
        // as its own query requiring its own table privilege. Their names come
        // from the `v_geography` rows loaded above instead.
        tanks: true, generators: true, batteries: true, iotDevices: true,
        dispensers: { include: { transactions: { orderBy: { startedAt: "desc" }, take: MAX_DISPENSER_TXN_MEMORY } } },
      },
    });
    // Region / Governorate / District are resolved from `geoRows` (the
    // v_geography view) rather than by nested include: those two tables are
    // revoked from fgmp_app, and Prisma resolves each include as its own query
    // requiring its own privilege.
    // The old line here read `sites[0]?.tenantId ?? "t-default"` — inferring
    // scope from the result set and inventing a hardcoded tenant id when the
    // set was empty. Scope is now the explicit `tenants` argument, and every
    // loaded row is asserted to belong to it, so a row from the wrong tenant
    // fails loudly instead of being adopted.

    this.sites.push(...sites.map((s) => {
      if (!tenants.includes(s.tenantId)) {
        throw new EngineTenantScopeError(
          `Engine asked for tenants [${tenants.join(", ")}] but the query returned ` +
            `site ${s.id} owned by "${s.tenantId}". Refusing to hold state for a ` +
            `tenant that was not requested.`,
        );
      }
      return {
      id: s.id, tenantId: s.tenantId, code: s.code, name: s.name,
      regionId: s.regionId, region: regionNameById.get(s.regionId) ?? "",
      governorateId: s.governorateId, governorate: govNameById.get(s.governorateId) ?? "",
      districtId: s.districtId, district: districtNameById.get(s.districtId) ?? "",
      latitude: s.latitude, longitude: s.longitude, address: s.address,
      status: s.status, criticality: s.criticality, loadKw: s.loadKw,
      powerSource: s.powerSource, gridAvailable: s.gridAvailable,
      };
    }));

    this.tanks.push(...sites.flatMap((s) => s.tanks.map((t) => ({
      id: t.id, siteId: t.siteId, label: t.label, fuelType: t.fuelType,
      // Phase 5 task 1: these are Decimal(12,3) in the DB. toNum(…, {scale: 3})
      // matches the column's own scale, so the in-memory number is exactly the
      // stored value — no silent widening, and no re-introducing the drift the
      // migration just removed.
      capacity: toNum(t.capacityLitres, { scale: 3 }),
      current: toNum(t.currentLitres, { scale: 3 }),
      low: toNum(t.lowThreshold, { scale: 3 }),
      critical: toNum(t.criticalThreshold, { scale: 3 }),
      status: t.status,
      lastReadingAt: t.lastReadingAt?.getTime() ?? Date.now(),
      history: [], prevLevel: toNum(t.currentLitres, { scale: 3 }),
    }))))

    this.generators.push(...sites.flatMap((s) => s.generators.map((g) => ({
      id: g.id, siteId: g.siteId, label: g.label, manufacturer: g.manufacturer,
      model: g.model, ratedPowerKw: g.ratedPowerKw, status: g.status as GenStatus,
      mode: g.mode as GenState["mode"], runtimeHours: g.runtimeHours,
      temperatureC: g.temperatureC, oilPressureKpa: g.oilPressureKpa,
      loadKw: g.loadKw, fuelRateLph: g.fuelRateLph, batteryVoltage: g.batteryVoltage,
      oilChangeIntervalHrs: g.oilChangeIntervalHrs, lastOilChangeHrs: g.lastOilChangeHrs,
      nextMaintenanceHrs: g.nextMaintenanceHrs,
      lastStartedAt: g.lastStartedAt?.getTime(), lastStoppedAt: g.lastStoppedAt?.getTime(),
      lastReadingAt: g.lastReadingAt?.getTime() ?? Date.now(), history: [],
    }))))

    this.batteries.push(...sites.flatMap((s) => s.batteries.map((b) => ({
      id: b.id, siteId: b.siteId, label: b.label, chemistry: b.chemistry,
      capacityAh: b.capacityAh, nominalVoltage: b.nominalVoltage,
      voltage: b.voltage, currentA: b.currentA, stateOfCharge: b.stateOfCharge,
      stateOfHealth: b.stateOfHealth, temperatureC: b.temperatureC,
      charging: b.charging, status: b.status,
      installedAt: b.installedAt.getTime(), lastReadingAt: b.lastReadingAt?.getTime() ?? Date.now(),
      history: [],
    }))))

    this.iotDevices.push(...sites.flatMap((s) => s.iotDevices.map((d) => ({
      id: d.id, siteId: d.siteId, name: d.name, type: d.type, protocol: d.protocol,
      vendor: d.vendor, serialNo: d.serialNo, firmware: d.firmware,
      ipAddress: d.ipAddress ?? undefined, modbusUnit: d.modbusUnit ?? undefined,
      status: d.status, lastSeenAt: d.lastSeenAt?.getTime() ?? Date.now(),
      signalRssi: d.signalRssi, otaTargetFw: d.otaTargetFw ?? undefined,
      otaStatus: d.otaStatus ?? undefined,
    }))))

    this.dispensers.push(...sites.flatMap((s) => s.dispensers.map((d) => ({
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
      // Phase 5 task 1: volume columns are Decimal(12,3) — see the mapping note
      // in init(). toNum at scale 3 matches the stored precision exactly.
      currentVolumeLitres: toNum(d.currentVolumeLitres, { scale: 3 }),
      presetVolumeLitres: d.presetVolumeLitres === null ? undefined : toNum(d.presetVolumeLitres, { scale: 3 }),
      flowRateLpm: toNum(d.flowRateLpm, { scale: 3 }),
      totalizerLitres: toNum(d.totalizerLitres, { scale: 3 }),
      currentTransactionId: d.currentTransactionId ?? undefined,
      lastTransactionAt: d.lastTransactionAt?.getTime(),
      tempC: d.tempC, history: [],
    }))))

    // `.slice(…, MAX_RECENT_TXN_SNAPSHOT)` caps the combined list across tenants,
    // so the snapshot stays bounded no matter how many tenants are loaded.
    this.fuelTransactions.push(
      ...sites
        .flatMap((s) =>
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
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_RECENT_TXN_SNAPSHOT),
    );

    // Task 48 — load all site gateways (with site relation for the dashboard's
    // site badge). The gateway tick loop in tick() simulates small live
    // fluctuations on top of these persisted values.
    const gatewayRows = await tx.siteGateway.findMany({
      include: { site: { select: { id: true, name: true, code: true } } },
    });
    this.gateways.push(...gatewayRows.map((g) => ({
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
    })));

    // Load existing open alarm keys for dedup. The key shape must match
    // `raiseAlarm`/`autoResolve` exactly, so severity is part of it.
    const openAlarms = await tx.alarm.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } },
      select: { type: true, entityId: true, severity: true },
    });
    // Additive, not reassigned: each tenant is loaded in its own context, so
    // this must union across tenants. Reassigning here would discard the
    // dedup keys of every tenant loaded before the last one.
    for (const a of openAlarms) {
      this.openAlarmKeys.add(`${a.type}:${a.severity}:${a.entityId ?? "site"}`);
    }

    // backfillHistory() and the initialized flag belong to init(), not here: this
    // method runs once PER TENANT, so backfilling here would seed synthetic
    // history for a single tenant on every pass and reset `initialized` after
    // each one.
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

    // ── Fuel tanks: DETECTED losses, then thresholds ─────────────────────
    for (const tk of this.tanks) {
      const site = this.sites.find((s) => s.id === tk.siteId)!;

      // ── FUEL THEFT: DERIVED, NOT INJECTED ─────────────────────────────────
      // The previous code rolled a dice, subtracted a random volume, and then
      // announced the subtraction as "theft detected". That is not detection:
      // the alarm was a restatement of the generator's own random number and
      // could not disagree with its input. An operator paging on it would be
      // paging on a fabricated event.
      //
      // What replaces it compares the MEASURED level change against fuel
      // consumption PREDICTED from generator runtime — an independent signal
      // that comes from the controller, not the level sensor. When they disagree
      // by more than the combined measurement error, fuel left without burning.
      //
      // Nothing is subtracted here. The detector observes; it does not cause.
      {
        const gen = this.generators.find((g) => g.siteId === tk.siteId);
        const startLitres = tk.prevLevel ?? tk.current;
        const runtimeDeltaHours = gen
          ? Math.max(0, (gen.runtimeHours ?? 0) - (this.lastGenRuntimeHours.get(gen.id) ?? 0))
          : 0;

        if (gen && startLitres > 0) {
          const candidate = detectUnexplainedLoss({
            tankId: tk.id,
            siteId: tk.siteId,
            levelStartLitres: startLitres,
            levelEndLitres: tk.current,
            expectedConsumptionLitres: expectedConsumption(gen.ratedPowerKw, runtimeDeltaHours),
            // One tick is one window. The detector refuses anything under an
            // hour anyway, so this is a floor, not a measured duration.
            windowHours: this.tickSeconds / 3600,
            capacityLitres: tk.capacity,
            sensorAccuracyFraction: DEFAULT_SENSOR_ACCURACY,
          });
          const severity = candidate ? severityFor(candidate) : null;
          if (candidate && severity) {
            this.pushEvent(
              tk.siteId,
              severity === "CRITICAL" ? "CRITICAL" : "WARN",
              `Unexplained fuel loss: ${candidate.unexplainedLitres}L from ${tk.label} at ${site.name} ` +
                `(expected ${candidate.expectedLitres}L burned, ${candidate.measuredLitres}L measured, ` +
                `${candidate.significance}x tolerance)`,
              { tankId: tk.id, ...candidate },
            );
            alarmsCreated += await this.raiseAlarm({
              siteId: tk.siteId,
              type: "FUEL_THEFT",
              // Severity is DERIVED from significance and volume, not pinned to
              // L3. A 2x over-budget loss and a 40x one are not the same event,
              // and collapsing them makes the alert unrankable.
              severity: severity === "CRITICAL" ? "L3" : "L2",
              entityKind: "TANK",
              entityId: tk.id,
              message:
                `Unexplained fuel loss of ${candidate.unexplainedLitres}L at ${site.name} (${tk.label}) — ` +
                `${candidate.significance}x the measurement tolerance`,
              value: candidate.unexplainedLitres,
              threshold: 0,
            });
          }
        }
        if (gen) this.lastGenRuntimeHours.set(gen.id, gen.runtimeHours ?? 0);
      }

      // An unexplained INCREASE is still simulated. It is retained deliberately
      // rather than silently dropped: it exercises the FUEL_REFILL alarm path in
      // demo data, and removing it would remove test coverage of a real alarm
      // type. It is marked as simulated so nobody mistakes it for detection.
      if (this.rng.site.float() < 0.0008) {
        const added = 80 + this.rng.site.float() * 300;
        tk.prevLevel = tk.current;
        tk.current = Math.min(tk.capacity, tk.current + added);
        this.pushEvent(tk.siteId, "WARN", `[SIMULATED] Unexpected fuel increase: +${Math.round(added)}L in ${tk.label} at ${site.name}`, { tankId: tk.id, added, simulated: true });
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
  /**
 * Resolve a site for a control operation, or refuse.
 *
 * ── WHY THIS IS A BOUNDARY PROPERTY AND NOT A PER-CALLER FIX ───────────────
 * The engine holds ONE tenant's assets in memory. A control command names an
 * asset id that arrives from a request, so it is attacker-controlled: it may
 * name an asset in a tenant the engine is not holding.
 *
 * Previously each entry point did its own `this.sites.find(...)` and several
 * used a non-null assertion (`...find(...)!`). Two distinct problems followed:
 *
 *   1. If the asset is not resident, `find` returns undefined and the caller
 *      decides what that means. Most returned `{ ok: false }` — a DENIAL, which
 *      is safe. But `deleteDispenser` deleted the row from the database and
 *      then returned `true` regardless, so a cross-tenant id was a silent
 *      SUCCESS. That is a cross-tenant ALLOW, and it is the outcome that
 *      matters.
 *   2. `this.sites.find(...)!` would throw a TypeError on undefined, turning a
 *      clean refusal into a 500.
 *
 * This helper makes the refusal the default at ONE place: an asset that is not
 * resident, or whose site is not resident, or whose tenant is not among those
 * the engine holds, is denied. Every control entry point routes through it, so
 * the property no longer depends on each call site having remembered the check.
 *
 * It returns the site, or a reason string — never undefined. Callers that
 * need a typed miss branch on the string rather than trusting a `!`.
 */
/**
   * Explain why an asset id could not be resolved, distinguishing "no such
   * asset" from "the engine is holding a different tenant's state".
   *
   * These are genuinely different operator situations and they need different
   * responses. "No such generator" means the request is wrong. "The engine is
   * not holding that tenant" means THIS PROCESS is misconfigured — which, in a
   * multi-tenant control system, is the difference between a typo and a
   * cross-tenant control attempt. Returning a generic "not found" for both
   * hides the second behind the first, which is how a wrong-tenant command
   * would read as a harmless bad request.
   */
  private absentAssetMessage(kind: string, assetId: string): string {
    const held = this.loadedTenants().join(", ") || "no tenant";
    return (
      `${kind} ${assetId} is not present in engine state. ` +
      `The engine is holding [${held}]. Either no such ${kind.toLowerCase()} exists, ` +
      `or it belongs to a tenant this process was not asked to load — the caller ` +
      `must not read this as an approval.`
    );
  }

  private resolveControlSite(
  siteId: string,
  assetLabel: string,
): { site: SiteState; denied?: undefined } | { site?: undefined; denied: string } {
  if (!this.initialized) {
    return {
      denied:
        `${assetLabel} refused: the engine holds no tenant state. ` +
        `This is STATE_UNAVAILABLE, not "not found" — the caller must not treat it as an allow.`,
    };
  }
  const site = this.sites.find((s) => s.id === siteId);
  if (!site) {
    return {
      denied:
        `${assetLabel} refused: site ${siteId} is not resident. The engine is ` +
        `holding [${this.loadedTenants().join(", ") || "no tenant"}], so this asset ` +
        `is either absent or belongs to a tenant this process is not holding.`,
    };
  }
  if (!this.loadedTenantIds.includes(site.tenantId)) {
    return {
      denied:
        `${assetLabel} refused: site ${siteId} belongs to tenant ` +
        `"${site.tenantId}", which the engine was not asked to load.`,
    };
  }
  return { site };
}

async controlDispenser(
    dispenserId: string,
    command: "AUTHORIZE" | "STOP" | "RESET" | "LOCK" | "UNLOCK",
    preset?: number,
    expectedTenantId?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    await this.ensureInit();
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) {
      // Not resident. Previously this returned a plain "not found" — a denial,
      // which was correct — but it did not distinguish "no such asset" from
      // "wrong tenant loaded", which is the ambiguity this helper removes.
      return { ok: false, message: this.absentAssetMessage("Dispenser", dispenserId) };
    }
    // ── PHASE 3 CONTROL SCOPE ─────────────────────────────────────────────
    // resolveControlSite below checks the site is RESIDENT; this checks the
    // site's tenant equals the tenant the caller was authorised for. Residency
    // is a loading fact, ownership is the authorisation question, and only the
    // second one prevents a cross-tenant command.
    if (expectedTenantId !== null) {
      const scope = assertControlScope({
        expectedTenantId,
        assetTenantId: this.tenantIdForSite(d.siteId),
        assetLabel: `Dispenser ${dispenserId}`,
        action: command,
      });
      if (!scope.allowed) return { ok: false, message: scope.message };
    }
    const resolved = this.resolveControlSite(d.siteId, `Dispenser ${dispenserId}`);
    if (resolved.denied || !resolved.site) return { ok: false, message: resolved.denied ?? "Site unavailable" };
    const site = resolved.site;
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
      // Phase 5 task 1: Decimal(12,3) -> number at the DB boundary.
      currentVolumeLitres: toNum(row.currentVolumeLitres, { scale: 3 }),
      presetVolumeLitres: row.presetVolumeLitres === null ? undefined : toNum(row.presetVolumeLitres, { scale: 3 }),
      flowRateLpm: toNum(row.flowRateLpm, { scale: 3 }),
      totalizerLitres: toNum(row.totalizerLitres, { scale: 3 }),
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
  /**
   * Issue a control command to a generator.
   *
   * ── PHASE 3 CONTROL SCOPE ──────────────────────────────────────────────
   * `expectedTenantId` is the tenant of the AUTHENTICATED caller. It is
   * REQUIRED and deliberately not optional: without it the asset's tenant is
   * the only thing being compared, which proves nothing. A caller that cannot
   * supply it has no authorisation to assert.
   *
   * Passing `null` reproduces the previous, unsafe behaviour — the assertion
   * is skipped entirely — and exists only so the change is explicit rather
   * than silent. No route passes null.
   */
  async applyCommand(
    genId: string,
    command: GenCommand,
    userId: string,
    reason?: string,
    expectedTenantId?: string | null,
  ): Promise<{ ok: boolean; message: string }> {
    await this.ensureInit();
    const g = this.generators.find((x) => x.id === genId);
    if (!g) return { ok: false, message: this.absentAssetMessage("Generator", genId) };
    const site = this.sites.find((s) => s.id === g.siteId)!;
    // Site lookup must not be asserted with `!` and then trusted: if the site
    // is absent the old code would throw a TypeError on `site.commLossUntil`,
    // which surfaced as a 500 rather than a refusal.
    if (!site) {
      return {
        ok: false,
        message: this.absentAssetMessage(`Site ${g.siteId} for generator`, genId),
      };
    }

    // ── CONTROL SCOPE: refuse before ANY state mutation ───────────────────
    if (expectedTenantId !== null) {
      const scope = assertGeneratorControlScope({
        expectedTenantId,
        generatorId: genId,
        // GenState carries no tenantId; ownership for a controlled asset is its
        // Site's, which is what assertGeneratorControlScope compares.
        generatorTenantId: undefined,
        siteTenantId: site.tenantId,
        action: command,
      });
      if (!scope.allowed) return { ok: false, message: scope.message };
    }

    if (site.commLossUntil && this.now <= site.commLossUntil) {
      return { ok: false, message: "Site communication down — command queued but cannot execute" };
    }

    // ── PHASE 3: this write is RLS-protected, so it MUST run inside withTenant(). ──
    // It previously ran on the bare `db` client with no tenant context, which
    // under FORCE RLS is rejected by WITH CHECK — so the create THREW and the
    // whole control path surfaced as a 500 carrying a raw PostgreSQL policy
    // message. It also attributed the row to the ENGINE's tenant rather than
    // the caller's, which would misfile a command if the engine ever held the
    // wrong tenant.
    const cmd = await withTenant(site.tenantId, (tx) =>
      tx.controlCommand.create({
        data: {
          tenantId: site.tenantId,
          generatorId: genId,
          command,
          // PHASE 5. `executedAt` and `result: "OK"` are NO LONGER written at
          // issue time.
          //
          // Both were false. Nothing had executed and no outcome had been
          // observed: the dispatch below is a simulated in-process mutation with
          // no Modbus, MQTT or serial write anywhere in the path. Recording an
          // execution timestamp and an OK result at the moment of issue asserted
          // a hardware event that never happened, and an auditor reading the row
          // would conclude the engine had been commanded.
          //
          // What IS true at this point: the command was accepted and the
          // simulated dispatch applied. executedAt stays null — leaving it free
          // to mean "a device actually reported back" once a real dispatcher
          // exists — and `result` says so in words rather than implying success.
          status: "SENT",
          reason: reason ?? null,
          issuedById: userId,
          executedAt: null,
          result: "SIMULATED_DISPATCH_APPLIED_NO_HARDWARE",
        },
      }),
    );

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
  /**
   * Reload the snapshot.
   *
   * Reloads the SAME tenants that are currently loaded, not "whatever tenants
   * exist". Re-resolving the tenant list here would silently change the
   * engine's scope — so a reload intended to refresh data could quietly widen
   * or narrow which tenants are resident.
   */
  async reload(): Promise<void> {
    const scope = this.loadedTenantIds.slice();
    this.initialized = false;
    this.initializing = null;
    this.loadedKey = "";
    if (scope.length === 0) {
      // Never loaded: fall back to the normal resolution.
      await this.ensureInit();
      return;
    }
    await this.ensureInit(scope);
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
    expectedTenantId?: string | null,
  ): Promise<{ ok: boolean; status?: string; message: string }> {
    await this.ensureInit();
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) {
      return { ok: false, message: this.absentAssetMessage("Dispenser", dispenserId) };
    }
    // ── PHASE 3 CONTROL SCOPE ─────────────────────────────────────────────
    if (expectedTenantId !== null) {
      const scope = assertControlScope({
        expectedTenantId,
        assetTenantId: this.tenantIdForSite(d.siteId),
        assetLabel: `Dispenser ${dispenserId}`,
        action: "ESP_REBOOT",
      });
      if (!scope.allowed) return { ok: false, message: scope.message };
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
    // ── PHASE 3: this write previously used the bare `db` client with NO
    // tenant context, so under FORCE RLS it ALWAYS failed — and `.catch(() => {})`
    // discarded the failure. The function still returned ok:true, so the
    // operator was told the reboot happened while only in-memory state had
    // changed and the database kept the old status. A command that reports
    // success without persisting is the silent-success defect: it survives a
    // restart as though it never ran.
    //
    // Now the write is scoped, awaited, and a failure is REFUSED rather than
    // swallowed. The in-memory mutation is rolled back on failure so the two
    // representations cannot disagree.
    try {
      await withTenant(this.tenantIdForSite(d.siteId), (tx) =>
        tx.fuelDispenser.update({
          where: { id: dispenserId },
          data: { status: "OFFLINE", lastCommAt: new Date(this.now - ESP_REBOOT_MS) },
        }),
      );
    } catch (err) {
      // Undo the optimistic in-memory change so state does not claim a reboot
      // that was never recorded.
      d.rebootingUntil = undefined;
      return {
        ok: false,
        message:
          `Reboot of ${d.label} could not be recorded, so it was NOT performed: ` +
          `${(err as Error).message}`,
      };
    }
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
    expectedTenantId?: string | null,
  ): Promise<{ ok: boolean; deploymentId?: string; status?: string; message: string }> {
    await this.ensureInit();
    const d = this.dispensers.find((x) => x.id === dispenserId);
    if (!d) {
      return { ok: false, message: this.absentAssetMessage("Dispenser", dispenserId) };
    }
    // ── PHASE 3 CONTROL SCOPE: resolved BEFORE any write ──────────────────
    if (expectedTenantId !== null) {
      const scope = assertControlScope({
        expectedTenantId,
        assetTenantId: this.tenantIdForSite(d.siteId),
        assetLabel: `Dispenser ${dispenserId}`,
        action: "FIRMWARE_DEPLOY",
      });
      if (!scope.allowed) return { ok: false, message: scope.message };
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
    // ── PHASE 3: tenantId comes from the RESOLVED site's tenant, and the write
    // runs inside withTenant(). It previously used the bare `db` client with no
    // context, so under FORCE RLS the create THREW — the caller saw a 500 with a
    // raw PostgreSQL policy message instead of a clean refusal.
    let deployment;
    try {
      deployment = await withTenant(dispenserSite.tenantId, (tx) =>
        tx.espFirmwareDeployment.create({
          data: {
            tenantId: dispenserSite.tenantId,
            dispenserId,
            releaseId,
            status: "QUEUED",
            startedAt: new Date(this.now),
            initiatedById: _userId || null,
          },
        }),
      );
    } catch (err) {
      return {
        ok: false,
        message:
          `Firmware deployment was NOT queued for ${d.label}: ` +
          `${(err as Error).message}`,
      };
    }
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
    expectedTenantId?: string | null,
  ): Promise<{ ok: boolean; status?: string; message: string }> {
    await this.ensureInit();
    const gw = this.gateways.find((g) => g.id === gatewayId);
    if (!gw) {
      return { ok: false, message: this.absentAssetMessage("Gateway", gatewayId) };
    }
    // ── PHASE 3 CONTROL SCOPE ─────────────────────────────────────────────
    if (expectedTenantId !== null) {
      const scope = assertControlScope({
        expectedTenantId,
        assetTenantId: this.tenantIdForSite(gw.siteId),
        assetLabel: `Gateway ${gw.hostname}`,
        action: "GATEWAY_REBOOT",
      });
      if (!scope.allowed) return { ok: false, message: scope.message };
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
    // ── PHASE 3: this was an unscoped `db` write swallowed by `.catch(() => {})`.
    // Under FORCE RLS that update ALWAYS failed, so this returned ok:true with
    // nothing persisted — the silent-success defect. Now scoped, awaited, and a
    // failure REFUSES rather than being discarded.
    try {
      await withTenant(this.tenantIdForSite(gw.siteId), (tx) =>
        tx.siteGateway.update({
          where: { id: gatewayId },
          data: { status: "DEGRADED", lastSeenAt: new Date(this.now) },
        }),
      );
    } catch (err) {
      gw.status = "ONLINE";
      gw.rebootingUntil = undefined;
      return {
        ok: false,
        message:
          `Reboot of ${gw.hostname} could not be recorded, so it was NOT performed: ` +
          `${(err as Error).message}`,
      };
    }
    return { ok: true, status: "DEGRADED", message: `Reboot initiated on ${gw.hostname}` };
  }

  // ── Events ──────────────────────────────────────────────────────────────
  /**
   * Record an operational event in the in-memory ring buffer AND in the DB.
   *
   * ── PHASE 5: this write was silently failing ───────────────────────────────
   * It used to run on the bare `db` client:
   *
   *     db.siteEvent.create({ data: { tenantId: site.tenantId, ... } })
   *       .catch(() => {})
   *
   * Broken twice over. SiteEvent is RLS-protected, and a query on the global
   * client runs on a POOLED connection with no `app.tenant_id` set, so the
   * INSERT was rejected by WITH CHECK on every call — and the bare
   * `.catch(() => {})` discarded the error, so the failure was invisible.
   * REMOTE START / REMOTE STOP events existed only in memory until restart.
   *
   * Both halves are fixed: the write runs inside withTenant(), and a failure
   * is LOGGED rather than discarded. This is the third occurrence of the same
   * silent-success pattern in this codebase (the others: the backup audit
   * write, and the `NO_TRANSPORT` notification status that no code ever set).
   * That recurrence is the real finding — a swallowed write on an audit-visible
   * path is indistinguishable from a working one, which is why the catch is now
   * loud rather than silent.
   *
   * Still deliberately fire-and-forget: pushEvent is called from deep inside
   * tick() (29 call sites) and making it await would serialise a transaction
   * behind every alarm. The promise is tracked so it can be flushed by tests
   * and cannot produce an unhandled rejection.
   */
  private pushEvent(siteId: string, kind: string, message: string, meta?: Record<string, unknown>) {
    this.events.unshift({ id: uid("ev"), siteId, kind, message, ts: this.now, meta });
    if (this.events.length > MAX_EVENTS) this.events.pop();

    const site = this.sites.find((s) => s.id === siteId);
    if (!site) {
      // No site means no tenant to scope the write with, and withTenant refuses
      // to guess one. Say so rather than dropping the row silently.
      console.error(
        `[engine] pushEvent: site ${siteId} not in engine state — "${kind}" event NOT persisted: ${message}`,
      );
      return;
    }

    const persist = withTenant(site.tenantId, (tx) =>
      tx.siteEvent.create({
        data: {
          tenantId: site.tenantId,
          siteId,
          kind,
          message,
          meta: meta ? JSON.stringify(meta) : null,
        },
      }),
    ).catch((err: unknown) => {
      console.error(
        `[engine] pushEvent FAILED site=${siteId} tenant=${site.tenantId} kind="${kind}": ${message}`,
        err,
      );
    });

    this.trackBackgroundWrite(persist);
  }

  /**
   * In-flight fire-and-forget writes. Tracked so `flushBackgroundWrites()` can
   * await them (tests, shutdown) and so no write is ever an unobserved promise.
   */
  private backgroundWrites = new Set<Promise<void>>();

  private trackBackgroundWrite(p: Promise<void>): void {
    this.backgroundWrites.add(p);
    void p.finally(() => this.backgroundWrites.delete(p));
  }

  /** Await every outstanding fire-and-forget write. Test / shutdown helper. */
  async flushBackgroundWrites(): Promise<void> {
    // Snapshot the Set: handlers remove themselves as they settle, so walking
    // the live Set across an await could skip entries added in the meantime.
    await Promise.allSettled([...this.backgroundWrites]);
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
    // Load SCOPE, not just the returned slice. Previously this called
    // `ensureInit()` with no argument, which loaded every tenant into memory
    // and then filtered the result. That put a whole platform's assets in
    // process memory for a single tenant's request — and, because the
    // unfiltered load previously returned zero rows under RLS, it was also
    // how an empty platform masqueraded as an empty tenant.
    //
    // A non-null tenantId now scopes the LOAD itself, so only that tenant's
    // rows are ever resident. `null` remains the deliberate cross-tenant
    // escape hatch for super-admin / the realtime service.
    await this.ensureInit(tenantId ? [tenantId] : undefined);

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
