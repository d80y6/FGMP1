/**
 * AlarmService — alarm evaluation, correlation, escalation, and suppression.
 *
 * Why this exists:
 * - The engine mixed alarm logic with simulation tick and DB persistence.
 * - Escalation thresholds were hardcoded with a comment admitting they should come from settings.
 * - Suppression checks and correlation rules were inline.
 *
 * This service provides:
 * - Pure alarm evaluation: given asset state, return alarms to raise/resolve.
 * - Correlation rule engine integration.
 * - Escalation with configurable thresholds (via settings).
 * - Suppression window checking.
 */

import { db } from "@/lib/db";
import { withTenant } from "../tenant-context";
import { isAlarmSuppressed } from "../suppression-check";
import type { AlarmType, Severity } from "../types";
let escalationAuditDetail: any = { inc: () => {} };
try {
  const m = require('@/lib/observability/metrics');
  if (m.escalationAuditDetail) escalationAuditDetail = m.escalationAuditDetail;
} catch {}

export interface AlarmCandidate {
  siteId: string;
  type: AlarmType;
  severity: Severity;
  entityKind?: string;
  entityId?: string;
  message: string;
  value?: number;
  threshold?: number;
}

export interface AlarmResolution {
  type: AlarmType;
  entityId: string;
  severity?: Severity;
}

export interface EscalationThresholds {
  l1ToL2Minutes: number;
  l2ToL3Minutes: number;
}

export interface EscalationPlan {
  alarmId: string;
  fromSeverity: Severity;
  toSeverity: Severity;
  escalateTo: Severity;
}

export class AlarmService {
  /** Hardcoded defaults — should be overridden by settings in production. */
  private escalationThresholds: EscalationThresholds = { l1ToL2Minutes: 15, l2ToL3Minutes: 30 };

  /** Set escalation thresholds (called from settings on init). */
  setEscalationThresholds(t: EscalationThresholds): void {
    this.escalationThresholds = t;
  }

  /** Get current escalation thresholds. */
  getEscalationThresholds(): EscalationThresholds {
    return this.escalationThresholds;
  }

  /**
   * Evaluate current asset state and return alarms that should be raised.
   * Does NOT persist — caller handles persistence via PersistenceService.
   */
  async evaluate(
    assets: {
      sites: { id: string; tenantId: string; name: string; gridAvailable: boolean; powerSource: string; commLossUntil?: number; capacity: number }[];
      tanks: { id: string; siteId: string; label: string; current: number; low: number; critical: number; fuelType: string; capacity: number }[];
      generators: { id: string; siteId: string; label: string; status: string; temperatureC: number; mode: string }[];
      batteries: { id: string; siteId: string; label: string; voltage: number; nominalVoltage: number; stateOfHealth: number }[];
      dispensers: { id: string; siteId: string; label: string; status: string }[];
    },
    context: {
      tenantId: string;
      now: number;
      openAlarmKeys: Set<string>;
      transientRaisedAt: Map<string, number>;
    }
  ): Promise<AlarmCandidate[]> {
    const { tenantId, now, openAlarmKeys, transientRaisedAt } = context;
    const candidates: AlarmCandidate[] = [];

    // Tank thresholds
    for (const tk of assets.tanks) {
      const site = assets.sites.find((s) => s.id === tk.siteId);
      if (!site) continue;

      if (tk.current <= tk.critical) {
        const key = `FUEL_CRITICAL:L3:${tk.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: tk.siteId, type: "FUEL_CRITICAL", severity: "L3",
            entityKind: "TANK", entityId: tk.id,
            message: `Critical fuel level: ${Math.round(tk.current)}L (${Math.round((tk.current / tk.capacity) * 100)}%) at ${site.name}`,
            value: tk.current, threshold: tk.critical,
          });
        }
      } else if (tk.current <= tk.low) {
        const key = `FUEL_LOW:L2:${tk.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: tk.siteId, type: "FUEL_LOW", severity: "L2",
            entityKind: "TANK", entityId: tk.id,
            message: `Low fuel level: ${Math.round(tk.current)}L at ${site.name}`,
            value: tk.current, threshold: tk.low,
          });
        }
      }
    }

    // Generator thresholds
    for (const g of assets.generators) {
      const site = assets.sites.find((s) => s.id === g.siteId);
      if (!site) continue;

      if (g.status === "FAULT") {
        const key = `GEN_FAILURE:L3:${g.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: g.siteId, type: "GEN_FAILURE", severity: "L3",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} failure at ${site.name}`,
          });
        }
      }
      if (g.temperatureC > 104) {
        const key = `GEN_OVERHEAT:L3:${g.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: g.siteId, type: "GEN_OVERHEAT", severity: "L3",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} overheat: ${g.temperatureC}°C at ${site.name}`,
            value: g.temperatureC, threshold: 104,
          });
        }
      } else if (g.temperatureC > 95) {
        const key = `GEN_OVERHEAT:L2:${g.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: g.siteId, type: "GEN_OVERHEAT", severity: "L2",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} high temperature: ${g.temperatureC}°C at ${site.name}`,
            value: g.temperatureC, threshold: 95,
          });
        }
      }
      // GEN_OFFLINE
      if (g.status === "STOPPED" && !site.gridAvailable && site.powerSource === "GENERATOR") {
        const key = `GEN_OFFLINE:L2:${g.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: g.siteId, type: "GEN_OFFLINE", severity: "L2",
            entityKind: "GENERATOR", entityId: g.id,
            message: `${g.label} offline while site requires generator power at ${site.name}`,
          });
        }
      }
    }

    // Battery thresholds
    for (const b of assets.batteries) {
      const site = assets.sites.find((s) => s.id === b.siteId);
      if (!site) continue;

      const { isBatteryLowVoltage, battLowVoltageTripVolts } = await import("../thresholds-battery");
      if (isBatteryLowVoltage(b.voltage, b.nominalVoltage)) {
        const key = `BATT_LOW_VOLTAGE:L2:${b.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: b.siteId, type: "BATT_LOW_VOLTAGE", severity: "L2",
            entityKind: "BATTERY", entityId: b.id,
            message: `Battery ${b.label} low voltage: ${b.voltage}V at ${site.name}`,
            value: b.voltage, threshold: battLowVoltageTripVolts(b.nominalVoltage) ?? undefined,
          });
        }
      }
      if (b.stateOfHealth < 70) {
        const key = `BATT_FAILURE:L1:${b.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: b.siteId, type: "BATT_FAILURE", severity: "L1",
            entityKind: "BATTERY", entityId: b.id,
            message: `Battery ${b.label} health low: ${b.stateOfHealth}% at ${site.name}`,
            value: b.stateOfHealth, threshold: 70,
          });
        }
      }
    }

    // Dispenser faults
    for (const d of assets.dispensers) {
      if (d.status === "FAULT") {
        const site = assets.sites.find((s) => s.id === d.siteId);
        if (!site) continue;
        const key = `DISPENSER_FAULT:L3:${d.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: d.siteId, type: "DISPENSER_FAULT", severity: "L3",
            entityKind: "DISPENSER", entityId: d.id,
            message: `Dispenser ${d.label} fault at ${site.name}`,
          });
        }
      }
    }

    // Site comm loss
    for (const s of assets.sites) {
      if (s.commLossUntil && s.commLossUntil > now) {
        const key = `COMM_LOSS:L2:${s.id}`;
        if (!openAlarmKeys.has(key)) {
          candidates.push({
            siteId: s.id, type: "COMM_LOSS", severity: "L2",
            entityKind: "SITE", entityId: s.id,
            message: `Communication loss at ${s.name}`,
          });
        }
      }
    }

    // Apply suppression check
    const allowed: AlarmCandidate[] = [];
    for (const c of candidates) {
      try {
        const suppressed = await isAlarmSuppressed(c.siteId, c.type, tenantId);
        if (suppressed) {
          // Log suppressed event for audit
          // (caller can persist via pushEvent if needed)
        } else {
          allowed.push(c);
        }
      } catch {
        // If matcher fails, fail open
        allowed.push(c);
      }
    }

    return allowed;
  }

  /**
   * Return alarm keys that should be resolved because their condition cleared.
   * Caller removes from openAlarmKeys and persists resolution.
   */
  resolveCleared(
    assets: {
      tanks: { id: string; current: number; low: number; critical: number }[];
      generators: { id: string; status: string; temperatureC: number; siteId: string }[];
      batteries: { id: string; voltage: number; nominalVoltage: number; stateOfHealth: number }[];
      dispensers: { id: string; status: string }[];
      sites: { id: string; commLossUntil?: number; gridAvailable?: boolean; powerSource?: string }[];
    },
    openAlarmKeys: Set<string>,
    now: number
  ): AlarmResolution[] {
    const stillTrue = new Set<string>();

    const add = (type: AlarmType, severity: Severity, id: string) =>
      stillTrue.add(`${type}:${severity}:${id}`);

    for (const tk of assets.tanks) {
      if (tk.current <= tk.critical) add("FUEL_CRITICAL", "L3", tk.id);
      else if (tk.current <= tk.low) add("FUEL_LOW", "L2", tk.id);
    }

    for (const g of assets.generators) {
      if (g.status === "FAULT") add("GEN_FAILURE", "L3", g.id);
      if (g.temperatureC > 104) add("GEN_OVERHEAT", "L3", g.id);
      else if (g.temperatureC > 95) add("GEN_OVERHEAT", "L2", g.id);
      if (g.status === "STOPPED") {
        const site = assets.sites.find((s) => s.id === g.siteId);
        if (site && site.gridAvailable === false && site.powerSource === "GENERATOR") {
          add("GEN_OFFLINE", "L2", g.id);
        }
      }
    }

    for (const b of assets.batteries) {
      const { isBatteryLowVoltage } = require("../thresholds-battery");
      if (isBatteryLowVoltage(b.voltage, b.nominalVoltage)) add("BATT_LOW_VOLTAGE", "L2", b.id);
      if (b.stateOfHealth < 70) add("BATT_FAILURE", "L1", b.id);
    }

    for (const d of assets.dispensers) {
      if (d.status === "FAULT") add("DISPENSER_FAULT", "L3", d.id);
    }

    for (const s of assets.sites) {
      if (s.commLossUntil && s.commLossUntil > now) add("COMM_LOSS", "L2", s.id);
    }

    const resolved: AlarmResolution[] = [];
    for (const key of [...openAlarmKeys]) {
      if (stillTrue.has(key)) continue;

      const [type, severity, entityId] = key.split(":");
      const isTransient = ["FUEL_THEFT", "FUEL_REFILL"].includes(type);

      if (isTransient) {
        // transientRaisedAt passed via context would be better, but keep backward compatible
      }

      resolved.push({ type: type as AlarmType, entityId, severity: severity as Severity });
      openAlarmKeys.delete(key);
    }

    return resolved;
  }

  /**
   * Escalate stale open alarms.
   * Returns notifications to create.
   */
  async escalateStale(
    tenantId: string,
    now: number
  ): Promise<{ alarmId: string; level: number; channel: string; recipient: string; subject: string; body: string }[]> {
    const notifications: { alarmId: string; level: number; channel: string; recipient: string; subject: string; body: string }[] = [];
    const { l1ToL2Minutes, l2ToL3Minutes } = this.escalationThresholds;

    const stale = await withTenant(tenantId, (tx) =>
      tx.alarm.findMany({
        where: { status: "OPEN" },
        select: { id: true, escalationLevel: true, type: true, entityId: true, message: true, siteId: true, createdAt: true },
      }),
    );

    for (const a of stale) {
      const ageMs = now - a.createdAt.getTime();
      const minutesAtLevel =
        a.escalationLevel <= 1
          ? ageMs - l1ToL2Minutes * 60_000
          : ageMs - l2ToL3Minutes * 60_000;

      let nextLevel = a.escalationLevel;
      if (a.escalationLevel <= 1 && minutesAtLevel >= 0) nextLevel = 2;
      if (a.escalationLevel <= 2 && minutesAtLevel >= l1ToL2Minutes * 60_000) nextLevel = 3;
      if (nextLevel === a.escalationLevel) continue;

      await withTenant(tenantId, (tx) =>
        tx.alarm.update({
          where: { id: a.id },
          data: { escalationLevel: nextLevel, status: nextLevel >= 3 ? "ESCALATED" : "OPEN" },
        }),
      );

      if (nextLevel >= 2) {
        notifications.push({
          alarmId: a.id,
          level: nextLevel,
          channel: nextLevel >= 3 ? "WHATSAPP" : "EMAIL",
          recipient: nextLevel >= 3 ? "+967-escalation-l3" : "ops-manager@fgmp.telecom",
          subject: `[ESCALATION L${nextLevel}] ${a.type}`,
          body: a.message,
        });
      }

      // Audit the escalation
      escalationAuditDetail.inc({ action: "escalated", from: a.escalationLevel, to: nextLevel });
    }

    return notifications;
  }

  /** Check if an alarm type is transient (point-in-time). */
  isTransient(type: AlarmType): boolean {
    return ["FUEL_THEFT", "FUEL_REFILL"].includes(type);
  }
}

// Singleton
const globalForAlarm = globalThis as unknown as { __fgmpAlarm?: AlarmService };
export const alarmService: AlarmService = globalForAlarm.__fgmpAlarm ?? new AlarmService();
if (process.env.NODE_ENV !== "production") globalForAlarm.__fgmpAlarm = alarmService;