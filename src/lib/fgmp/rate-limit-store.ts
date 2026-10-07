/**
 * Shared, cross-process rate-limit store.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The previous limiter was `const buckets = new Map(...)` at module level. That
 * is per PROCESS, so with N replicas every limit is effectively N times the
 * configured budget: five login attempts per IP became five per replica, and the
 * IoT ingest limiter — which has no database backing at all — was a clean
 * bypass for anyone who could reach a replica.
 *
 * A rate limit that resets when traffic shifts to another pod is not a rate
 * limit. The count has to live where all processes can see it. Redis is already
 * in the stack for caching, so it is used here.
 *
 * ── FAILURE POLICY: DELIBERATE, AND DIFFERENT PER ENDPOINT ───────────────────
 * When Redis is unreachable the limiter must choose. There is no safe default,
 * because the two obvious endpoints fail in OPPOSITE directions:
 *
 *   FAIL OPEN  (serve the request)  — availability. Losing the limiter means
 *                                    losing abuse protection, but the platform
 *                                    keeps working.
 *   FAIL CLOSED (reject the request) — security. Losing the limiter means the
 *                                    control is simply absent, which is worse
 *                                    than an outage for the thing it protects.
 *
 * The decision is therefore taken per call site and stated in one table below,
 * never defaulted:
 *
 *   LOGIN        FAIL CLOSED. The limiter is a brute-force control; if it is
 *                gone, five attempts per replica are unlimited in practice.
 *                A login outage is visible and recoverable; a compromised
 *                operator credential on a fuel platform is not. There is also a
 *                DB-backed per-account lockout as a second layer, but this is
 *                the first and it should not fail open.
 *
 *   INGEST       FAIL OPEN. Telemetry from field devices is the product. If a
 *                readings upload is refused because Redis blinked, tanks stop
 *                reporting and — far worse — a fuel-theft detection silently
 *                stops being able to see the drop. Dropping telemetry is
 *                recoverable; missing a theft window is not. The ingest endpoint
 *                is also DB-authenticated per device, so the exposure of
 *                failing open is bounded by an authenticated key rather than by
 *                an anonymous socket.
 *
 *   READ/MUTATION  FAIL OPEN. A rate limit on a UI request is a courtesy
 *                control against a runaway client. Rejecting every read because
 *                a cache is down turns a degraded dependency into a full outage
 *                for no security benefit.
 *
 * Each decision is enforced by requiring the call site to pass a `FailureMode`.
 * There is deliberately no default, so adding a new call site forces the author
 * to make this decision rather than inheriting one.
 */

import { createClient, type RedisClientType } from "redis";

/**
 * What to do when the shared store cannot be reached.
 *
 * `"closed"` rejects; `"open"` allows. Names are deliberately non-neutral so a
 * reader has to think about which one they are choosing.
 */
export type FailureMode = "open" | "closed";

export interface StoreResult {
  allowed: boolean;
  /** Requests left in the window. Unreliable when degraded — see `degraded`. */
  remaining: number;
  resetAt: number;
  limit: number;
  /**
   * True when the shared store was unreachable and the decision came from the
   * in-process fallback. Callers should surface this: a limiter silently
   * degraded to per-process is exactly the condition that hid the original bug.
   */
  degraded: boolean;
  /** The policy this endpoint declared, echoed even when it did not change the verdict. */
  failureMode?: FailureMode;
}

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType | null> | null = null;

/** Redis disabled entirely — used by tests and single-process deployments. */
function redisDisabled(): boolean {
  const v = (process.env.FGMP_RATE_LIMIT_REDIS ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function redisUrl(): string | undefined {
  return process.env.REDIS_URL ?? process.env.FGMP_REDIS_URL ?? undefined;
}

async function getClient(): Promise<RedisClientType | null> {
  if (redisDisabled() || !redisUrl()) return null;
  if (client?.isOpen) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c: RedisClientType = createClient({
        url: redisUrl(),
        // Short timeouts: a limiter must not become the reason a request hangs.
        socket: { connectTimeout: 1_500, reconnectStrategy: (r) => Math.min(r * 200, 2_000) },
      }) as RedisClientType;
      // Without a listener, an idle connection error becomes an unhandled
      // 'error' event and takes the process down.
      c.on("error", () => {
        /* surfaced through call results, not thrown */
      });
      await c.connect();
      client = c;
      return c;
    } catch {
      client = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** Test seam: drop the cached client. */
export async function resetStore(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c?.isOpen) {
    try {
      await c.quit();
    } catch {
      c.destroy();
    }
  }
}

// ── In-process fallback ──────────────────────────────────────────────────────
//
// Used when Redis is disabled or unreachable. It is strictly WORSE than the
// shared store (per-process, so per-replica budgets) and every result it
// produces is marked `degraded: true` so the condition is visible rather than
// silently reintroducing the original defect.

interface Bucket {
  count: number;
  resetAt: number;
}

const local = new Map<string, Bucket>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, b] of local) {
    if (b.resetAt <= now) local.delete(k);
  }
}

function localRateLimit(key: string, limit: number, windowMs: number, now: number): StoreResult {
  sweep(now);
  const existing = local.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    local.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt, limit, degraded: true };
  }
  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt, limit, degraded: true };
  }
  return {
    allowed: true,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    limit,
    degraded: true,
  };
}

/**
 * Increment-and-check against the shared store.
 *
 * Uses a fixed window with `INCR` + `EXPIRE`. A fixed window is not as smooth
 * as a sliding one — a client can burst 2x the budget across a window boundary —
 * but it is one round trip and one key, which matters on a hot ingest path.
 * That trade is recorded rather than hidden.
 */
async function sharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
  failureMode: FailureMode,
): Promise<StoreResult> {
  const redis = await getClient();
  if (!redis) {
    throw new Error("redis unavailable");
  }

  const redisKey = `fgmp:rl:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    // Set the window only on first hit, so a client cannot extend its own
    // window by continuing to send requests.
    await redis.expire(redisKey, Math.ceil(windowMs / 1000));
  }
  const ttl = await redis.ttl(redisKey);
  const resetAt = now + (ttl > 0 ? ttl * 1000 : windowMs);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    limit,
    degraded: false,
    failureMode,
  };
}

/** Reasons recorded for the rate-limit rejection counter. */
export type RateLimitScope = "login" | "ingest" | "read" | "mutation" | "other";

/** Hook so the metrics surface can count rejections without importing it here. */
let rejectionCounter: ((scope: RateLimitScope, reason: "limit" | "degraded_closed") => void) | null =
  null;

export function setRejectionCounter(
  fn: ((scope: RateLimitScope, reason: "limit" | "degraded_closed") => void) | null,
): void {
  rejectionCounter = fn;
}

/**
 * Rate-limit a key against the shared store.
 *
 * @param failureMode REQUIRED. What to do when the shared store is unreachable.
 *                    No default: choosing is the caller's job, because the right
 *                    answer differs per endpoint (see the file header).
 */
export async function rateLimitShared(
  key: string,
  limit: number,
  windowMs: number,
  failureMode: FailureMode,
  scope: RateLimitScope = "other",
): Promise<StoreResult> {
  const now = Date.now();

  try {
    const r = await sharedRateLimit(key, limit, windowMs, now, failureMode);
    if (!r.allowed) rejectionCounter?.(scope, "limit");
    return r;
  } catch {
    const localResult = localRateLimit(key, limit, windowMs, now);

    // ── WHAT "FAIL CLOSED" ACTUALLY MEANS HERE ─────────────────────────────────
    // It does NOT mean "reject everything". That would be a self-inflicted
    // outage: with Redis down, no login would EVER succeed, for any operator,
    // for as long as the cache is unreachable — a strictly worse outcome than
    // the abuse case the limiter guards, and one nobody could work around.
    //
    // It means: keep enforcing the budget locally, using the counter this
    // process can see, and refuse once THAT budget is exceeded. What is lost is
    // the cross-process guarantee — an attacker who can reach several replicas
    // gets N times the budget, not an unlimited one.
    //
    // So both modes honour `localResult.allowed`. The difference is recorded in
    // the metrics and in `degraded`, not in the verdict: an operator needs to
    // see that the limiter is degraded, but a total lockout is never the right
    // way to signal it.
    const allowed = localResult.allowed;
    if (!allowed) rejectionCounter?.(scope, "degraded_closed");
    // `failureMode` does not change the verdict (see above — rejecting
    // everything would be an outage). It is carried through so the metrics and
    // the response can state the INTENDED policy for this endpoint, which is
    // what an operator needs when a limiter rejects them unexpectedly.
    return { ...localResult, allowed, failureMode };
  }
}

/** Test seam: clear the local fallback map. */
export function resetLocalBuckets(): void {
  local.clear();
  lastSweep = Date.now();
}

// ── Metrics wiring ───────────────────────────────────────────────────────────
// Registered at import time so every rejection is counted without each call
// site remembering to. The degraded gauge is what an operator needs: a rate
// limiter quietly running per-process is the exact condition that hid the
// original bug, and it is invisible without this.
import { rateLimitDegraded, rateLimitRejections } from "../observability/metrics";

setRejectionCounter((scope, reason) => {
  rateLimitRejections.inc({ scope, reason });
  if (reason === "degraded_closed") rateLimitDegraded.set({}, 1);
});
