/**
 * FGMP rate limiter — public API.
 *
 * The actual counting moved to `rate-limit-store.ts`, which shares state across
 * processes via Redis. This module keeps the call signatures, the standard limit
 * presets and `applyRateLimitHeaders` unchanged, because 100 routes depend on
 * them and on the exact header names the UI reads.
 *
 * ── WHY THE STORE MOVED ──────────────────────────────────────────────────────
 * Counting used to live in a module-level `Map`, which is per PROCESS. With N
 * replicas every budget was multiplied by N: five login attempts per IP became
 * five per replica, and the IoT ingest limiter — which has no database backing
 * and so no other control at all — was a clean bypass. A rate limit that resets
 * when traffic moves to another pod is not a rate limit.
 *
 * The shared store degrades to an in-process Map when Redis is unreachable, and
 * every call site declares what that should mean. The declarations are the point:
 * login FAILS CLOSED (an absent brute-force control is worse than an outage),
 * ingest and reads FAIL OPEN (dropping telemetry would blind theft detection).
 * See `rate-limit-store.ts` for the full reasoning.
 *
 * Limits (per task spec):
 *   - Auth endpoints:    5 req / 15 min  per IP    (RATE_LIMIT_AUTH_*)
 *                        Applied via rateLimitLogin(); see its comment for why
 *                        the unknown-IP case uses a looser shared budget.
 *   - Mutation endpoints: 60 req / 1 min  per user  (RATE_LIMIT_MUTATION_*)
 *   - Read endpoints:    300 req / 1 min  per user
 *   - IoT ingest:        100 req / 1 min  per API key
 */

import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  /** Total allowed requests in the window — convenience for X-RateLimit-Limit header. */
  limit: number;
  /**
   * True when the shared store was unreachable and the answer came from the
   * per-process fallback. Surfaced so a silently-degraded limiter is visible
   * rather than quietly reintroducing the per-replica defect.
   */
  degraded: boolean;
}

import { rateLimitShared, type FailureMode, type RateLimitScope } from "./rate-limit-store";

/** Exposed so the metrics surface can count rejections without importing this. */
export type { FailureMode, RateLimitScope };

/**
 * Rate-limit a key against the shared, cross-process store.
 *
 * ASYNC: this was synchronous before and is not any more, because a shared
 * counter requires a network round trip. Every call site in `src/app/api/**`
 * is already async, so this is a signature change only where a sync caller
 * existed. The headers the UI reads are unchanged.
 *
 * @param failureMode what to do when the shared store is unreachable. No
 *                    default — choosing is the caller's job, because login and
 *                    telemetry ingest fail in opposite directions.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  failureMode: FailureMode,
  scope: RateLimitScope = "other",
): Promise<RateLimitResult> {
  const r = await rateLimitShared(key, limit, windowMs, failureMode, scope);
  return {
    success: r.allowed,
    remaining: r.remaining,
    resetAt: r.resetAt,
    limit: r.limit,
    degraded: r.degraded,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers: extract identifier from a NextRequest + apply standard limits.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Whether reverse-proxy headers (`cf-connecting-ip`, `x-forwarded-for`,
 * `x-real-ip`) may be trusted as the client IP source.
 *
 * DEFAULT: OFF. Those headers are trivially spoofable by a direct client, so
 * trusting them unconditionally lets an attacker mint a fresh IP on every
 * request and walk straight through any per-IP limiter (the login
 * brute-force limiter in particular).
 *
 * Set `TRUSTED_PROXY=1` (or `true`/`yes`) ONLY when the app is guaranteed to
 * sit behind a reverse proxy that overwrites those headers on the way in
 * (Caddy, nginx, Cloudflare, a platform load balancer). When OFF we cannot
 * see the real socket address through the Fetch `Request` abstraction, so
 * every direct client collapses to the single "anon" bucket — which is the
 * safe failure mode: it degrades to a *stricter*, global limiter rather than
 * a bypassable per-IP one.
 */
function trustedProxy(): boolean {
  const v = (process.env.TRUSTED_PROXY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Best-effort client IP extraction.
 *
 * Behind a trusted proxy (TRUSTED_PROXY=1) we read the left-most
 * `x-forwarded-for` entry / `cf-connecting-ip` / `x-real-ip`. Without a
 * trusted proxy those headers are client-controlled and therefore ignored —
 * we return "anon" rather than a value the attacker chose. Fallback is
 * always "anon".
 */
export function getClientIp(req: NextRequest | Request): string {
  const h = req.headers;
  if (!trustedProxy()) return "anon";
  // Common reverse-proxy headers (Caddy, nginx, Cloudflare).
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = h.get("x-real-ip");
  if (xri) return xri.trim();
  return "anon";
}

/** Rate limit by client IP — used for unauthenticated endpoints (auth/login). */
export async function rateLimitByIp(
  req: NextRequest | Request,
  limit: number,
  windowMs: number,
  failureMode: FailureMode = "open",
  scope: RateLimitScope = "other",
): Promise<RateLimitResult> {
  const ip = getClientIp(req);
  return rateLimit(`ip:${ip}`, limit, windowMs, failureMode, scope);
}

/**
 * Rate limit for the LOGIN endpoint specifically.
 *
 * Why this is not just rateLimitByIp(): getClientIp() returns the literal
 * "anon" unless TRUSTED_PROXY is set, because the forwarded headers are
 * client-controlled and trusting them blindly lets an attacker rotate a fake
 * IP per request and bypass the limiter entirely. The safe fallback, however,
 * means that without TRUSTED_PROXY every anonymous client shares ONE bucket.
 * Applying AUTH_LIMIT (5 / 15 min) to that bucket would mean five bad login
 * attempts from anyone lock every operator on the platform out of logging in
 * for a quarter of an hour — a self-inflicted denial of service.
 *
 * So the two failure modes are separated:
 *
 *   - Real client IP known (TRUSTED_PROXY set, headers trusted):
 *     the full AUTH_LIMIT budget, per IP.
 *   - IP unknown ("anon"): a deliberately MORE PERMISSIVE shared budget, so a
 *     single attacker cannot lock out the whole fleet, while still bounding
 *     automated guessing. The per-account `lockedUntil` lockout in
 *     src/lib/auth.ts remains the real backstop against credential stuffing,
 *     because it is DB-backed and keyed on the target account rather than on
 *     a spoofable or shared IP.
 */
export async function rateLimitLogin(
  req: NextRequest | Request,
): Promise<RateLimitResult> {
  const ip = getClientIp(req);
  // FAILS CLOSED, deliberately. This is the brute-force control. If the shared
  // store is unreachable an unshared counter cannot enforce it, and "let the
  // attempts through" is precisely the outcome the limiter exists to prevent. A
  // login outage is visible and recoverable; a guessed operator credential on a
  // fuel platform is not. The DB-backed per-account `lockedUntil` lockout in
  // src/lib/auth.ts is a second layer, but this is the first and it must not fail
  // open.
  if (ip !== "anon") {
    return rateLimit(`auth:ip:${ip}`, AUTH_LIMIT.limit, AUTH_LIMIT.windowMs, "closed", "login");
  }
  return rateLimit(
    "auth:shared",
    envInt("RATE_LIMIT_AUTH_SHARED_MAX", 200),
    AUTH_LIMIT.windowMs,
    "closed",
    "login",
  );
}

/** Rate limit by authenticated user id (or fall back to IP for anonymous). */
/**
 * Rate limit by authenticated user id (or fall back to IP for anonymous).
 *
 * FAILS OPEN: this guards UI traffic against a runaway client. Refusing every
 * authenticated read because a cache is down would turn a degraded dependency
 * into a full outage, with no security benefit — the caller is already
 * authenticated and the RLS backstop still applies.
 */
export async function rateLimitByUser(
  req: NextRequest | Request,
  userId: string | null | undefined,
  limit: number,
  windowMs: number,
  scope: RateLimitScope = "read",
): Promise<RateLimitResult> {
  if (userId) {
    return rateLimit(`u:${userId}`, limit, windowMs, "open", scope);
  }
  return rateLimitByIp(req, limit, windowMs, "open", scope);
}

/** Rate limit by API key (header `x-api-key`) — used for IoT bridge ingest. */
/**
 * Rate limit by API key (header `x-api-key`) — used for IoT bridge ingest.
 *
 * FAILS OPEN, deliberately. Telemetry is the product: if a readings upload is
 * refused because Redis blinked, tanks stop reporting and a fuel-theft window
 * can close silently. Dropped telemetry is recoverable and visible; a missed
 * theft is neither. Exposure is bounded because the caller must already hold a
 * valid device API key, so this is not an anonymous socket.
 */
export async function rateLimitByApiKey(
  req: NextRequest | Request,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const key = req.headers.get("x-api-key") ?? "no-key";
  // Do not place raw API credentials in Redis key names or the local fallback
  // map. A stable digest still gives every registered key its own budget.
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return rateLimit(`k:${digest}`, limit, windowMs, "open", "ingest");
}

// ──────────────────────────────────────────────────────────────────────────
// Standard limit presets (read from env with safe defaults).
// ──────────────────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Auth: 5 / 15 min per IP (prevents credential brute-force). */
export const AUTH_LIMIT = {
  limit: envInt("RATE_LIMIT_AUTH_MAX", 5),
  windowMs: envInt("RATE_LIMIT_AUTH_WINDOW_MS", 15 * 60 * 1000),
};

/** Mutations: 60 / 1 min per user. */
export const MUTATION_LIMIT = {
  limit: envInt("RATE_LIMIT_MUTATION_MAX", 60),
  windowMs: envInt("RATE_LIMIT_MUTATION_WINDOW_MS", 60 * 1000),
};

/** Reads: 300 / 1 min per user. */
export const READ_LIMIT = {
  limit: envInt("RATE_LIMIT_READ_MAX", 300),
  windowMs: envInt("RATE_LIMIT_READ_WINDOW_MS", 60 * 1000),
};

/** IoT ingest: 100 / 1 min per API key. */
export const IOT_LIMIT = {
  limit: envInt("RATE_LIMIT_IOT_MAX", 100),
  windowMs: envInt("RATE_LIMIT_IOT_WINDOW_MS", 60 * 1000),
};

// ──────────────────────────────────────────────────────────────────────────
// Shared query-param parsing
// ──────────────────────────────────────────────────────────────────────────

export interface IntParamOptions {
  /** Smallest accepted value. Values below are clamped up to `min`. */
  min: number;
  /** Largest accepted value. Values above are clamped down to `max`. */
  max: number;
  /** Value used when the param is absent or unparseable. */
  fallback: number;
}

/**
 * Parse a bounded integer query parameter.
 *
 * The previous inline pattern across the API surface was
 * `Math.min(500, Number(x))`, which has two failure modes:
 *
 *   1. `Number("abc")` → NaN. NaN flows into Prisma's `take` / `skip` and
 *      throws server-side, so a junk `?limit=abc` produced a 500 rather than
 *      a 400/clean-default.
 *   2. No lower bound — `?limit=-5` reached Prisma as a negative `take`.
 *
 * This helper is total: it always returns an integer inside `[min, max]`.
 * Unparseable / absent values fall back to `fallback` (also clamped, so a
 * misconfigured default can't itself be out of range). Callers that want a
 * 400 on junk input should compare against the result explicitly, or use
 * `parseIntParamStrict` below.
 */
export function parseIntParam(
  value: string | null | undefined,
  opts: IntParamOptions,
): number {
  const { min, max, fallback } = opts;
  const clampedFallback = Math.min(max, Math.max(min, Math.trunc(fallback)));
  if (value === null || value === undefined) return clampedFallback;
  const trimmed = String(value).trim();
  if (trimmed === "") return clampedFallback;
  // `Number` (not `parseInt`) so "12abc" is rejected rather than read as 12.
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return clampedFallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Strict variant: returns `null` when the value is present but unparseable,
 * so the caller can answer 400 instead of silently substituting a default.
 * Absent / empty values still resolve to the clamped fallback.
 */
export function parseIntParamStrict(
  value: string | null | undefined,
  opts: IntParamOptions,
): number | null {
  if (value !== null && value !== undefined && String(value).trim() !== "") {
    const n = Number(String(value).trim());
    if (!Number.isFinite(n)) return null;
    return Math.min(opts.max, Math.max(opts.min, Math.trunc(n)));
  }
  return parseIntParam(value, opts);
}

/**
 * Apply standard rate-limit headers to a `Headers` instance.
 * Always called — even on success — so clients can see remaining budget.
 */
export function applyRateLimitHeaders(
  headers: Headers,
  r: RateLimitResult,
): void {
  headers.set("X-RateLimit-Limit", String(r.limit));
  headers.set("X-RateLimit-Remaining", String(r.remaining));
  headers.set(
    "X-RateLimit-Reset",
    String(Math.ceil(r.resetAt / 1000)),
  );
}
