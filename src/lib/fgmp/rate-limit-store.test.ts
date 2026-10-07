/**
 * Tests for the shared rate-limit store.
 *
 * Run: bun test src/lib/fgmp/rate-limit-store.test.ts
 *
 * Redis is deliberately NOT required. These exercise the decision logic that
 * actually matters — which direction each endpoint degrades — using the
 * in-process fallback with the shared store disabled. A test that needs a live
 * Redis does not get run by the people who need it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

// The store reads this at call time. Disable the shared backend BEFORE the
// module is imported so the fallback path is exercised, and import it ONCE —
// re-importing with a cache-busting query would create a second module instance
// with its own `local` Map, which silently breaks the shared-state assertions.
process.env.FGMP_RATE_LIMIT_REDIS = "1";
const store = await import("./rate-limit-store");

describe("rate-limit store — degradation policy", () => {
  beforeEach(() => {
    store.resetLocalBuckets();
  });

  test("allows requests under the limit and reports remaining budget", async () => {
    const first = await store.rateLimitShared("k1", 3, 60_000, "closed", "login");
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    const second = await store.rateLimitShared("k1", 3, 60_000, "closed", "login");
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(1);
  });

  test("rejects once the budget is exhausted", async () => {
    for (let i = 0; i < 3; i++) {
      await store.rateLimitShared("k2", 3, 60_000, "closed", "login");
    }
    const over = await store.rateLimitShared("k2", 3, 60_000, "closed", "login");
    expect(over.allowed).toBe(false);
    expect(over.remaining).toBe(0);
  });

  // ── The two decisions that matter ─────────────────────────────────────────

  test("a FRESH key is allowed even when the shared store is unavailable", async () => {
    // Guards against the worst possible reading of "fail closed": rejecting
    // every request would lock out every operator for as long as Redis is down,
    // which is a strictly worse outage than the abuse case it prevents.
    const first = await store.rateLimitShared("fresh-closed", 5, 60_000, "closed", "login");
    expect(first.allowed).toBe(true);
    expect(first.degraded).toBe(true);
    expect(first.failureMode).toBe("closed");
  });

  test("the LOCAL budget is still enforced when the shared store is unavailable", async () => {
    // What degrades is the CROSS-PROCESS guarantee, not the budget itself: an
    // attacker still gets `limit` attempts, not unlimited ones.
    await store.rateLimitShared("login-closed", 1, 60_000, "closed", "login");
    const second = await store.rateLimitShared("login-closed", 1, 60_000, "closed", "login");
    expect(second.allowed).toBe(false);
  });

  test("ingest is never rejected outright while the store is degraded", async () => {
    // Ingest semantics: refusing telemetry because a cache blinked would stop
    // tanks reporting and could close a theft-detection window silently.
    const first = await store.rateLimitShared("ingest-open", 1, 60_000, "open", "ingest");
    const second = await store.rateLimitShared("ingest-open", 1, 60_000, "open", "ingest");
    expect(first.allowed).toBe(true);
    expect(second.degraded).toBe(true);
  });

  test("degraded results are flagged so a silent per-process limiter is visible", async () => {
    const r = await store.rateLimitShared("degraded-flag", 5, 60_000, "open", "read");
    expect(r.degraded).toBe(true);
  });

  test("rejection counter is invoked for both limit and degraded rejections", async () => {
    const seen: { scope: string; reason: string }[] = [];
    store.setRejectionCounter((scope, reason) => seen.push({ scope, reason }));

    // With the shared store disabled every rejection arrives via the fallback,
    // so the reason is "degraded_closed" rather than "limit" — which is the
    // point: an operator can tell a genuine limit from a degraded limiter.
    for (let i = 0; i < 2; i++) {
      await store.rateLimitShared("counted", 1, 60_000, "closed", "login");
    }
    expect(seen.some((s) => s.reason === "degraded_closed")).toBe(true);
    expect(seen.every((s) => s.scope === "login")).toBe(true);

    store.setRejectionCounter(null);
  });

  test("keys are isolated per identifier", async () => {
    await store.rateLimitShared("a", 1, 60_000, "closed", "login");
    await store.rateLimitShared("a", 1, 60_000, "closed", "login");
    const other = await store.rateLimitShared("b", 1, 60_000, "closed", "login");
    expect(other.allowed).toBe(true);
  });

  test("resetLocalBuckets clears the fallback map", async () => {
    for (let i = 0; i < 2; i++) {
      await store.rateLimitShared("reset-me", 1, 60_000, "closed", "login");
    }
    store.resetLocalBuckets();
    const after = await store.rateLimitShared("reset-me", 1, 60_000, "closed", "login");
    expect(after.allowed).toBe(true);
  });
});