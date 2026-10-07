/**
 * Unit tests for command reconciliation.
 *
 * Pure — no database, no Prisma, no clock of its own. `now` is always passed in
 * explicitly, so every assertion is deterministic rather than timing-dependent.
 *
 * Run: bun test src/lib/fgmp/__tests__/command-reconciliation.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  decideReconciliation,
  staleCandidates,
  reconciliationReasonText,
  sweepTenant,
  sweepAllTenants,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  DEFAULT_STALE_AFTER_MS,
  type ReconcilableCommand,
} from "../command-reconciliation";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const FIVE_MIN = 5 * 60 * 1000;

function cmd(over: Partial<ReconcilableCommand> = {}): ReconcilableCommand {
  return {
    id: "cmd-1",
    generatorId: "gen-1",
    status: "PENDING",
    issuedAt: new Date(NOW.getTime() - FIVE_MIN - 1000), // just past stale
    executedAt: null,
    reason: null,
    result: null,
    ...over,
  };
}

describe("decideReconciliation — terminal rows are never touched", () => {
  test("each terminal status is left alone", () => {
    for (const status of TERMINAL_STATUSES) {
      const d = decideReconciliation(cmd({ status }), NOW);
      assert.equal(d.shouldReconcile, false, `${status} must not be reconciled`);
      assert.equal(d.reason, "ALREADY_TERMINAL");
    }
  });

  test("a terminal row is not even reported as stale", () => {
    const rows = [
      cmd({ id: "a", status: "EXECUTED" }),
      cmd({ id: "b", status: "FAILED" }),
      cmd({ id: "c", status: "TIMEOUT" }),
    ];
    assert.equal(staleCandidates(rows, NOW).length, 0);
  });

  test("an unrecognised status is left alone rather than guessed at", () => {
    const d = decideReconciliation(cmd({ status: "SOMETHING_NEW" }), NOW);
    assert.equal(d.shouldReconcile, false);
  });
});

describe("decideReconciliation — in-flight rows are respected", () => {
  test("a row younger than the stale window is NOT reconciled", () => {
    const fresh = cmd({ issuedAt: new Date(NOW.getTime() - 1000) });
    const d = decideReconciliation(fresh, NOW);
    assert.equal(d.shouldReconcile, false, "a 1s-old command is still in flight");
  });

  test("both non-terminal statuses are treated as in-flight candidates", () => {
    for (const status of NON_TERMINAL_STATUSES) {
      const d = decideReconciliation(cmd({ status, issuedAt: new Date(NOW.getTime() - 1000) }), NOW);
      assert.equal(d.shouldReconcile, false, `${status} must not be swept early`);
    }
  });

  test("the boundary is exactly staleAfterMs, not approximately", () => {
    const justUnder = cmd({ issuedAt: new Date(NOW.getTime() - (FIVE_MIN - 1)) });
    const exactly = cmd({ issuedAt: new Date(NOW.getTime() - FIVE_MIN) });
    assert.equal(decideReconciliation(justUnder, NOW).shouldReconcile, false);
    assert.equal(decideReconciliation(exactly, NOW).shouldReconcile, true);
  });
});

describe("decideReconciliation — stale rows are reconciled WITH a reason", () => {
  test("a never-acknowledged row becomes TIMEOUT", () => {
    const d = decideReconciliation(cmd({ status: "SENT" }), NOW);
    assert.equal(d.shouldReconcile, true);
    assert.equal(d.toStatus, "TIMEOUT");
    assert.equal(d.reason, "NO_ACKNOWLEDGEMENT");
  });

  test("the persisted reason names the cause, not just the status", () => {
    const c = cmd({ status: "SENT" });
    const d = decideReconciliation(c, NOW);
    const text = reconciliationReasonText(d, c);
    assert.ok(text.includes("NO_ACKNOWLEDGEMENT"), "reason must name the cause");
    assert.ok(text.length > 20, "reason must be a real explanation, not a token");
  });

  test("an acknowledged-but-unrecorded row is reported distinctly", () => {
    const d = decideReconciliation(
      cmd({ status: "PENDING", executedAt: new Date(NOW.getTime() - 60_000) }),
      NOW,
    );
    assert.equal(d.shouldReconcile, true);
    assert.equal(
      d.reason,
      "EXECUTED_WITHOUT_TIMESTAMP",
      "an executed command must not be recorded as a plain timeout",
    );
    assert.ok(d.note.includes("acknowledged"), "note must preserve the acknowledgement");
  });

  test("a PENDING row with no acknowledgement is the plain timeout case", () => {
    const d = decideReconciliation(cmd({ status: "PENDING" }), NOW);
    assert.equal(d.reason, "NO_ACKNOWLEDGEMENT");
  });
});

describe("reconciliation is idempotent — required by the brief", () => {
  test("running the decision twice produces the same outcome", () => {
    const c = cmd({ status: "SENT" });
    const first = decideReconciliation(c, NOW);
    const second = decideReconciliation(c, NOW);
    assert.deepEqual(first, second);
  });

  test("applying the decision, then re-deciding the RESULT, is a no-op", () => {
    const c = cmd({ status: "SENT" });
    const first = decideReconciliation(c, NOW);
    assert.equal(first.shouldReconcile, true);

    // Simulate the row having been written back: status is now terminal.
    const after: ReconcilableCommand = {
      ...c,
      status: first.toStatus,
      reason: reconciliationReasonText(first, c),
    };
    const second = decideReconciliation(after, NOW);
    assert.equal(second.shouldReconcile, false, "second sweep must not re-reconcile");
    assert.equal(second.reason, "ALREADY_TERMINAL");
  });

  test("a full sweep over a mixed set is stable across two passes", () => {
    const rows = [
      cmd({ id: "stale-sent", status: "SENT" }),
      cmd({ id: "stale-pending", status: "PENDING" }),
      cmd({ id: "fresh", status: "SENT", issuedAt: new Date(NOW.getTime() - 1000) }),
      cmd({ id: "done", status: "EXECUTED" }),
    ];

    const pass1 = staleCandidates(rows, NOW).map((c) => c.id);
    // Apply pass 1's effects.
    const afterPass1 = rows.map((c) =>
      pass1.includes(c.id) ? { ...c, status: "TIMEOUT" as const } : c,
    );
    const pass2 = staleCandidates(afterPass1, NOW).map((c) => c.id);

    assert.deepEqual(pass1.sort(), ["stale-pending", "stale-sent"]);
    assert.deepEqual(pass2, [], "second pass must find nothing to do");
  });
});

describe("staleCandidates", () => {
  test("selects only old non-terminal rows", () => {
    const rows = [
      cmd({ id: "old-sent", status: "SENT" }),
      cmd({ id: "new-sent", status: "SENT", issuedAt: new Date(NOW.getTime() - 5) }),
      cmd({ id: "old-exec", status: "EXECUTED" }),
    ];
    assert.deepEqual(staleCandidates(rows, NOW).map((c) => c.id), ["old-sent"]);
  });

  test("an empty set yields no candidates", () => {
    assert.deepEqual(staleCandidates([], NOW), []);
  });

  test("a custom stale window is honoured", () => {
    // 90s old: older than a 1m window, younger than the 5m default. The SAME row
    // must be a candidate under one window and not the other, which is what
    // proves the window is actually consulted rather than hardcoded.
    const row = cmd({ issuedAt: new Date(NOW.getTime() - 90_000) });
    assert.equal(
      staleCandidates([row], NOW).length,
      0,
      "90s old is NOT stale at the default 5m window",
    );
    assert.equal(
      staleCandidates([row], NOW, 60_000).length,
      1,
      "90s old IS stale when the window is only 1m",
    );
  });

  test("the default window is five minutes", () => {
    assert.equal(DEFAULT_STALE_AFTER_MS, 300_000);
  });
});

describe("purity", () => {
  test("decideReconciliation does not mutate its input", () => {
    const c = cmd({ status: "SENT" });
    const snapshot = JSON.stringify({ ...c, issuedAt: c.issuedAt.toISOString() });
    decideReconciliation(c, NOW);
    assert.equal(
      JSON.stringify({ ...c, issuedAt: c.issuedAt.toISOString() }),
      snapshot,
    );
  });

  test("the decision depends only on its arguments", () => {
    const c = cmd({ status: "PENDING" });
    assert.deepEqual(
      decideReconciliation(c, NOW),
      decideReconciliation({ ...c }, new Date(NOW.getTime())),
    );
  });
});
// ── The sweep itself ───────────────────────────────────────────────────────
describe("sweepTenant — moves stale rows and records why", () => {
  function fakeStore(rows: ReconcilableCommand[]) {
    const moved: string[] = [];
    return {
      moved,
      store: {
        listTenantIds: async () => ["t1"],
        findNonTerminal: async () => rows,
        markTerminal: async (a: { commandId: string; reason: string; result: string }) => {
          moved.push(`${a.commandId}:${a.reason}`);
          const row = rows.find((r) => r.id === a.commandId);
          if (!row) return false;
          row.status = "TIMEOUT";
          row.reason = a.result;
          return true;
        },
      },
    };
  }

  test("a stale SENT row is moved to TIMEOUT with a recorded reason", async () => {
    const { store, moved } = fakeStore([cmd({ id: "c1", status: "SENT" })]);
    const r = await sweepTenant(store, "t1", { now: NOW });
    assert.equal(r.reconciled, 1);
    assert.equal(r.moved[0].to, "TIMEOUT");
    assert.equal(r.moved[0].reason, "NO_ACKNOWLEDGEMENT");
    assert.equal(moved.length, 1);
  });

  test("a fresh row is left alone", async () => {
    const fresh = cmd({ id: "c2", status: "SENT", issuedAt: new Date(NOW.getTime() - 1000) });
    const { store } = fakeStore([fresh]);
    const r = await sweepTenant(store, "t1", { now: NOW });
    assert.equal(r.reconciled, 0);
    assert.equal(r.skipped, 1);
  });

  test("running the sweep twice moves nothing the second time", async () => {
    const rows = [cmd({ id: "c3", status: "SENT" })];
    const { store } = fakeStore(rows);
    const first = await sweepTenant(store, "t1", { now: NOW });
    const second = await sweepTenant(store, "t1", { now: NOW });
    assert.equal(first.reconciled, 1, "first sweep moves the row");
    assert.equal(second.reconciled, 0, "second sweep is a no-op");
    assert.equal(second.skipped, 1, "the row is seen and skipped, not re-moved");
  });
});

describe("sweepTenant — concurrent safety", () => {
  test("a row moved underneath the sweep is skipped, not double-moved", async () => {
    const row = cmd({ id: "c4", status: "SENT" });
    const store = {
      listTenantIds: async () => ["t1"],
      findNonTerminal: async () => [row],
      // Simulates another sweeper/dispatcher winning the race: the guarded
      // UPDATE matches nothing because the status is no longer what we read.
      markTerminal: async () => false,
    };
    const r = await sweepTenant(store, "t1", { now: NOW });
    assert.equal(r.reconciled, 0);
    assert.equal(r.skipped, 1, "the loss is counted, not silently dropped");
    assert.equal(r.moved.length, 0);
  });

  test("two sweeps over the same row reconcile it exactly once", async () => {
    const rows = [cmd({ id: "c5", status: "SENT" })];
    let writes = 0;
    const store = {
      listTenantIds: async () => ["t1"],
      findNonTerminal: async () => rows,
      markTerminal: async () => {
        const row = rows[0];
        if (row.status !== "SENT") return false;
        writes++;
        row.status = "TIMEOUT";
        return true;
      },
    };
    const [a, b] = await Promise.all([
      sweepTenant(store, "t1", { now: NOW }),
      sweepTenant(store, "t1", { now: NOW }),
    ]);
    assert.equal(writes, 1, "exactly one write wins the race");
    assert.equal(a.reconciled + b.reconciled, 1);
  });
});

describe("sweepAllTenants — per tenant, never an owner sweep", () => {
  test("each tenant is swept under its OWN id", async () => {
    const seen: string[] = [];
    const store = {
      listTenantIds: async () => ["t-a", "t-b"],
      findNonTerminal: async (tenantId: string) => {
        seen.push(tenantId);
        return [];
      },
      markTerminal: async () => true,
    };
    const r = await sweepAllTenants(store, { now: NOW });
    assert.deepEqual(seen, ["t-a", "t-b"], "each tenant gets its own pass");
    assert.equal(r.length, 2);
    assert.deepEqual(r.map((x) => x.tenantId), ["t-a", "t-b"]);
  });

  test("one tenant failing does not abandon the others", async () => {
    const store = {
      listTenantIds: async () => ["t-ok-1", "t-bad", "t-ok-2"],
      findNonTerminal: async (tenantId: string) => {
        if (tenantId === "t-bad") throw new Error("boom");
        return [];
      },
      markTerminal: async () => true,
    };
    const r = await sweepAllTenants(store, { now: NOW });
    assert.equal(r.length, 3, "every tenant is reported, including the failure");
    assert.deepEqual(r.map((x) => x.tenantId), ["t-ok-1", "t-bad", "t-ok-2"]);
  });
});
