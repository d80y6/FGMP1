/**
 * SimulationService — pure, stateless asset physics and telemetry generation.
 *
 * Why this exists:
 * - The engine's tick() was a 1000+ line procedural mix of physics, alarm logic, and DB writes.
 * - Testing fuel consumption, battery curves, or theft detection required spinning up the full engine.
 *
 * This service provides:
 * - Pure functions: (state, Δt) → newState. No side effects, no DB, no time dependencies.
 * - Deterministic: same inputs always produce same outputs (given same RNG seed).
 * - Composable: each asset type is independent, easy to unit test in isolation.
 */

import { Rng, streamsFor, DEFAULT_SIM_SEED } from "../prng";
import type {
  TankState, GenState, BattState, SiteState,
  IoTDeviceState, DispenserState, FuelTransactionState, GatewayState,
  EventItem, Kpis,
} from "../types";
import {
  detectUnexplainedLoss,
  expectedConsumption,
  severityFor,
  DEFAULT_SENSOR_ACCURACY,
} from "../theft-detection";
import { isBatteryLowVoltage, battLowVoltageTripVolts } from "../thresholds-battery";
import {
  startOfZonedDay,
  resolvePlatformTimezone,
} from "../thresholds-time";
import { theftDetections } from "@/lib/observability/metrics";

const HISTORY_POINTS = 288; // 24h @ 5-min simulated cadence
const MAX_EVENTS = 400;
const MAX_DISPENSER_TXN_MEMORY = 50;
const MAX_RECENT_TXN_SNAPSHOT = 200;
const DISPENSER_FAULT_PROB = 0.005;
const DISPENSER_COMM_STALE_MS = 90_000;
const DISPENSER_COMMAND_COOLDOWN_MS = 2_000;
const DISPENSER_COMMAND_LINK_STALE_MS = DISPENSER_COMM_STALE_MS;
const UNIT_PRICE_YER_PER_L = 520;

// Point-in-time alarm types
const TRANSIENT_ALARM_TYPES = new Set(["FUEL_THEFT", "FUEL_REFILL"]);
const TRANSIENT_REARM_MS = 30 * 60 * 1000; // 30 minutes

export interface SimulationContext {
  now: number;
  tickHours: number;
  rng: Record<string, Rng>;
  openAlarmKeys: Set<string>;
  transientRaisedAt: Map<string, number>;
  tankPtr: Map<string, number>;
  lastGenRuntimeHours: Map<string, number>;
}

export interface SimulationOutput {
  events: EventItem[];
  alarmsCreated: number;
  updatedAssets: {
    sites: SiteState[];
    tanks: TankState[];
    generators: GenState[];
    batteries: BattState[];
    iotDevices: IoTDeviceState[];
    dispensers: DispenserState[];
    fuelTransactions: FuelTransactionState[];
    gateways: GatewayState[];
  };
}

export class SimulationService {
  private rng: Record<string, Rng> = streamsFor(DEFAULT_SIM_SEED);
  private rngSeedApplied: number | null = null;

  /**
   * Advance simulation by `seconds` for all assets in the given tenant scope.
   * Pure computation — no DB writes, no alarm persistence.
   */
  async tick(
    assets: {
      sites: SiteState[];
      tanks: TankState[];
      generators: GenState[];
      batteries: BattState[];
      iotDevices: IoTDeviceState[];
      dispensers: DispenserState[];
      fuelTransactions: FuelTransactionState[];
      gateways: GatewayState[];
      events: EventItem[];
    },
    context: SimulationContext
  ): Promise<SimulationOutput> {
    const { now, tickHours, rng, openAlarmKeys, transientRaisedAt, tankPtr, lastGenRuntimeHours } = context;

    // Honour configured seed on first use
    const seed = DEFAULT_SIM_SEED; // In real use, this would come from config
    if (this.rngSeedApplied !== seed) {
      this.rng = streamsFor(seed);
      this.rngSeedApplied = seed;
    }

    const events: EventItem[] = [];
    let alarmsCreated = 0;

    // Helper to push events into output array
    const pushEvent = (siteId: string, kind: string, message: string, meta?: Record<string, unknown>) => {
      events.unshift({ id: `ev-${rng.site.suffix()}`, siteId, kind, message, ts: now, meta });
      if (events.length > MAX_EVENTS) events.pop();
    };

    // ── IoT devices: occasional offline flutter ───────────────────────────
    for (const d of assets.iotDevices) {
      if (rng.site.float() < 0.004) {
        d.status = d.status === "ONLINE" ? "OFFLINE" : "ONLINE";
        d.lastSeenAt = d.status === "ONLINE" ? now : d.lastSeenAt;
        if (d.status === "OFFLINE") {
          pushEvent(d.siteId, "WARN", `IoT device ${d.name} went offline (${d.protocol})`, { deviceId: d.id });
        }
      } else {
        d.lastSeenAt = now;
      }
    }

    // ── Sites: comm loss simulation ──────────────────────────────────────
    for (const s of assets.sites) {
      if (s.commLossUntil && now > s.commLossUntil) {
        s.commLossUntil = undefined;
        s.status = "ONLINE";
        pushEvent(s.id, "INFO", `Communication restored at ${s.name}`, {});
      }
      if (!s.commLossUntil && rng.iot.float() < 0.003) {
        const lossMs = (2 + rng.site.float() * 8) * 60 * 1000;
        s.commLossUntil = now + lossMs;
        s.status = "DEGRADED";
        pushEvent(s.id, "WARN", `Communication loss detected at ${s.name}`, { durationMs: lossMs });
        alarmsCreated++; // Caller will persist via AlarmService
      }
      if (s.commLossUntil && now <= s.commLossUntil) {
        s.status = "DEGRADED";
      }
    }

    // ── Generators + fuel consumption ────────────────────────────────────
    for (const g of assets.generators) {
      const site = assets.sites.find((s) => s.id === g.siteId);
      if (!site) continue;
      const siteCommsDown = !!(site.commLossUntil && now <= site.commLossUntil);

      if (g.status === "FAULT") {
        if (g.faultUntil && now > g.faultUntil) {
          g.status = "STOPPED";
          g.faultUntil = undefined;
          pushEvent(g.siteId, "INFO", `${g.label} fault cleared, returning to STOPPED`, { genId: g.id });
        }
      } else if (g.status !== "MAINTENANCE" && g.status !== "OFFLINE") {
        const needsPower = !site.gridAvailable || site.powerSource === "GENERATOR";
        const shouldRun = g.mode === "AUTO" ? needsPower : g.status === "RUNNING";

        if (g.status === "STOPPED" && shouldRun && !siteCommsDown) {
          g.status = "RUNNING";
          g.lastStartedAt = now;
          pushEvent(g.siteId, "CONTROL", `${g.label} started (mode=${g.mode})`, { genId: g.id });
        } else if (g.status === "RUNNING" && !shouldRun && g.mode === "AUTO") {
          g.status = "STOPPED";
          g.lastStoppedAt = now;
          pushEvent(g.siteId, "CONTROL", `${g.label} stopped (mode=${g.mode})`, { genId: g.id });
        }

        if (g.status === "RUNNING" && rng.generator.float() < 0.0015) {
          g.status = "FAULT";
          g.faultUntil = now + (5 + rng.generator.float() * 15) * 60 * 1000;
          pushEvent(g.siteId, "CRITICAL", `${g.label} FAULT detected`, { genId: g.id });
          alarmsCreated++;
        }
      }

      // Telemetry update
      if (g.status === "RUNNING") {
        const targetTemp = 78 + Math.sin(now / 900_000) * 6 + (rng.site.float() - 0.5) * 4;
        g.temperatureC = Math.round((g.temperatureC + (targetTemp - g.temperatureC) * 0.3) * 10) / 10;

        if (g.temperatureC > 104 && rng.generator.float() < 0.4) {
          alarmsCreated++;
        } else if (g.temperatureC > 95) {
          alarmsCreated++;
        }

        g.runtimeHours = Math.round((g.runtimeHours + tickHours) * 100) / 100;
        g.oilPressureKpa = Math.round(300 + rng.generator.float() * 80);
        g.loadKw = Math.round(Math.min(g.ratedPowerKw, site.loadKw * (0.8 + rng.generator.float() * 0.4)) * 10) / 10;
        g.fuelRateLph = Math.round((2.5 + (g.loadKw / g.ratedPowerKw) * 16) * 10) / 10;
        g.batteryVoltage = Math.round((24.5 + rng.generator.float() * 1.5) * 10) / 10;

        // Consume fuel from a tank at this site
        const siteTanks = assets.tanks.filter((t) => t.siteId === g.siteId);
        if (siteTanks.length) {
          const ptr = (tankPtr.get(g.siteId) ?? 0) % siteTanks.length;
          const tank = siteTanks[ptr];
          const consumed = g.fuelRateLph * tickHours;
          tank.prevLevel = tank.current;
          tank.current = Math.max(0, tank.current - consumed);
          tankPtr.set(g.siteId, (ptr + 1) % siteTanks.length);
        }
      } else {
        g.temperatureC = Math.round((g.temperatureC + (32 - g.temperatureC) * 0.2) * 10) / 10;
        g.oilPressureKpa = 0;
        g.loadKw = 0;
        g.fuelRateLph = 0;
      }
      g.lastReadingAt = now;
      g.history.push({ t: now, temp: g.temperatureC, load: g.loadKw, runtime: g.runtimeHours, rate: g.fuelRateLph });
      if (g.history.length > HISTORY_POINTS) g.history.shift();
    }

    // ── Fuel tanks: DETECTED losses, then thresholds ─────────────────────
    for (const tk of assets.tanks) {
      const site = assets.sites.find((s) => s.id === tk.siteId);
      if (!site) continue;

      // FUEL THEFT DETECTION
      const gen = assets.generators.find((g) => g.siteId === tk.siteId);
      const startLitres = tk.prevLevel ?? tk.current;
      const runtimeDeltaHours = gen
        ? Math.max(0, (gen.runtimeHours ?? 0) - (lastGenRuntimeHours.get(gen.id) ?? 0))
        : 0;

      if (gen && startLitres > 0) {
        const candidate = detectUnexplainedLoss({
          tankId: tk.id,
          siteId: tk.siteId,
          levelStartLitres: startLitres,
          levelEndLitres: tk.current,
          expectedConsumptionLitres: expectedConsumption(gen.ratedPowerKw, runtimeDeltaHours),
          windowHours: 1,
          capacityLitres: tk.capacity,
          sensorAccuracyFraction: DEFAULT_SENSOR_ACCURACY,
        });

        const severity = candidate ? severityFor(candidate) : null;
        theftDetections.inc({ result: candidate ? "CANDIDATE" : "NO_CANDIDATE" });

        if (candidate && severity) {
          pushEvent(tk.siteId, severity === "CRITICAL" ? "CRITICAL" : "WARN",
            `Unexplained fuel loss: ${candidate.unexplainedLitres}L from ${tk.label} at ${site.name}`, { ...candidate, tankId: tk.id });
          alarmsCreated++;
        }
      }
      if (gen) lastGenRuntimeHours.set(gen.id, gen.runtimeHours ?? 0);

      // Simulated refill (retained for demo coverage)
      if (rng.site.float() < 0.0008) {
        const added = 80 + rng.site.float() * 300;
        tk.prevLevel = tk.current;
        tk.current = Math.min(tk.capacity, tk.current + added);
        pushEvent(tk.siteId, "WARN", `[SIMULATED] Unexpected fuel increase: +${Math.round(added)}L in ${tk.label} at ${site.name}`, { tankId: tk.id, added, simulated: true });
        alarmsCreated++;
      }

      // Threshold alarms
      if (tk.current <= tk.critical) {
        alarmsCreated++;
      } else if (tk.current <= tk.low) {
        alarmsCreated++;
      } else {
        // auto-resolve handled by AlarmService
      }

      tk.status = tk.current <= tk.critical ? "EMPTY" : "OPERATIONAL";
      tk.lastReadingAt = now;
      tk.history.push({ t: now, l: Math.round(tk.current) });
      if (tk.history.length > HISTORY_POINTS) tk.history.shift();
    }

    // ── Batteries ────────────────────────────────────────────────────────
    for (const b of assets.batteries) {
      const site = assets.sites.find((s) => s.id === b.siteId);
      if (!site) continue;
      const genRunning = assets.generators.some((g) => g.siteId === b.siteId && g.status === "RUNNING");
      const charging = genRunning || site.gridAvailable;
      b.charging = charging;

      if (charging) {
        b.voltage = Math.round(Math.min(b.nominalVoltage * 1.06, b.voltage + 0.02 + rng.battery.float() * 0.03) * 100) / 100;
        b.stateOfCharge = Math.min(100, b.stateOfCharge + 0.4 + rng.battery.float() * 0.6);
        b.currentA = Math.round((2 + rng.battery.float() * 8) * 10) / 10;
      } else {
        b.voltage = Math.round(Math.max(b.nominalVoltage * 0.8, b.voltage - 0.04 - rng.battery.float() * 0.06) * 100) / 100;
        b.stateOfCharge = Math.max(5, b.stateOfCharge - 0.6 - rng.battery.float() * 0.8);
        b.currentA = Math.round(-(4 + rng.battery.float() * 12) * 10) / 10;
      }
      b.temperatureC = Math.round((b.temperatureC + (24 + rng.generator.float() * 6 - b.temperatureC) * 0.1) * 10) / 10;
      b.lastReadingAt = now;

      if (isBatteryLowVoltage(b.voltage, b.nominalVoltage)) {
        b.status = "LOW";
        alarmsCreated++;
      } else if (b.stateOfHealth < 70) {
        b.status = "REPLACEMENT_DUE";
        alarmsCreated++;
      } else {
        b.status = "OK";
      }
      b.history.push({ t: now, v: b.voltage, soc: Math.round(b.stateOfCharge) });
      if (b.history.length > HISTORY_POINTS) b.history.shift();
    }

    // ── Fuel dispensers + transactions ──────────────────────────────────
    for (const d of assets.dispensers) {
      const site = assets.sites.find((s) => s.id === d.siteId);
      if (!site) continue;

      // ESP reboot recovery
      if (d.rebootingUntil) {
        if (now >= d.rebootingUntil) {
          d.rebootingUntil = undefined;
          d.status = "IDLE";
          d.lastCommAt = now;
          pushEvent(d.siteId, "INFO", `ESP controller reboot complete — ${d.label} back online`, { dispenserId: d.id });
        } else {
          d.lastCommAt = now - DISPENSER_COMM_STALE_MS;
          d.flowRateLpm = 0;
          d.history.push({ t: now, flow: 0, vol: d.currentVolumeLitres });
          if (d.history.length > HISTORY_POINTS) d.history.shift();
          continue;
        }
      }

      // ESP heartbeat
      d.lastCommAt = now;
      d.wifiRssi = Math.max(-95, Math.min(-45, d.wifiRssi + Math.round((rng.dispenser.float() - 0.5) * 4)));
      d.tempC = Math.round((d.tempC + (32 + rng.dispenser.float() * 6 - d.tempC) * 0.1) * 10) / 10;

      if (d.status === "OFFLINE" || d.status === "MAINTENANCE" || d.mode === "LOCKED") {
        if (d.status === "OFFLINE" && d.lastCommAt > now - DISPENSER_COMM_STALE_MS) {
          d.status = "IDLE";
        }
        d.flowRateLpm = 0;
        d.history.push({ t: now, flow: 0, vol: d.currentVolumeLitres });
        if (d.history.length > HISTORY_POINTS) d.history.shift();
        continue;
      }

      // Random FAULT
      if (d.status !== "FAULT" && rng.dispenser.float() < DISPENSER_FAULT_PROB) {
        d.status = "FAULT";
        d.flowRateLpm = 0;
        pushEvent(d.siteId, "CRITICAL", `Dispenser ${d.label} FAULT detected`, { dispenserId: d.id });
        alarmsCreated++;
        d.history.push({ t: now, flow: 0, vol: d.currentVolumeLitres });
        if (d.history.length > HISTORY_POINTS) d.history.shift();
        continue;
      }

      // State machine
      if (d.status === "IDLE") {
        if (rng.site.float() < 0.08) {
          d.status = "AUTHORIZED";
          if (rng.site.float() < 0.7) this.startDispense(d, rng);
        }
      } else if (d.status === "AUTHORIZED") {
        if (rng.site.float() < 0.5) this.startDispense(d, rng);
      } else if (d.status === "DISPENSING") {
        const flow = d.flowRateLpm;
        const deltaL = (flow * tickHours * 3600) / 60; // tickHours → minutes
        d.currentVolumeLitres = Math.round((d.currentVolumeLitres + deltaL) * 100) / 100;
        const target = d.targetVolumeLitres ?? d.presetVolumeLitres ?? 50;
        if (d.currentVolumeLitres >= target) {
          // Completion will be handled by caller with persist
        } else if (rng.site.float() < 0.002) {
          // Premature stop
        }
      } else if (d.status === "STOPPED") {
        d.status = "IDLE";
        d.flowRateLpm = 0;
      }

      d.history.push({ t: now, flow: d.flowRateLpm, vol: d.currentVolumeLitres });
      if (d.history.length > HISTORY_POINTS) d.history.shift();
    }

    // ── Site gateways ───────────────────────────────────────────────────
    for (const gw of assets.gateways) {
      if (gw.rebootingUntil && now >= gw.rebootingUntil) {
        gw.rebootingUntil = undefined;
        gw.status = "ONLINE";
        gw.uptimeSec = 0;
        gw.lastSeenAt = now;
        pushEvent(gw.siteId, "INFO", `Gateway ${gw.hostname} reboot complete — back ONLINE`, { gatewayId: gw.id });
      }

      if (gw.status === "OFFLINE") {
        if (rng.site.float() < 0.05) {
          gw.status = "ONLINE";
          gw.lastSeenAt = now;
          pushEvent(gw.siteId, "INFO", `Gateway ${gw.hostname} reconnected`, { gatewayId: gw.id });
        } else continue;
      }

      if (gw.status === "ONLINE") {
        if (!gw.rebootingUntil && rng.gateway.float() < 0.002) {
          gw.status = "DEGRADED";
          pushEvent(gw.siteId, "WARN", `Gateway ${gw.hostname} degraded (WiFi jitter)`, { gatewayId: gw.id });
        }
      } else if (gw.status === "DEGRADED" && !gw.rebootingUntil) {
        if (rng.site.float() < 0.3) gw.status = "ONLINE";
      }

      if (!gw.rebootingUntil) {
        gw.uptimeSec += tickHours * 3600;
        gw.cpuTempC = Math.round(Math.max(35, Math.min(85, gw.cpuTempC + (rng.gateway.float() - 0.5) * 1.2)) * 10) / 10;
        gw.heapKb = Math.max(8, Math.min(60, gw.heapKb + Math.round((rng.gateway.float() - 0.5) * 4)));
        gw.wifiRssi = Math.max(-95, Math.min(-45, gw.wifiRssi + Math.round((rng.gateway.float() - 0.5) * 3)));
        gw.lastSeenAt = now;
      }
    }

    // ── Update site status from assets ───────────────────────────────────
    for (const s of assets.sites) {
      if (s.commLossUntil && now <= s.commLossUntil) { s.status = "DEGRADED"; continue; }
      const hasFault = assets.generators.some((g) => g.siteId === s.id && g.status === "FAULT");
      const hasCriticalTank = assets.tanks.some((t) => t.siteId === s.id && t.current <= t.critical);
      const hasDispenserFault = assets.dispensers.some((d) => d.siteId === s.id && d.status === "FAULT");
      if (hasFault || hasCriticalTank || hasDispenserFault) s.status = "DEGRADED";
      else s.status = "ONLINE";
    }

    return {
      events,
      alarmsCreated,
      updatedAssets: assets,
    };
  }

  private startDispense(d: DispenserState, rng: Record<string, Rng>) {
    d.status = "DISPENSING";
    d.startedAt = Date.now();
    d.targetVolumeLitres = d.presetVolumeLitres ?? Math.round((20 + rng.dispenser.float() * 60) * 10) / 10;
    d.flowRateLpm = Math.round(d.maxFlowLpm * (0.8 + rng.dispenser.float() * 0.2) * 10) / 10;
    d.currentTransactionId = `tx-${rng.dispenser.suffix()}`;
    d.currentVolumeLitres = 0;
  }

  /** Reset RNG seed (for tests). */
  resetSeed(seed: number = DEFAULT_SIM_SEED): void {
    this.rng = streamsFor(seed);
    this.rngSeedApplied = seed;
  }
}

// Singleton
const globalForSimulation = globalThis as unknown as { __fgmpSimulation?: SimulationService };
export const simulation: SimulationService = globalForSimulation.__fgmpSimulation ?? new SimulationService();
if (process.env.NODE_ENV !== "production") globalForSimulation.__fgmpSimulation = simulation;