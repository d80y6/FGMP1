// FGMP shared types — used across engine, API, and UI.

import type { Prisma } from "@prisma/client";

export type Role =
  | "SUPERADMIN"
  | "ADMIN"
  | "NOC_OPERATOR"
  | "REGIONAL_MANAGER"
  | "FIELD_ENGINEER"
  | "EXECUTIVE"
  | "READONLY";

export type GenStatus = "RUNNING" | "STOPPED" | "FAULT" | "MAINTENANCE" | "OFFLINE";
export type GenMode = "AUTO" | "MANUAL" | "REMOTE";
export type GenCommand = "START" | "STOP" | "EMERGENCY_STOP" | "RESET";

export type AlarmType =
  | "FUEL_THEFT"
  | "FUEL_REFILL"
  | "FUEL_LOW"
  | "FUEL_CRITICAL"
  | "GEN_OFFLINE"
  | "GEN_FAILURE"
  | "GEN_OVERHEAT"
  | "BATT_LOW_VOLTAGE"
  | "BATT_FAILURE"
  | "COMM_LOSS"
  | "DISPENSER_FAULT";

export type Severity = "L1" | "L2" | "L3";
export type AlarmStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "ESCALATED";

export interface TankState {
  id: string;
  siteId: string;
  label: string;
  fuelType: string;
  capacity: number;
  current: number;
  low: number;
  critical: number;
  status: string;
  lastReadingAt: number;
  history: { t: number; l: number }[];
  prevLevel: number;
  theftDetectedAt?: number;
}

export interface GenState {
  id: string;
  siteId: string;
  label: string;
  manufacturer: string;
  model: string;
  ratedPowerKw: number;
  status: GenStatus;
  mode: GenMode;
  runtimeHours: number;
  temperatureC: number;
  oilPressureKpa: number;
  loadKw: number;
  fuelRateLph: number;
  batteryVoltage: number;
  oilChangeIntervalHrs: number;
  lastOilChangeHrs: number;
  nextMaintenanceHrs: number;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  lastReadingAt: number;
  history: { t: number; temp: number; load: number; runtime: number; rate: number }[];
  faultUntil?: number;
}

export interface BattState {
  id: string;
  siteId: string;
  label: string;
  chemistry: string;
  capacityAh: number;
  nominalVoltage: number;
  voltage: number;
  currentA: number;
  stateOfCharge: number;
  stateOfHealth: number;
  temperatureC: number;
  charging: boolean;
  status: string;
  installedAt: number;
  lastReadingAt: number;
  /**
   * Signed cell-to-cell imbalance in millivolts, or null when unmeasured.
   *
   * `number | null` rather than a numeric sentinel because 0 is a REAL and
   * healthy value: a perfectly balanced string reports exactly 0 mV, and
   * defaulting to 0 would make "no BMS reported" indistinguishable from
   * "every cell agrees", which is the one thing an operator most needs to know.
   */
  cellBalanceMv?: number | null;
  history: { t: number; v: number; soc: number }[];
}

export interface SiteState {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  regionId: string;
  region: string;
  governorateId: string;
  governorate: string;
  districtId: string;
  district: string;
  latitude: number;
  longitude: number;
  address: string;
  status: string;
  criticality: string;
  loadKw: number;
  powerSource: string;
  gridAvailable: boolean;
  commLossUntil?: number;
}

export interface IoTDeviceState {
  id: string;
  siteId: string;
  name: string;
  type: string;
  protocol: string;
  vendor: string;
  serialNo: string;
  firmware: string;
  ipAddress?: string;
  modbusUnit?: number;
  status: string;
  lastSeenAt: number;
  signalRssi: number;
  otaTargetFw?: string;
  otaStatus?: string;
}

export type DispenserStatus = "IDLE" | "AUTHORIZED" | "DISPENSING" | "STOPPED" | "FAULT" | "MAINTENANCE" | "OFFLINE";
export type DispenserMode = "AUTO" | "MANUAL" | "LOCKED";
export interface DispenserState {
  id: string;
  siteId: string;
  label: string;
  manufacturer: string;
  model: string;
  nozzleCount: number;
  fuelType: string; // DIESEL | PETROL
  maxFlowLpm: number;
  status: DispenserStatus;
  mode: DispenserMode;
  // ESP controller
  espDeviceId: string;
  espFirmware: string;
  rs485Baudrate: number;
  rs485Address: number;
  rs485Parity: string;
  wifiRssi: number;
  ipAddress?: string;
  // MAC of the industrial controller (proposal §8.17 pump card).
  macAddress?: string;
  lastCommAt: number;
  // Live telemetry
  currentVolumeLitres: number;
  presetVolumeLitres?: number;
  flowRateLpm: number;
  totalizerLitres: number;
  currentTransactionId?: string;
  lastTransactionAt?: number;
  tempC: number;
  // Internal
  startedAt?: number;          // epoch ms when current in-progress txn started
  targetVolumeLitres?: number; // internal: target volume for current txn
  // Internal: epoch ms of the last accepted control command. Enforces
  // the cooldown safety guarantee (proposal feature 23) so a command
  // storm cannot toggle the pump faster than the fieldbus can honour.
  lastCommandAt?: number;
  // Internal: true after EMERGENCY_STOP until an operator RESETs the
  // unit. While latched the pump refuses AUTHORIZE/START — the
  // emergency stop is not a plain stop, it is a fault latch.
  emergencyLatched?: boolean;
  // Internal: transient flag set by applyEspReboot() to model an ESP
  // controller restart. While set the dispenser reads OFFLINE; the tick
  // clears it (mirrors GatewayState.rebootingUntil).
  rebootingUntil?: number;
  history: { t: number; flow: number; vol: number }[];
}

/**
 * The ten remote control commands of proposal feature 23.
 * Mirrored by the Zod enum in lib/fgmp/schemas.ts and the
 * button set in the dispensers view.
 */
export type DispenserCommand =
  | "AUTHORIZE"
  | "DEAUTHORIZE"
  | "START"
  | "STOP"
  | "EMERGENCY_STOP"
  | "RESET"
  | "LOCK"
  | "UNLOCK"
  | "SET_LIMIT"
  | "RESET_COUNTER";

export type FuelTransactionStatus = "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "FAILED";

export interface FuelTransactionState {
  id: string;
  dispenserId: string;
  siteId: string;
  nozzle: number;
  volumeLitres: number;
  /**
   * Monetary columns are PostgreSQL `numeric` (Phase 1 step 9), so Prisma
   * returns Decimal rather than number. These stay Decimal in engine state and
   * must be converted with `toJsonNumber()` from ./decimal at any JSON
   * boundary — passing a Decimal straight to JSON.stringify emits a STRING and
   * silently changes the API contract.
   */
  amountYer: Prisma.Decimal;
  unitPriceYer: Prisma.Decimal;
  vehiclePlate?: string;
  operatorName?: string;
  status: FuelTransactionStatus;
  startedAt: number;
  completedAt?: number;
  durationSec: number;
  /**
   * Cumulative pump counter (totalizer) at completion — the
   * عدّاد column of the proposal's fill-operations table.
   * Decimal like the other money/volume columns.
   */
  totalizerLitres?: Prisma.Decimal;
}

export interface EventItem {
  id: string;
  siteId: string;
  kind: string;
  message: string;
  ts: number;
  meta?: Record<string, unknown>;
}

// ──────────────────────────────────────────────────────────────────────────
// Site Gateway live state (Task 48)
// ──────────────────────────────────────────────────────────────────────────
// In-memory mirror of the SiteGateway DB row. The DB row holds the
// last-persisted values; the engine tick simulates small live fluctuations
// (cpuTempC, heapKb, wifiRssi, uptimeSec increment) so the dashboard sees
// fresh gateway health on every refresh without waiting for the periodic
// 5-tick persistence.
//
// status: ONLINE | OFFLINE | DEGRADED
export type GatewayStatus = "ONLINE" | "OFFLINE" | "DEGRADED";

export interface GatewayState {
  id: string;
  siteId: string;
  hostname: string;
  model?: string;
  ipAddress?: string;
  status: GatewayStatus;
  uptimeSec: number;
  cpuTempC: number;
  heapKb: number;
  wifiRssi: number;
  lastSeenAt: number;
  // Internal: transient flag set by applyGatewayReboot() to flip status to
  // DEGRADED then back to ONLINE after ~20s of ticks.
  rebootingUntil?: number;
}

export interface Kpis {
  totalSites: number;
  onlineSites: number;
  degradedSites: number;
  offlineSites: number;
  totalTanks: number;
  totalFuelLitres: number;
  totalFuelCapacity: number;
  fuelPct: number;
  tanksCritical: number;
  tanksLow: number;
  generatorsRunning: number;
  generatorsTotal: number;
  generatorsFault: number;
  batteriesLow: number;
  openAlarms: number;
  alarmsL1: number;
  alarmsL2: number;
  alarmsL3: number;
  pendingDeliveries: number;
  openTickets: number;
  avgSiteHealth: number;
  fuelConsumedTodayL: number;
  generatorHoursToday: number;
  // Dispensers (Task 34-B)
  dispensersTotal: number;
  dispensersDispensing: number;
  dispensersFault: number;
  dispenserTransactionsToday: number;
  dispenserVolumeTodayL: number;
}

export interface Snapshot {
  now: number;
  tickCount: number;
  kpis: Kpis;
  sites: SiteState[];
  tanks: TankState[];
  generators: GenState[];
  batteries: BattState[];
  iotDevices: IoTDeviceState[];
  dispensers: DispenserState[];
  fuelTransactions: FuelTransactionState[];
  events: EventItem[];
  gateways: GatewayState[];
  regions: { id: string; name: string; governorates: { id: string; name: string; districts: { id: string; name: string }[] }[] }[];
}

/**
 * An alarm as `/api/fgmp/alarms` returns it: the Prisma row plus the fields the
 * UI reads, with dates already serialised to ISO strings by `NextResponse.json`.
 *
 * Declared once, here, because four views fetch that endpoint. Each previously
 * typed its own `useApi<any[]>` and then re-annotated every callback parameter
 * as `any`, which meant a renamed column was a runtime `undefined` rather than
 * a compile error. Optional fields are optional because they are nullable in
 * the schema (`acknowledgedAt`, `resolvedAt`, the joined `site`).
 */
export interface AlarmRow {
  id: string;
  siteId: string;
  type: string;
  severity: Severity;
  status: string;
  message: string;
  createdAt: string;
  escalationLevel: number;
  value?: number | null;
  threshold?: number | null;
  acknowledgedAt?: string | null;
  acknowledgedById?: string | null;
  resolvedAt?: string | null;
  resolvedById?: string | null;
  resolution?: string | null;
  /**
   * Always present: the route joins it with `include` and drops any row whose
   * site did not resolve inside the tenant, so a null here would mean an empty
   * list rather than a half-populated alarm.
   */
  site?: { name: string; code: string };
}

/** A fuel delivery as `/api/fgmp/deliveries` and site detail return it. */
export interface MaintenanceTicketRow {
  id: string;
  siteId: string;
  title: string;
  status: string;
  /** Required by the gantt, which indexes its tone maps by these. */
  type: string;
  assetKind: string;
  assetId: string;
  priority: string;
  description?: string | null;
  notes?: string | null;
  scheduledFor?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  assignedToId?: string | null;
  assignedTo?: { name?: string } | null;
  site?: { name: string; code?: string } | null;
}

export interface DeliveryRow {
  id: string;
  siteId: string;
  status: string;
  supplier?: string | null;
  scheduledAt: string;
  volumeOrderedLitres: number;
  volumeDeliveredLitres?: number | null;
  doNumber?: string | null;
  vehiclePlate?: string | null;
  driverName?: string | null;
  site?: { name: string } | null;
  tank?: { label?: string | null } | null;
}

/**
 * `GET /api/fgmp/sites/[id]` — the site plus its children, assembled from live
 * engine state (tanks/generators/batteries/iot) and the child tables
 * (alarms/deliveries/tickets). `site` is optional because the engine lookup can
 * miss a row that exists in the database.
 */
export interface SiteDetailPayload {
  site?: SiteState;
  tanks: TankState[];
  generators: GenState[];
  batteries: BattState[];
  iot: IoTDeviceState[];
  alarms: AlarmRow[];
  deliveries: DeliveryRow[];
  tickets: MaintenanceTicketRow[];
}

/** One region row of `GET /api/fgmp/analytics` (also the leaderboard's shape). */
export interface RegionBreakdownRow {
  region: string;
  sites: number;
  fuel: number;
  alarms: number;
  running: number;
  consumed: number;
  /** Null when no tank in the region has usable capacity. */
  fuelPct: number | null;
}

/**
 * `GET /api/fgmp/analytics` — only the fields the UI reads are declared. The
 * endpoint returns more (generator-hours detail, projection meta, the cost
 * basis strings); adding a field here is how a view earns the right to read it.
 *
 * Currency fields are `number | null` on purpose: they are null whenever no
 * FX/fuel rate is configured, which is a different statement from "$0".
 */
export interface AnalyticsPayload {
  consumptionTrend: { t: string; litres: number; running: number }[];
  siteEfficiency: {
    siteId: string;
    site: string;
    code: string;
    region: string;
    consumed: number;
    kwh: number;
    efficiency: number;
    fuelPct: number;
  }[];
  theftEvents: EventItem[];
  refillEvents: EventItem[];
  forecast: { day: string; litres: number }[];
  regionBreakdown: RegionBreakdownRow[];
  fuelCost: {
    pricePerLitre: number | null;
    currency: "USD";
    pricePerLitreYer: number | null;
    fxRate: number | null;
    fxAsOf: string | null;
    currencyAvailable: boolean;
    consumedTodayUsd: number | null;
    stolenValueUsd: number | null;
    deliveredValueUsd: number | null;
    theftLitres: number;
    forecastCostUsd: number | null;
    costByRegion: {
      region: string;
      costUsd: number | null;
      fuelStockOnHandPct: number | null;
      consumedLitres: number;
      consumedCostUsd: number | null;
      sites: number;
    }[];
    dailyCost: {
      day: string;
      dateKey: string | null;
      litres: number | null;
      cost: number | null;
      samples: number;
    }[];
  };
  siteHealth: {
    overall: number;
    factors: { label: string; value: number; weight: number; icon: string; good: boolean }[];
  };
}

/** A row of `GET /api/fgmp/audit`; `details` is parsed JSON, not a string. */
export interface AuditLogRow {
  id: string;
  action: string;
  entity: string;
  entityId?: string | null;
  details: unknown;
  user?: { name: string; role: string } | null;
  ip?: string | null;
  createdAt: string;
}

/** An IoT device with the site name the list view searches on. */
export interface IoTDeviceRow extends IoTDeviceState {
  site?: { name: string } | null;
  /** The status the list view renders; present on every GET row. */
  liveStatus: string;
}

/** A row of `GET /api/fgmp/reports`. */
export interface ReportsPayload {
  summary: {
    period: string;
    from: string;
    to: string;
    totalSites: number;
    totalGenerators: number;
    totalTanks: number;
    totalFuelLitres: number;
    totalCapacityLitres: number;
    fuelPct: number;
    alarmsTotal: number;
    alarmsBySeverity: { L1: number; L2: number; L3: number };
    deliveriesTotal: number;
    deliveriesVerified: number;
    volumeDelivered: number;
    ticketsTotal: number;
    ticketsDone: number;
    commandsTotal: number;
    generatorsRunning: number;
  };
  alarms: AlarmRow[];
  deliveries: DeliveryRow[];
  tickets: MaintenanceTicketRow[];
  commands: { id: string; command: string; status: string; issuedAt: string; generator?: { label: string } | null }[];
  auditLogs: AuditLogRow[];
}
