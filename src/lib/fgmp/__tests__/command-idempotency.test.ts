/**
 * Unit tests for command idempotency.
 *
 * Pure — no database, no HTTP, no server. `now` is injected so every assertion
 * is deterministic rather than timing-dependent.
 *
 * The three properties the brief requires:
 *   - a replay does NOT execute twice
 *   - a same-key-different-payload is REJECTED, not answered
 *   - the original outcome is returned, not a synthesised one
 *
 * Run: bun test src/lib/fgmp/__tests__/command-idempotency.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  decideIdempotency,
  fingerprintPayload,
  hashString,
  idempotencyRefusalCode,
  DEFAULT_KEY_TTL_MS,
  type IdempotencyRecord,
} from "../command-idempotency";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const FP_START = fingerprintPayload({ command: "START", generatorId: "gen-1", reason: null });
const FP_STOP = fingerprintPayload({ command: "STOP", generatorId: "gen-1", reason: null });

function record(over: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    key: "key-abc",
    payloadFingerprint: FP_START,
    issuedById: "user-1",
    issuedAt: new Date(NOW.getTime() - 1000),
    outcome: {
      commandId: "cmd-original",
      status: "EXECUTED",
      result: { ok: true, message: "generator started" },
      issuedAt: new Date(NOW.getTime() - 1000),
    },
    ...over,
  };
}

describe("no key supplied — existing clients must keep working", () => {
  test("undefined, null and blank all proceed", () => {
    for (const k of [undefined, null, "", "   "]) {
      const d = decideIdempotency({
        key: k as string | null | undefined,
        fingerprint: FP_START,
        issuedById: "user-1",
        existing: record(),
        now: NOW,
      });
      assert.equal(d.kind, "proceed", `key=${JSON.stringify(k)} must proceed`);
    }
  });

  test("proceeding even when a record exists — absence of a key is not a replay", () => {
    const d = decideIdempotency({
      key: null,
      fingerprint: FP_STOP,
      issuedById: "user-1",
      existing: record(),
      now: NOW,
    });
    assert.equal(d.kind, "proceed");
  });
});

describe("a fresh key executes exactly once", () => {
  test("unknown key with the same payload still executes", () => {
    // The same command sent twice WITHOUT a key is two real commands. This is
    // the deliberate second STOP that the heuristic in interlock-enforce cannot
    // distinguish from a retry, and it must not be suppressed.
    const a = decideIdempotency({
      key: "k1", fingerprint: FP_STOP, issuedById: "u1", existing: null, now: NOW,
    });
    const b = decideIdempotency({
      key: "k2", fingerprint: FP_STOP, issuedById: "u1", existing: null, now: NOW,
    });
    assert.equal(a.kind, "execute");
    assert.equal(b.kind, "execute");
    assert.notEqual(a.kind === "execute" ? a.key : "", b.kind === "execute" ? b.key : "");
  });

  test("execute carries the key and fingerprint to persist", () => {
    const d = decideIdempotency({
      key: "  key-abc  ", fingerprint: FP_START, issuedById: "u1", existing: null, now: NOW,
    });
    assert.equal(d.kind, "execute");
    if (d.kind !== "execute") return;
    assert.equal(d.key, "key-abc", "the key is trimmed");
    assert.equal(d.fingerprint, FP_START);
  });
});

describe("REPLAY — does not execute twice, returns the ORIGINAL outcome", () => {
  test("same key + same payload replays", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.equal(d.kind, "replay");
  });

  test("the replay returns the ORIGINAL outcome, not a new one", () => {
    const rec = record();
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: rec, now: NOW,
    });
    assert.equal(d.kind, "replay");
    if (d.kind !== "replay") return;
    assert.equal(d.record.outcome.commandId, "cmd-original");
    assert.equal(d.record.outcome.status, "EXECUTED");
    assert.deepEqual(d.record.outcome.result, { ok: true, message: "generator started" });
  });

  test("a replay decision carries no 'execute' arm — nothing new is dispatched", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.ok(
      d.kind !== "execute",
      "a replay must never resolve to execute, or the command runs twice",
    );
  });

  test("a FAILED original is replayed as the same failure, not retried", () => {
    const failed = record({
      outcome: { commandId: "cmd-9", status: "FAILED", result: { ok: false }, issuedAt: NOW },
    });
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: failed, now: NOW,
    });
    assert.equal(d.kind, "replay");
    if (d.kind !== "replay") return;
    assert.equal(d.record.outcome.status, "FAILED", "the original outcome is authoritative");
  });

  test("key whitespace does not create a second identity", () => {
    const d = decideIdempotency({
      key: "  key-abc  ", fingerprint: FP_START, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.equal(d.kind, "replay", "a padded key is the same key");
  });
});

describe("SAME KEY, DIFFERENT PAYLOAD — must be rejected", () => {
  test("a different command under the same key is a mismatch", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_STOP, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.equal(d.kind, "payload-mismatch");
  });

  test("a mismatch is NOT a replay — the first outcome must not be returned", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_STOP, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.notEqual(d.kind, "replay");
    assert.notEqual(d.kind, "execute");
  });

  test("the mismatch carries both fingerprints for diagnosis", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_STOP, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    if (d.kind !== "payload-mismatch") return;
    assert.equal(d.existingFingerprint, FP_START);
    assert.equal(d.incomingFingerprint, FP_STOP);
  });

  test("a mismatched refusal has a stable client-matchable code", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_STOP, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.equal(idempotencyRefusalCode(d), "IDEMPOTENCY_KEY_CONFLICT");
  });

  test("a non-mismatch has no refusal code", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: record(), now: NOW,
    });
    assert.equal(idempotencyRefusalCode(d), null);
  });

  test("another user's key is refused rather than answered with their outcome", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-2",
      existing: record({ issuedById: "user-1" }), now: NOW,
    });
    assert.equal(d.kind, "payload-mismatch", "a key is scoped to its author");
  });
});

describe("key expiry — an old key cannot resurrect", () => {
  test("just inside the TTL replays", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: record({ issuedAt: new Date(NOW.getTime() - DEFAULT_KEY_TTL_MS + 1000) }),
      now: NOW,
    });
    assert.equal(d.kind, "replay");
  });

  test("at the TTL it expires and executes fresh", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: record({ issuedAt: new Date(NOW.getTime() - DEFAULT_KEY_TTL_MS) }),
      now: NOW,
    });
    assert.equal(d.kind, "expired");
  });

  test("months later it executes rather than replaying a stale outcome", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1",
      existing: record({ issuedAt: new Date(NOW.getTime() - 90 * 24 * HOUR) }),
      now: NOW,
    });
    assert.equal(d.kind, "expired");
  });

  test("expiry is checked BEFORE payload, so an expired key with a new payload runs", () => {
    const d = decideIdempotency({
      key: "key-abc", fingerprint: FP_STOP, issuedById: "user-1",
      existing: record({ issuedAt: new Date(NOW.getTime() - 90 * 24 * HOUR) }),
      now: NOW,
    });
    assert.equal(d.kind, "expired", "a stale key is no longer the same request");
  });

  test("a custom TTL is honoured", () => {
    // record() was issued 1s ago. A 1h TTL therefore still covers it, and a 1ms
    // TTL does not — the same row, two windows, opposite outcomes.
    // issuedById MUST match record()'s author ("user-1"), or the author-scope
    // check refuses the key before the TTL is ever consulted — which is itself
    // correct behaviour, and was masking this test.
    const base = { key: "k", fingerprint: FP_START, issuedById: "user-1", existing: record() };
    assert.equal(
      decideIdempotency({ ...base, now: NOW, ttlMs: HOUR }).kind, "replay",
      "1s old is well inside a 1h TTL",
    );
    assert.equal(
      decideIdempotency({ ...base, now: NOW, ttlMs: 1 }).kind, "expired",
      "1s old is far outside a 1ms TTL",
    );
  });
});

describe("payload fingerprinting", () => {
  test("identical inputs produce an identical fingerprint", () => {
    assert.equal(
      fingerprintPayload({ command: "START", generatorId: "g1", reason: "maint" }),
      fingerprintPayload({ command: "START", generatorId: "g1", reason: "maint" }),
    );
  });

  test("a different command fingerprints differently", () => {
    assert.notEqual(
      fingerprintPayload({ command: "START", generatorId: "g1" }),
      fingerprintPayload({ command: "STOP", generatorId: "g1" }),
    );
  });

  test("a different generator fingerprints differently", () => {
    assert.notEqual(
      fingerprintPayload({ command: "START", generatorId: "g1" }),
      fingerprintPayload({ command: "START", generatorId: "g2" }),
    );
  });

  test("a different reason fingerprints differently", () => {
    assert.notEqual(
      fingerprintPayload({ command: "START", generatorId: "g1", reason: "a" }),
      fingerprintPayload({ command: "START", generatorId: "g1", reason: "b" }),
    );
  });

  test("absent reason and explicit null agree — clients differ in how they omit it", () => {
    assert.equal(
      fingerprintPayload({ command: "START", generatorId: "g1" }),
      fingerprintPayload({ command: "START", generatorId: "g1", reason: null }),
    );
  });

  test("the digest is fixed-width and base36", () => {
    const fp = fingerprintPayload({ command: "X".repeat(500), generatorId: "g".repeat(200) });
    assert.ok(fp.length < 12, `expected a short digest, got ${fp.length}`);
    assert.match(fp, /^[0-9a-z]+$/);
  });

  test("hashString is stable across calls", () => {
    assert.equal(hashString("abc"), hashString("abc"));
    assert.notEqual(hashString("abc"), hashString("abd"));
  });
});

describe("purity", () => {
  test("decideIdempotency does not mutate the record", () => {
    const rec = record();
    const before = JSON.stringify(rec, (k, v) => (v instanceof Date ? v.toISOString() : v));
    decideIdempotency({
      key: "key-abc", fingerprint: FP_START, issuedById: "user-1", existing: rec, now: NOW,
    });
    const after = JSON.stringify(rec, (k, v) => (v instanceof Date ? v.toISOString() : v));
    assert.equal(after, before);
  });

  test("the decision depends only on its arguments", () => {
    const args = { key: "key-abc", fingerprint: FP_START, issuedById: "user-1", existing: record() };
    assert.deepEqual(
      decideIdempotency({ ...args, now: NOW }),
      decideIdempotency({ ...args, existing: { ...args.existing }, now: new Date(NOW.getTime()) }),
    );
  });
});