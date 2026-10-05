/**
 * Unit tests for edge ingest buffering (Phase 2).
 *
 * Run with: bun test src/lib/fgmp/__tests__/ingest-buffer.test.ts
 *
 * No I/O and no database: the buffering decision is pure, so it can be
 * verified exhaustively here rather than inferred from an HTTP response.
 */
import { describe, test, expect } from "bun:test";
import {
  DeviceWatermarkStore,
  parseReadingTs,
  checkDeclaredBodySize,
  isFiniteNumber,
  DEFAULT_CLOCK_POLICY,
} from "../ingest-buffer";

const T0 = 1_700_000_000_000; // fixed server time; no wall clock in tests

describe("parseReadingTs", () => {
  test("accepts epoch millis as a number", () => {
    expect(parseReadingTs(T0)).toBe(T0);
  });

  test("accepts epoch millis as a numeric string", () => {
    expect(parseReadingTs(String(T0))).toBe(T0);
  });

  test("accepts ISO-8601", () => {
    expect(parseReadingTs(new Date(T0).toISOString())).toBe(T0);
  });

  test("treats an absent timestamp as unknown rather than wrong", () => {
    // Firmware without a real-time clock is common. Returning null lets the
    // caller accept the reading while refusing to judge its age.
    expect(parseReadingTs(undefined)).toBeNull();
    expect(parseReadingTs(null)).toBeNull();
    expect(parseReadingTs("")).toBeNull();
    expect(parseReadingTs("   ")).toBeNull();
  });

  test("rejects unparseable garbage rather than guessing", () => {
    expect(parseReadingTs("not-a-date")).toBeNull();
    expect(parseReadingTs({})).toBeNull();
    expect(parseReadingTs(NaN)).toBeNull();
    expect(parseReadingTs(Infinity)).toBeNull();
  });
});

describe("fresh readings are accepted", () => {
  test("a reading at the current instant is accepted and sets the watermark", () => {
    const s = new DeviceWatermarkStore();
    const r = s.evaluate("tank-1", T0, T0);
    expect(r.status).toBe("ACCEPT");
    expect(s.peek("tank-1")).toBe(T0);
  });

  test("a sequence of increasing readings is all accepted", () => {
    const s = new DeviceWatermarkStore();
    for (let i = 0; i < 5; i++) {
      const ts = T0 + i * 60_000;
      expect(s.evaluate("tank-1", ts, ts).status).toBe("ACCEPT");
    }
    expect(s.peek("tank-1")).toBe(T0 + 4 * 60_000);
  });

  test("an undated reading is accepted but does not move the watermark", () => {
    const s = new DeviceWatermarkStore();
    s.evaluate("tank-1", T0, T0);
    const r = s.evaluate("tank-1", null, T0 + 1000);
    expect(r.status).toBe("ACCEPT");
    // The watermark must not be corrupted by a reading we could not date.
    expect(s.peek("tank-1")).toBe(T0);
  });
});

describe("out-of-order readings never overwrite fresh data", () => {
  test("an older reading is rejected as stale", () => {
    const s = new DeviceWatermarkStore();
    s.evaluate("tank-1", T0, T0);
    const r = s.evaluate("tank-1", T0 - 60_000, T0);
    expect(r.status).toBe("REJECT_STALE");
    // The watermark must still hold the FRESH value.
    expect(s.peek("tank-1")).toBe(T0);
  });

  test("a backlog dump after an outage is rejected except its newest item", () => {
    // The realistic failure: a gateway reconnects and flushes an hour of
    // buffered readings. The newest of those should be applied, and every
    // older one refused.
    //
    // The device clock is AHEAD of what we already stored (a reconnecting
    // gateway has kept counting), so the newest backlog item is genuinely
    // newer and must be accepted — not a duplicate of the stored watermark.
    const s = new DeviceWatermarkStore();
    s.evaluate("tank-1", T0, T0);
    const newest = T0 + 60_000;
    const results: string[] = [];
    for (let i = 59; i >= 0; i--) {
      results.push(s.evaluate("tank-1", newest - i * 60_000, newest).status);
    }
    expect(results.filter((x) => x === "ACCEPT")).toHaveLength(1);
    expect(results[results.length - 1]).toBe("ACCEPT");
    // Everything older is refused. The refusal reason varies legitimately: the
    // reading at exactly the stored instant is a DUPLICATE, the rest are
    // STALE. Both mean "not applied", and an operator wants both visible.
    expect(results.slice(0, -1).every((x) => x === "REJECT_STALE" || x === "REJECT_DUPLICATE")).toBe(
      true,
    );
    // The watermark advanced to the genuinely newest reading.
    expect(s.peek("tank-1")).toBe(newest);
  });

  test("a backlog whose newest item is already stored adds nothing", () => {
    // The complementary case: if everything in the backlog has already been
    // seen, replaying it must not change state at all. This is what makes a
    // device retry after a lost response safe rather than destructive.
    const s = new DeviceWatermarkStore();
    s.evaluate("tank-1", T0, T0);
    const results: string[] = [];
    for (let i = 59; i >= 0; i--) {
      results.push(s.evaluate("tank-1", T0 - i * 60_000, T0).status);
    }
    expect(results.filter((x) => x === "ACCEPT")).toHaveLength(0);
    // The newest item equals the stored instant, so it is a duplicate.
    expect(results[results.length - 1]).toBe("REJECT_DUPLICATE");
    expect(s.peek("tank-1")).toBe(T0);
  });

  test("a replayed reading is rejected as a duplicate, not as stale", () => {
    // Separated deliberately: an operator seeing DUPLICATE is looking at a
    // flaky link, whereas STALE suggests a clock problem.
    const s = new DeviceWatermarkStore();
    s.evaluate("tank-1", T0, T0);
    const r = s.evaluate("tank-1", T0, T0 + 5_000);
    expect(r.status).toBe("REJECT_DUPLICATE");
    expect(s.peek("tank-1")).toBe(T0);
  });

  test("watermarks are per device, so one device cannot reject another's data", () => {
    const s = new DeviceWatermarkStore();
    s.evaluate("tank-1", T0, T0);
    const other = s.evaluate("tank-2", T0 - 60_000, T0);
    // tank-2 is at the same site clock and is genuinely old, so it is still
    // refused on its own merits — but it must not have been judged against
    // tank-1's watermark.
    expect(["ACCEPT", "REJECT_TOO_OLD"]).toContain(other.status);
    s.evaluate("tank-2", T0 - 120_000, T0);
    const fresh = s.evaluate("tank-2", T0 + 1000, T0 + 1000);
    expect(fresh.status).toBe("ACCEPT");
  });
});

describe("clock sanity is bounded", () => {
  test("a reading far in the future is rejected", () => {
    const s = new DeviceWatermarkStore();
    const future = T0 + DEFAULT_CLOCK_POLICY.maxFutureMs + 60_000;
    const r = s.evaluate("tank-1", future, T0);
    expect(r.status).toBe("REJECT_FUTURE");
    expect(s.peek("tank-1")).toBeNull();
  });

  test("small clock skew within tolerance is accepted", () => {
    const s = new DeviceWatermarkStore();
    const r = s.evaluate("tank-1", T0 + 10_000, T0);
    expect(r.status).toBe("ACCEPT");
  });

  test("a reading older than the absolute limit is rejected as too old", () => {
    const s = new DeviceWatermarkStore();
    const ancient = T0 - DEFAULT_CLOCK_POLICY.maxAgeMs - 60_000;
    const r = s.evaluate("tank-1", ancient, T0);
    expect(r.status).toBe("REJECT_TOO_OLD");
    // Must not have become the watermark.
    expect(s.peek("tank-1")).toBeNull();
  });
});

describe("watermark priming survives a restart", () => {
  test("prime() restores the newest timestamp from persisted state", () => {
    // Without this, a redeploy empties the map and the first stale reading to
    // arrive is accepted — the protection silently disappears on restart.
    const s = new DeviceWatermarkStore();
    s.prime("tank-1", T0 - 10 * 60_000);
    const r = s.evaluate("tank-1", T0 - 30 * 60_000, T0);
    expect(r.status).toBe("REJECT_STALE");
  });

  test("prime() never moves the watermark backwards", () => {
    const s = new DeviceWatermarkStore();
    s.prime("tank-1", T0);
    s.prime("tank-1", T0 - 60_000);
    expect(s.peek("tank-1")).toBe(T0);
  });
});

describe("payload bounds", () => {
  const req = (len: string | null) => ({
    headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? len : null) },
  });

  test("accepts a normal body", () => {
    expect(checkDeclaredBodySize(req("512")).ok).toBe(true);
  });

  test("rejects an oversized declared body", () => {
    const r = checkDeclaredBodySize(req(String(10 * 1024 * 1024)));
    expect(r.ok).toBe(false);
  });

  test("unknown length is left for the reader to enforce", () => {
    // Chunked uploads declare nothing. Must not be rejected outright.
    expect(checkDeclaredBodySize(req(null)).ok).toBe(true);
  });

  test("a malformed Content-Length is rejected, not ignored", () => {
    const r = checkDeclaredBodySize(req("abc"));
    expect(r.ok).toBe(false);
  });
});

describe("numeric payloads", () => {
  test("rejects Infinity, which JSON.parse can produce from 1e400", () => {
    // A naive `value >= 0` check passes Infinity, and persisting it would put
    // Infinity into a numeric column.
    expect(isFiniteNumber(JSON.parse("1e400"))).toBe(false);
    expect(isFiniteNumber(1e400)).toBe(false);
  });

  test("accepts ordinary finite numbers", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-12.5)).toBe(true);
    expect(isFiniteNumber("5")).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});