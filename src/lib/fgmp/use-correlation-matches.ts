"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFgmp } from "@/lib/fgmp/store";
import { canAccessApi } from "@/lib/fgmp/rbac-core";

/**
 * Server-backed correlation MATCHES (Phase 2, vertical 5).
 *
 * ── WHY THIS REPLACED CLIENT-SIDE EVALUATION ────────────────────────────────
 * The browser previously ran `evaluateAllRules(rules, alarms, sites)` from
 * `rule-engine.ts` against whatever alarms it happened to have loaded, and
 * rendered the result. Two consequences, both of them the reason this phase
 * moved correlation to the server:
 *
 *   1. The suppression decision was made per-client. Two operators watching the
 *      same alarm stream could see different verdicts, and nothing recorded
 *      that a rule had fired. Escalation was advisory: "this WOULD escalate".
 *   2. Rules lived in localStorage, so they were per-browser. An operator on a
 *      different machine, or the scheduler, had no idea the rule existed.
 *
 * Now the only thing the client does with correlation is DISPLAY rows the
 * server already evaluated and persisted. There is deliberately no evaluation
 * function imported here — a green build cannot mean "the client still decides
 * this" because the capability is not present.
 */

export interface CorrelationMatchDto {
  id: string;
  ruleId: string;
  ruleName: string;
  scope: string;
  scopeLabel: string;
  escalateTo: string;
  matchCount: number;
  alarmIds: string[];
  evaluatedAt: string;
}

interface State {
  matches: CorrelationMatchDto[];
  loading: boolean;
  error: string | null;
}

const MATCHES_URL = "/api/fgmp/correlation/matches?limit=100";

export function useCorrelationMatches(pollMs = 0, enabled = true) {
  const role = useFgmp((s) => s.me?.role ?? null);
  const permitted = enabled && canAccessApi(role, MATCHES_URL, "GET");
  const [state, setState] = useState<State>({
    matches: [],
    loading: true,
    error: null,
  });
  const mounted = useRef(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!permitted) return;
    try {
      const res = await fetch(MATCHES_URL, {
        signal,
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`matches request failed: ${res.status}`);
      }
      const body = (await res.json()) as CorrelationMatchDto[];
      if (!mounted.current) return;
      setState({ matches: Array.isArray(body) ? body : [], loading: false, error: null });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      if (!mounted.current) return;
      setState((s) => ({
        ...s,
        loading: false,
        // Surfaced rather than swallowed: a correlation view that silently shows
        // "no matches" when the request failed is indistinguishable from a
        // genuinely quiet platform.
        error: (err as Error).message,
      }));
    }
  }, [permitted]);

  useEffect(() => {
    mounted.current = true;
    if (!permitted) return () => { mounted.current = false; };
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => {
      mounted.current = false;
      ctrl.abort();
    };
  }, [load, permitted]);

  useEffect(() => {
    if (!permitted || !pollMs || pollMs <= 0) return;
    const id = setInterval(() => {
      const ctrl = new AbortController();
      void load(ctrl.signal);
    }, pollMs);
    return () => clearInterval(id);
  }, [load, pollMs, permitted]);

  return {
    matches: state.matches,
    loading: state.loading,
    error: state.error,
    refresh: () => load(),
  };
}

/**
 * Ask the server to evaluate rules now.
 *
 * The scheduler evaluates after every tick, so this is only for an operator
 * who just authored a rule and wants to see its effect without waiting. The
 * decision is made server-side; the caller cannot influence the outcome beyond
 * choosing when to ask.
 */
export function useTriggerEvaluation() {
  const role = useFgmp((s) => s.me?.role ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger = useCallback(async () => {
    if (!canAccessApi(role, "/api/fgmp/correlation/evaluate", "POST")) {
      setError("You do not have permission to evaluate correlation rules.");
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/fgmp/correlation/evaluate", { method: "POST" });
      if (!res.ok) throw new Error(`evaluate failed: ${res.status}`);
      return (await res.json()) as {
        rulesConsidered: number;
        inserted: number;
        deduplicated: number;
      };
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [role]);

  return { trigger, busy, error };
}