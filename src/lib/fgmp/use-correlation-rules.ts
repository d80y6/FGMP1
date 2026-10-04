"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/**
 * Alarm Correlation Rules store.
 *
 * Persisted to localStorage under "fgmp:correlation-rules" as a JSON array of
 * CorrelationRule objects. SSR-safe: starts empty on the server and the first
 * client render, then hydrates inside a useEffect to avoid hydration mismatches.
 *
 * Mirrors the use-site-notes.ts pattern: Zustand + manual localStorage
 * read/write + storage-event cross-tab sync + useCorrelationRulesHydration hook.
 *
 * NOTE: These rules are advisory only. The rule-engine.ts module EVALUATES
 * rules against current alarms to show what WOULD escalate — it never mutates
 * alarm state on the backend.
 */

const STORAGE_KEY = "fgmp:correlation-rules";

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
  | "ANY";

export type Severity = "L1" | "L2" | "L3";

export type RuleScope = "SITE" | "REGION" | "GOVERNORATE" | "NATIONAL";

export interface CorrelationRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Which alarm type to count. "ANY" matches every type. */
  alarmType: AlarmType;
  /** How many matching alarms within the window trigger the rule. */
  threshold: number;
  /** Time window in minutes (rolling, ending at "now"). */
  windowMinutes: number;
  /** Geographic scope for correlation grouping. */
  scope: RuleScope;
  /** What severity to escalate to when the rule fires. */
  escalateTo: Severity;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp — bumped on every edit. */
  updatedAt: string;
}

interface CorrelationRulesState {
  rules: CorrelationRule[];
  hydrated: boolean;
  addRule: (rule: Omit<CorrelationRule, "id" | "createdAt" | "updatedAt">) => void;
  updateRule: (id: string, patch: Partial<Omit<CorrelationRule, "id" | "createdAt">>) => void;
  deleteRule: (id: string) => void;
  toggleRule: (id: string) => void;
  /** Replace the entire rule set (used by "Reset to Defaults"). */
  replaceAll: (rules: CorrelationRule[]) => void;
  /** Re-read localStorage into state (called on mount + on storage events). */
  hydrate: () => void;
}

/** All valid alarm-type literals (excludes the synthetic "ANY" sentinel). */
const ALARM_TYPE_VALUES: ReadonlySet<string> = new Set<AlarmType>([
  "FUEL_THEFT",
  "FUEL_REFILL",
  "FUEL_LOW",
  "FUEL_CRITICAL",
  "GEN_OFFLINE",
  "GEN_FAILURE",
  "GEN_OVERHEAT",
  "BATT_LOW_VOLTAGE",
  "BATT_FAILURE",
  "COMM_LOSS",
  "ANY",
]);

const SEVERITY_VALUES: ReadonlySet<string> = new Set<Severity>(["L1", "L2", "L3"]);
const SCOPE_VALUES: ReadonlySet<string> = new Set<RuleScope>([
  "SITE",
  "REGION",
  "GOVERNORATE",
  "NATIONAL",
]);

/** Generate a unique id without depending on browser-only APIs. */
function genId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Clamp a positive integer (>=1). Returns 1 for invalid input. */
function clampPositiveInt(v: unknown, fallback = 1): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  return int >= 1 ? int : fallback;
}

/** Cap a string's length. */
function clampStr(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Sanitise a raw parsed value into a valid CorrelationRule, or return null if
 * it should be dropped (missing/wrong-typed required fields).
 */
function sanitizeRule(raw: unknown): CorrelationRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.name !== "string" || !r.name) return null;
  if (typeof r.description !== "string") return null;
  if (typeof r.enabled !== "boolean") return null;
  if (typeof r.alarmType !== "string" || !ALARM_TYPE_VALUES.has(r.alarmType)) return null;
  if (typeof r.escalateTo !== "string" || !SEVERITY_VALUES.has(r.escalateTo)) return null;
  if (typeof r.scope !== "string" || !SCOPE_VALUES.has(r.scope)) return null;
  if (typeof r.createdAt !== "string" || !r.createdAt) return null;
  if (typeof r.updatedAt !== "string" || !r.updatedAt) return null;
  return {
    id: r.id,
    name: clampStr(r.name, 120),
    description: clampStr(r.description, 500),
    enabled: r.enabled,
    alarmType: r.alarmType as AlarmType,
    threshold: clampPositiveInt(r.threshold, 1),
    windowMinutes: clampPositiveInt(r.windowMinutes, 1),
    scope: r.scope as RuleScope,
    escalateTo: r.escalateTo as Severity,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function readFromStorage(): CorrelationRule[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: CorrelationRule[] = [];
    for (const item of parsed) {
      const rule = sanitizeRule(item);
      if (!rule) continue;
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      out.push(rule);
    }
    return out;
  } catch {
    return [];
  }
}

function writeToStorage(rules: CorrelationRule[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // Ignore quota / privacy-mode errors — persistence is best-effort.
  }
}

/**
 * Pre-seeded default rules — sensible out-of-the-box escalation thresholds.
 * IDs are stable so "Reset to Defaults" produces the same canonical set.
 */
export const DEFAULT_RULES: CorrelationRule[] = [
  {
    id: "default-fuel-crisis",
    name: "Fuel Crisis Escalation",
    description:
      "Multiple FUEL_CRITICAL alarms in the same region indicate a widespread fuel shortage — escalate immediately.",
    enabled: true,
    alarmType: "FUEL_CRITICAL",
    threshold: 3,
    windowMinutes: 15,
    scope: "REGION",
    escalateTo: "L3",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "default-gen-fleet-failure",
    name: "Generator Fleet Failure",
    description:
      "Two or more generator failures in the same governorate within 10 minutes signal a fleet-wide problem.",
    enabled: true,
    alarmType: "GEN_FAILURE",
    threshold: 2,
    windowMinutes: 10,
    scope: "GOVERNORATE",
    escalateTo: "L3",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "default-battery-cascade",
    name: "Battery Bank Cascade",
    description:
      "Three or more battery failures at the same site within 5 minutes indicate a cascading battery bank fault.",
    enabled: true,
    alarmType: "BATT_FAILURE",
    threshold: 3,
    windowMinutes: 5,
    scope: "SITE",
    escalateTo: "L3",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "default-comm-outage",
    name: "Comm Network Outage",
    description:
      "Five or more communication losses in the same region within 20 minutes indicate a network backbone outage.",
    enabled: true,
    alarmType: "COMM_LOSS",
    threshold: 5,
    windowMinutes: 20,
    scope: "REGION",
    escalateTo: "L2",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "default-fuel-theft-pattern",
    name: "Fuel Theft Pattern",
    description:
      "Two or more fuel theft events in the same region within 30 minutes suggest a coordinated theft operation.",
    enabled: true,
    alarmType: "FUEL_THEFT",
    threshold: 2,
    windowMinutes: 30,
    scope: "REGION",
    escalateTo: "L3",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "default-overheat-cluster",
    name: "Overheat Cluster",
    description:
      "Two or more generator overheat events at the same site within 10 minutes indicate a cooling system fault.",
    enabled: true,
    alarmType: "GEN_OVERHEAT",
    threshold: 2,
    windowMinutes: 10,
    scope: "SITE",
    escalateTo: "L2",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
];

export const useCorrelationRules = create<CorrelationRulesState>((set, get) => ({
  rules: [],
  hydrated: false,
  addRule: (rule) => {
    const now = new Date().toISOString();
    const next: CorrelationRule = {
      ...rule,
      id: genId(),
      createdAt: now,
      updatedAt: now,
    };
    const list = [...get().rules, next];
    writeToStorage(list);
    set({ rules: list });
  },
  updateRule: (id, patch) => {
    if (!id) return;
    const now = new Date().toISOString();
    const list = get().rules.map((r) =>
      r.id === id ? { ...r, ...patch, updatedAt: now } : r,
    );
    writeToStorage(list);
    set({ rules: list });
  },
  deleteRule: (id) => {
    if (!id) return;
    const list = get().rules.filter((r) => r.id !== id);
    writeToStorage(list);
    set({ rules: list });
  },
  toggleRule: (id) => {
    if (!id) return;
    const now = new Date().toISOString();
    const list = get().rules.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled, updatedAt: now } : r,
    );
    writeToStorage(list);
    set({ rules: list });
  },
  replaceAll: (rules) => {
    writeToStorage(rules);
    set({ rules });
  },
  hydrate: () => {
    const rules = readFromStorage();
    set({ rules, hydrated: true });
  },
}));

const EMPTY_RULES: CorrelationRule[] = [];

/**
 * Reactive selector: returns the full rule list. Returns [] during SSR /
 * before hydration so the first paint is stable.
 *
 * NOTE (task 26-b): renamed from `useCorrelationRules` to
 * `useCorrelationRulesList` to resolve a duplicate-identifier build break —
 * the Zustand store creator at line ~273 is also exported as
 * `useCorrelationRules`. JS does not permit a `const` and a `function` to
 * share a name in the same module scope. The store retains its original
 * name; only this convenience selector was renamed. Call sites in
 * alarms-view.tsx and correlation-rules-editor.tsx were updated to import
 * the new name. No behaviour change.
 */
export function useCorrelationRulesList(): CorrelationRule[] {
  return useCorrelationRules(
    useShallow((s) => {
      if (!s.hydrated) return EMPTY_RULES;
      return s.rules;
    }),
  );
}

/**
 * Mount this once near the top of any component subtree that consumes
 * correlation rules — hydrates the store from localStorage and keeps it in
 * sync across tabs (storage events). On first-ever mount with empty storage,
 * seeds the default rules so the feature is useful out of the box.
 */
export function useCorrelationRulesHydration(): void {
  const hydrate = useCorrelationRules((s) => s.hydrate);
  const replaceAll = useCorrelationRules((s) => s.replaceAll);

  useEffect(() => {
    hydrate();

    // First-run seeding: if localStorage is empty (not just stale-then-cleared,
    // but truly never written), persist the default ruleset so the UI shows
    // useful out-of-the-box behaviour. We check storage directly here — after
    // hydrate() — so we don't clobber a user who has deliberately deleted all
    // rules (that would persist an empty array, which is distinct from "never
    // written").
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) {
          writeToStorage(DEFAULT_RULES);
          replaceAll(DEFAULT_RULES);
        }
      } catch {
        // Ignore — best-effort.
      }
    }

    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) hydrate();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrate, replaceAll]);
}
