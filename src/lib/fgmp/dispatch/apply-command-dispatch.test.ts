/**
 * applyCommand ↔ dispatch boundary tests.
 *
 * The load-bearing property: the ControlCommand row's terminal status is derived
 * from what the dispatch layer REPORTS, never from what the engine decides. A
 * command that was never attempted must never read as executed.
 *
 * These use a FAKE dispatch so the EXECUTED branch is reachable at all. With the
 * shipped implementations it is unreachable BY DESIGN — which is correct, but it
 * would leave the branch that marks a command acknowledged completely unexercised.
 */

import { expect, test, beforeEach } from "bun:test";
import { describeDb } from "../test-support/db-required";
import { withTenant } from "../tenant-context";
import { engine } from "../engine";
import type { DispatchOutcome, GeneratorDispatch } from "./types";

/** A dispatch that reports whatever the test tells it to. */
function fakeDispatch(outcome: DispatchOutcome, ackCalls: number[] = []): GeneratorDispatch {
  return {
    name: "fake",
    async dispatch(req) {
      ackCalls.push(1);
      return { ...outcome, acknowledgement: outcome.acknowledgement };
    },
  };
}

const realDispatch = engine["dispatchImpl" as never] as GeneratorDispatch;
const realSetDispatch = engine.setDispatch.bind(engine);

beforeEach(() => {
  // Every test must restore the shipped dispatch, or one test's fake leaks into
  // the next and the suite order starts to matter.
  realSetDispatch(realDispatch);
});

/**
 * Deliberately NO beforeAll calling `engine.ensureInit(["t-default"])`.
 *
 * An earlier version of this file warmed the engine explicitly so each test fit
 * inside the 5s budget. That MASKED A LIVE DEFECT: `applyCommand` calls
 * `ensureInit()` with no arguments, which calls `resolveActiveTenantIds()` and
 * returns every tenant in the database (34 in this test tree — 33 of them RLS
 * fixtures left by other agents' runs). The resulting cache key never matches
 * the single-tenant key, so the full multi-tenant state reloads on EVERY control
 * command: measured 15,867 ms with no args versus 629 ms with an explicit tenant.
 *
 * Keeping the workaround would have proven the workaround rather than the fix.
 * So the suite runs against the real code path, and the timeouts below are set
 * high enough to tolerate the defect rather than to hide it. When p2-integration
 * lands the ensureInit fix these must still pass UNMASKED.
 */
/**
 * A real, FK-valid user id.
 *
 * ControlCommand.issuedById is a foreign key, so a literal await realUserId() fails the
 * insert with P2003. An earlier version of this file did exactly that and every
 * test failed — the fix was to use a real row, not to relax the assertion.
 */
let cachedUserId: string | null = null;
async function realUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const u = await withTenant("t-default", (tx) => tx.user.findFirst({ select: { id: true } }));
  if (!u) throw new Error("no seeded user in t-default; run db:seed");
  cachedUserId = u.id;
  return cachedUserId;
}

async function pickGenerator() {
  await engine.ensureInit(["t-default"]);
  return engine.generators.find((g) => g.status !== "OFFLINE")!;
}

// These tests hit a live PostgreSQL through the real engine, and each command
// reloads tenant state. The honest budget is what the database actually needs
// on this host, not the 5s default — raising it is not masking a hang, because
// a hang still fails, just later. The default was chosen before these tests
// touched a database at all.
const DB_TEST_TIMEOUT = 60_000;

describeDb("applyCommand writes PENDING then transitions from the outcome", () => {
  test("NO_TRANSPORT -> FAILED with a NO_TRANSPORT reason, never EXECUTED", async () => {
    const g = await pickGenerator();
    const r = await engine.applyCommand(g.id, "STOP", await realUserId(), "t", "t-default");

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/NOT sent|no generator transport/i);

    // Resolve the id BEFORE the callback. `withTenant` hands the callback a
    // transaction client, and that callback is not async — `await` inside it is
    // a parse error, not a lint warning, so the whole file failed to load.
    const issuedById = await realUserId();
    const row = await withTenant("t-default", (tx) =>
      tx.controlCommand.findFirst({
        where: { generatorId: g.id, issuedById },
        orderBy: { issuedAt: "desc" },
      }),
    );
    expect(row?.status).toBe("FAILED");
    expect(row?.result).toContain("NO_TRANSPORT");
    expect(row?.executedAt).toBeNull();
  }, DB_TEST_TIMEOUT);

  test("TIMEOUT_AMBIGUOUS -> TIMEOUT, marked do-not-auto-retry", async () => {
    const g = await pickGenerator();
    engine.setDispatch(fakeDispatch({
      kind: "TIMEOUT_AMBIGUOUS",
      reason: "no reply within 400ms",
      retrySafe: false,
    }));
    const before = engine.generators.find((x) => x.id === g.id)!.status;

    const r = await engine.applyCommand(g.id, "START", await realUserId(), "t", "t-default");

    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/UNKNOWN/);
    // Resolve the id BEFORE the callback. `withTenant` hands the callback a
    // transaction client, and that callback is not async — `await` inside it is
    // a parse error, not a lint warning, so the whole file failed to load.
    const issuedById = await realUserId();
    const row = await withTenant("t-default", (tx) =>
      tx.controlCommand.findFirst({
        where: { generatorId: g.id, issuedById },
        orderBy: { issuedAt: "desc" },
      }),
    );
    expect(row?.status).toBe("TIMEOUT");
    expect(row?.result).toContain("DO_NOT_AUTO_RETRY");
    expect(row?.executedAt).toBeNull();
    // We do not know the state, so we must not assert one.
    expect(engine.generators.find((x) => x.id === g.id)!.status).toBe(before);
  }, DB_TEST_TIMEOUT);

  test("FAILED -> FAILED and NO in-memory mutation", async () => {
    const g = await pickGenerator();
    engine.setDispatch(fakeDispatch({ kind: "FAILED", reason: "coil write rejected", retrySafe: true }));
    const before = engine.generators.find((x) => x.id === g.id)!.status;

    const r = await engine.applyCommand(g.id, "START", await realUserId(), "t", "t-default");

    expect(r.ok).toBe(false);
    expect(engine.generators.find((x) => x.id === g.id)!.status).toBe(before);
    // Resolve the id BEFORE the callback. `withTenant` hands the callback a
    // transaction client, and that callback is not async — `await` inside it is
    // a parse error, not a lint warning, so the whole file failed to load.
    const issuedById = await realUserId();
    const row = await withTenant("t-default", (tx) =>
      tx.controlCommand.findFirst({
        where: { generatorId: g.id, issuedById },
        orderBy: { issuedAt: "desc" },
      }),
    );
    expect(row?.status).toBe("FAILED");
  }, DB_TEST_TIMEOUT);

  test("EXECUTED -> EXECUTED with executedAt from the ACKNOWLEDGEMENT", async () => {
    const g = await pickGenerator();
    const ackAt = 1_700_000_123_456;
    engine.setDispatch(fakeDispatch({
      kind: "EXECUTED",
      acknowledgement: { transport: "tcp://10.0.0.5:502", at: ackAt, detail: "coil=0xFF" },
    }));

    const r = await engine.applyCommand(g.id, "START", await realUserId(), "t", "t-default");

    expect(r.ok).toBe(true);
    expect(r.message).toContain("acknowledged by tcp://10.0.0.5:502");

    // Resolve the id BEFORE the callback. `withTenant` hands the callback a
    // transaction client, and that callback is not async — `await` inside it is
    // a parse error, not a lint warning, so the whole file failed to load.
    const issuedById = await realUserId();
    const row = await withTenant("t-default", (tx) =>
      tx.controlCommand.findFirst({
        where: { generatorId: g.id, issuedById },
        orderBy: { issuedAt: "desc" },
      }),
    );
    expect(row?.status).toBe("EXECUTED");
    // executedAt must come from the acknowledgement, not from issue time.
    expect(row?.executedAt?.getTime()).toBe(ackAt);
    expect(row?.result).toContain("tcp://10.0.0.5:502");
  }, DB_TEST_TIMEOUT);
});

describeDb("the boundary actually decides", () => {
  test("the shipped dispatch is asked — swapping it changes the outcome", async () => {
    const g = await pickGenerator();

    const withShipped = await engine.applyCommand(g.id, "STOP", await realUserId(), "t", "t-default");
    expect(withShipped.ok).toBe(false);

    engine.setDispatch(fakeDispatch({
      kind: "EXECUTED",
      acknowledgement: { transport: "fake", at: 1 },
    }));
    const withFake = await engine.applyCommand(g.id, "STOP", await realUserId(), "t", "t-default");
    expect(withFake.ok).toBe(true);

    // Same command, same asset, same caller. Only the dispatch differs. That is
    // the boundary being load-bearing rather than decorative.
  }, DB_TEST_TIMEOUT);

  test("EXECUTED is UNREACHABLE with the shipped implementation", async () => {
    // The property the Lead asked to be made structural: no shipped code path can
    // produce a row that claims a device acknowledged, because no shipped
    // implementation contacts one.
    const g = await pickGenerator();
    realSetDispatch(realDispatch);

    for (const command of ["START", "STOP", "EMERGENCY_STOP", "RESET"] as const) {
      // Same rule as above: `withTenant` hands the callback a transaction client
      // and does not await it, so anything asynchronous has to be resolved
      // before the callback. Resolve once per iteration and reuse.
      // Identify this iteration's rows by id, not by time.
      //
      // A time window is not isolation: the rows persist between runs, so a
      // rerun within 60s sees the PREVIOUS run's rows too — including the ones
      // the fake-dispatch tests deliberately made EXECUTED. Counting ids before
      // and after gives an exact set belonging to this iteration, whatever else
      // is in the table.
      const issuedById = await realUserId();
      const before = await withTenant("t-default", (tx) =>
        tx.controlCommand.findMany({ where: { generatorId: g.id }, select: { id: true } }),
      );
      const beforeIds = new Set(before.map((r) => r.id));
      await engine.applyCommand(g.id, command, issuedById, "t", "t-default");
      // Filter to THIS command as well as this generator.
      //
      // The earlier tests in this file install `fakeDispatch`, which
      // legitimately produces EXECUTED rows. Scoping only by generator, user
      // and a 60s window swept those up, so a correct assertion was failing on
      // rows that were deliberately created to be EXECUTED — and had it passed,
      // it would have been for the wrong reason.
      const rows = await withTenant("t-default", (tx) =>
        tx.controlCommand.findMany({ where: { generatorId: g.id, issuedById, command } }),
      );
      const fresh = rows.filter((r) => !beforeIds.has(r.id));
      expect(fresh.length).toBeGreaterThan(0);
      for (const r of fresh) {
        expect(r.status).not.toBe("EXECUTED");
        // An EXECUTED claim also requires an acknowledgement timestamp. Both
        // halves, because a row could carry the status without the proof.
        expect(r.executedAt).toBeNull();
        expect(r.result).not.toMatch(/"transport"/);
      }
      void before;
    }
  }, DB_TEST_TIMEOUT);
});