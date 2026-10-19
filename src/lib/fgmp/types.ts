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
