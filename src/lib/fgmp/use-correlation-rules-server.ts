"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { useFgmp } from "@/lib/fgmp/store";
import { canAccessApi } from "@/lib/fgmp/rbac-core";
import type {
  CorrelationRule,
  RuleDraft,
  RuleAlarmTypeValue,
  CorrelationSeverity,
  CorrelationRuleScope,
} from "@/lib/fgmp/correlation-types";

/**
 * Server-backed correlation RULES (Phase 2, vertical 5).
 *
 * ── WHY THIS REPLACED THE localStorage STORE ───────────────────────────────
 * The previous store persisted rules under "fgmp:correlation-rules" in the
 * browser. That was incoherent the moment evaluation moved server-side:
 *
 *   - `evaluateAndPersist` reads `tx.correlationRule.findMany(...)` — the
 *     DATABASE. It has no way to see a rule that only exists in a browser's
 *     localStorage.
 *   - so a rule authored in the UI appeared in the rules table, showed its
 *     condition, could be toggled — and could never fire, because the
 *     scheduler that evaluates it was looking somewhere else.
 *   - it was also per-browser: a rule existed on exactly one machine, so two
 *     operators could see entirely different rule sets for the same tenant.
 *
 * A green screen therefore said nothing about whether correlation worked. The
 * store below is a thin cache over GET/POST/PATCH/DELETE /api/fgmp/correlation,
 * which is the same data the evaluator reads.
 *
 * The Zustand shape and the exported hook names are UNCHANGED, so the editor
 * keeps its synchronous interface; the mutation functions now POST and then
 * re-fetch rather than mutating an in-memory array and calling it done.
 *
 * Mutations are optimistic ONLY in the sense of "update after the server
 * confirms". A failed write leaves the list untouched and surfaces an error,
 * because a rule that appears saved but was not is exactly the failure this
 * module exists to remove.
 */

export type {
  CorrelationRule,
  RuleDraft,
  RuleAlarmTypeValue,
  CorrelationSeverity,
  CorrelationRuleScope,
};

export interface CorrelationRulesServerState {
  rules: CorrelationRule[];
  hydrated: boolean;
  /** Non-null when the last load or mutation failed. Surfaced, not swallowed. */
  error: string | null;
  saving: boolean;

  addRule: (rule: RuleDraft) => Promise<void>;
  updateRule: (id: string, patch: Partial<RuleDraft>) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  toggleRule: (id: string) => Promise<void>;
  hydrate: () => Promise<void>;
}

const RULES_URL = "/api/fgmp/correlation/rules";

function canRequestRules(method: string): boolean {
  return canAccessApi(useFgmp.getState().me?.role, RULES_URL, method);
}

/** Map the persisted row to the shape the editor already renders. */
function toRule(row: Record<string, unknown>): CorrelationRule {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : "",
    enabled: row.enabled !== false,
    alarmType: String(row.alarmType) as RuleAlarmTypeValue,
    threshold: Number(row.threshold ?? 1),
    windowMinutes: Number(row.windowMinutes ?? 5),
    scope: String(row.scope) as CorrelationRuleScope,
    escalateTo: String(row.escalateTo) as CorrelationSeverity,
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
  };
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const useCorrelationRules = create<CorrelationRulesServerState>((set, get) => ({
  rules: [],
  hydrated: false,
  error: null,
  saving: false,

  hydrate: async () => {
    if (!canRequestRules("GET")) return;
    try {
      const res = await fetch(RULES_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`rules request failed: ${res.status}`);
      const body = (await readJson(res)) as Record<string, unknown>[] | null;
      const rules = Array.isArray(body) ? body.map(toRule) : [];
      set({ rules, hydrated: true, error: null });
    } catch (err) {
      set({ hydrated: true, error: (err as Error).message });
    }
  },

  addRule: async (rule) => {
    if (!canRequestRules("POST")) {
      set({ error: "You do not have permission to manage correlation rules." });
      return;
    }
    set({ saving: true, error: null });
    try {
      const res = await fetch(RULES_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rule),
      });
      if (!res.ok) {
        const detail = await readJson(res);
        const msg =
          detail && typeof detail === "object" && "error" in detail
            ? String((detail as { error: unknown }).error)
            : `create failed: ${res.status}`;
        throw new Error(msg);
      }
      await get().hydrate();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ saving: false });
    }
  },

  updateRule: async (id, patch) => {
    if (!canRequestRules("PATCH")) {
      set({ error: "You do not have permission to manage correlation rules." });
      return;
    }
    set({ saving: true, error: null });
    try {
      const res = await fetch(`${RULES_URL}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`update failed: ${res.status}`);
      await get().hydrate();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ saving: false });
    }
  },

  deleteRule: async (id) => {
    if (!canRequestRules("DELETE")) {
      set({ error: "You do not have permission to manage correlation rules." });
      return;
    }
    set({ saving: true, error: null });
    try {
      const res = await fetch(`${RULES_URL}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      await get().hydrate();
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ saving: false });
    }
  },

  toggleRule: async (id) => {
    const target = get().rules.find((r) => r.id === id);
    if (!target) return;
    await get().updateRule(id, { enabled: !target.enabled });
  },
}));

const EMPTY_RULES: CorrelationRule[] = [];

/**
 * Reactive selector: the server-backed rule list.
 *
 * Returns [] before the first load so the first paint is stable, then the
 * tenant's real rules once GET /correlation/rules resolves.
 */
export function useCorrelationRulesList(): CorrelationRule[] {
  return useCorrelationRules((s) => (s.hydrated ? s.rules : EMPTY_RULES));
}

/**
 * Fetch the tenant's rules on mount.
 *
 * A no-op once loaded, so React strict-mode double-invocation and the editor
 * re-opening the dialog do not re-fetch.
 */
export function useCorrelationRulesHydration(enabled = true): void {
  const hydrated = useCorrelationRules((s) => s.hydrated);
  const hydrate = useCorrelationRules((s) => s.hydrate);
  useEffect(() => {
    if (!enabled || hydrated) return;
    void hydrate();
  }, [enabled, hydrated, hydrate]);
}

/** Last error from a load or mutation, for surfacing in the editor. */
export function useCorrelationRulesError(): string | null {
  return useCorrelationRules((s) => s.error);
}

export function useCorrelationRulesSaving(): boolean {
  return useCorrelationRules((s) => s.saving);
}