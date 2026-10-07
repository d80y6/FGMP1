/**
 * Correlation escalation — the action layer.
 *
 * PURE: no database, no clock, no network. Every assertion exercises the
 * DECISION half (`computeEscalations`, `outcomeForPlan`), which is the half that
 * decides whether a match claims an action. `applyEscalations` only performs the
 * write the plan describes, so a bug in the database write cannot hide a bug in
 * the judgement, and the judgement cannot be wrong in a way the tests miss.
 *
 * ── THE PROPERTY UNDER TEST ─────────────────────────────────────────────────
 * A recorded outcome must never claim an action that did not happen. That is the
 * whole point of this phase: the previous version wrote `outcome: "SUPPRESSED"`
 * unconditionally and suppressed nothing, so the correlation view told operators
 * alarms were handled while they were still paging.
 */
import { describe, expect, test } from "bun:test";
import {
  computeEscalations,
  outcomeForPlan,
  outcomeChangedAlarms,
  severityRank,
  escalationAuditDetail,
  type EscalationCandidate,
} from "../escalation";

/** Build a candidate list from pairs of (id, severity). */
function cands(...pairs: Array<[string, "L1" | "L2" | "L3"]>): EscalationCandidate[] {
  return pairs.map(([alarmId, currentSeverity]) => ({ alarmId, currentSeverity }));
}

describe("severityRank", () => {
  test("orders L1 < L2 < L3", () => {
    expect(severityRank("L1")).toBeLessThan(severityRank("L2"));
    expect(severityRank("L2")).toBeLessThan(severityRank("L3"));
  });

  test("is independent of the enum's declared order", () => {
    // The Prisma enum happens to be declared L1,L2,L3, so a string comparison
    // would agree today. The rank function is explicit so reordering the enum
    // cannot silently invert "escalate upward".
    expect(severityRank("L3")).toBe(3);
    expect(severityRank("L1")).toBe(1);
  });
});

describe("computeEscalations — raising severity", () => {
  test("raises an alarm below the target and records before AND after", () => {
    const plan = computeEscalations(cands(["a1", "L2"]), "L3");
    expect(plan.entries).toEqual([{ alarmId: "a1", fromSeverity: "L2", toSeverity: "L3" }]);
  });

  test("raises a whole correlated group in one call", () => {
    const plan = computeEscalations(
      cands(["a1", "L1"], ["a2", "L1"], ["a3", "L2"]),
      "L3",
    );
    expect(plan.entries).toHaveLength(3);
    expect(plan.entries.map((e) => e.alarmId)).toEqual(["a1", "a2", "a3"]);
    expect(plan.alreadyAtOrAbove).toHaveLength(0);
  });

  test("BOUNDARY: an alarm exactly at the target is NOT raised", () => {
    // Severity is raised only. An alarm already at L3 must not be recorded as
    // escalated to L3, because nothing changed.
    const plan = computeEscalations(cands(["a1", "L3"]), "L3");
    expect(plan.entries).toHaveLength(0);
    expect(plan.alreadyAtOrAbove).toEqual([{ alarmId: "a1", severity: "L3" }]);
  });

  test("BOUNDARY: one rank below the target IS raised", () => {
    const plan = computeEscalations(cands(["a1", "L2"]), "L3");
    expect(plan.entries).toHaveLength(1);
  });

  test("BOUNDARY: one rank above the target is NOT lowered", () => {
    // This is the security-critical case. A rule targeting L1 that matches a
    // CRITICAL alarm must not reduce it — otherwise a rule author could silence
    // a critical alarm by configuring a rule that matches it.
    const plan = computeEscalations(cands(["a1", "L3"]), "L1");
    expect(plan.entries).toHaveLength(0);
    expect(plan.alreadyAtOrAbove).toEqual([{ alarmId: "a1", severity: "L3" }]);
  });

  test("a negative-direction 'escalation' to L1 from L2 is refused", () => {
    const plan = computeEscalations(cands(["a1", "L2"], ["a2", "L3"]), "L1");
    expect(plan.entries).toHaveLength(0);
    expect(plan.alreadyAtOrAbove).toHaveLength(2);
  });

  test("mixed batch raises only the alarms below the target", () => {
    const plan = computeEscalations(
      cands(["low", "L1"], ["critical", "L3"], ["mid", "L2"]),
      "L3",
    );
    expect(plan.entries.map((e) => e.alarmId)).toEqual(["low", "mid"]);
    expect(plan.alreadyAtOrAbove).toEqual([{ alarmId: "critical", severity: "L3" }]);
  });
});

describe("computeEscalations — no escalation target", () => {
  test("a rule with no escalateTo raises nothing", () => {
    // A "just group these for me" rule must not silently change severity.
    const plan = computeEscalations(cands(["a1", "L1"], ["a2", "L2"]), null);
    expect(plan.entries).toHaveLength(0);
  });

  test("a rule with no escalateTo records nothing as already-at-target", () => {
    // They were not skipped for being at the target; they were never candidates.
    const plan = computeEscalations(cands(["a1", "L1"]), null);
    expect(plan.alreadyAtOrAbove).toHaveLength(0);
  });
});

describe("computeEscalations — empty and degenerate input", () => {
  test("no candidates yields an empty plan, not an error", () => {
    // This is the dangerous case: under FORCE RLS an unscoped alarm read returns
    // ZERO rows, so an evaluator that forgot its tenant context would plan to
    // escalate nothing while still recording a match. The plan is empty, and
    // outcomeForPlan reports NOOP, so the row says nothing happened.
    const plan = computeEscalations([], "L3");
    expect(plan.entries).toHaveLength(0);
  });

  test("empty candidates with no target is also a no-op", () => {
    expect(computeEscalations([], null).entries).toHaveLength(0);
  });
});

describe("computeEscalations — re-running does not double-apply", () => {
  test("after the first application, a second run finds nothing to do", () => {
    // This is the ACTION idempotency property, and it is distinct from the
    // match-row UNIQUE constraint: that one stops a duplicate ROW, this one
    // stops a duplicate WRITE. Both are needed — the constraint alone would let
    // a re-run re-raise alarms on a row it declined to insert.
    const first = computeEscalations(cands(["a1", "L2"], ["a2", "L2"]), "L3");
    expect(first.entries).toHaveLength(2);

    // Simulate the database state after the first run: both alarms are L3.
    const second = computeEscalations(cands(["a1", "L3"], ["a2", "L3"]), "L3");
    expect(second.entries).toHaveLength(0);
    expect(second.alreadyAtOrAbove).toHaveLength(2);
  });

  test("a re-run over an unchanged stream raises zero alarms three times running", () => {
    const target = cands(["a1", "L2"], ["a2", "L2"], ["a3", "L3"]);
    let current = target;
    const runs = [0, 1, 2].map(() => {
      const plan = computeEscalations(current, "L3");
      // Apply what was planned, the way the database would.
      const raised = new Map(plan.entries.map((e) => [e.alarmId, e.toSeverity]));
      current = current.map((c) => ({
        alarmId: c.alarmId,
        currentSeverity: raised.get(c.alarmId) ?? c.currentSeverity,
      }));
      return plan.entries.length;
    });
    expect(runs).toEqual([2, 0, 0]);
  });
});

describe("outcomeForPlan — honesty about what was done", () => {
  test("ESCALATED only when at least one alarm actually moved", () => {
    const plan = computeEscalations(cands(["a1", "L2"]), "L3");
    expect(outcomeForPlan(plan, "L3")).toBe("ESCALATED");
  });

  test("ESCALATION_NOOP when every alarm was already at the target", () => {
    // The case the old code got wrong: it recorded SUPPRESSED here, implying a
    // suppression that never happened.
    const plan = computeEscalations(cands(["a1", "L3"]), "L3");
    expect(outcomeForPlan(plan, "L3")).toBe("ESCALATION_NOOP");
  });

  test("ESCALATION_NOOP when the rule has no escalateTo", () => {
    const plan = computeEscalations(cands(["a1", "L1"]), null);
    expect(outcomeForPlan(plan, null)).toBe("ESCALATION_NOOP");
  });

  test("ESCALATION_NOOP when no candidates were found at all", () => {
    // If this ever reported ESCALATED it would be claiming an escalation of
    // zero alarms, which is exactly the false-record defect.
    const plan = computeEscalations([], "L3");
    expect(outcomeForPlan(plan, "L3")).toBe("ESCALATION_NOOP");
  });

  test("only ESCALATED asserts that alarms changed", () => {
    expect(outcomeChangedAlarms("ESCALATED")).toBe(true);
    expect(outcomeChangedAlarms("ESCALATION_NOOP")).toBe(false);
    // LEGACY: rows carrying this were written by the version that suppressed
    // nothing, so it must NOT be read as evidence of an action.
    expect(outcomeChangedAlarms("SUPPRESSED")).toBe(false);
  });
});

describe("escalationAuditDetail — reconstructable", () => {
  test("carries the rule, match, scope, instant and per-alarm before/after", () => {
    const plan = computeEscalations(cands(["a1", "L1"], ["a2", "L2"]), "L3");
    const at = new Date("2026-10-07T12:00:00.000Z");
    const detail = escalationAuditDetail({
      ruleId: "rule-1",
      matchId: "match-1",
      scopeLabel: "Region: Sanaa",
      escalateTo: "L3",
      plan,
      evaluatedAt: at,
    });

    expect(detail.ruleId).toBe("rule-1");
    expect(detail.matchId).toBe("match-1");
    expect(detail.scope).toBe("Region: Sanaa");
    expect(detail.escalateTo).toBe("L3");
    expect(detail.evaluatedAt).toBe("2026-10-07T12:00:00.000Z");
    expect(detail.raisedCount).toBe(2);
    expect(detail.unchangedCount).toBe(0);
    expect(detail.alarms).toEqual([
      { alarmId: "a1", from: "L1", to: "L3" },
      { alarmId: "a2", from: "L2", to: "L3" },
    ]);
  });

  test("records the unchanged count so a partial batch is visible", () => {
    const plan = computeEscalations(cands(["a1", "L1"], ["crit", "L3"]), "L3");
    const detail = escalationAuditDetail({
      ruleId: "r",
      matchId: "m",
      scopeLabel: "s",
      escalateTo: "L3",
      plan,
      evaluatedAt: new Date(0),
    });
    expect(detail.raisedCount).toBe(1);
    expect(detail.unchangedCount).toBe(1);
  });

  test("a NOOP escalation still produces an audit-shaped record", () => {
    // Recorded with raisedCount 0 rather than omitted, so the trail shows the
    // rule fired and deliberately did nothing.
    const plan = computeEscalations(cands(["a1", "L3"]), "L3");
    const detail = escalationAuditDetail({
      ruleId: "r",
      matchId: "m",
      scopeLabel: "s",
      escalateTo: "L3",
      plan,
      evaluatedAt: new Date(0),
    });
    expect(detail.raisedCount).toBe(0);
    expect(detail.alarms).toEqual([]);
  });
});