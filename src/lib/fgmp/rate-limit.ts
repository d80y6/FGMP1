/**
 * FGMP in-memory rate limiter.
 *
 * Designed for the single-instance Next.js standalone deployment (no Redis
 * available). Uses a `Map<string, Bucket>` keyed by identifier (IP or user
 * id). Each bucket tracks request count + reset timestamp.
 *
 * A periodic sweep every 60s removes expired buckets to prevent memory
 * leaks from one-off IP/user ids. The sweep is gated behind a module-level
 * `lastSweep` timestamp so the cost is O(buckets) once per minute at most.
 *
 * Limits (per task spec):
 *   - Auth endpoints:    5 req / 15 min  per IP    (RATE_LIMIT_AUTH_*)
 *   - Mutation endpoints: 60 req / 1 min  per user  (RATE_LIMIT_MUTATION_*)
 *   - Read endpoints:    300 req / 1 min  per user
 *   - IoT ingest:        100 req / 1 min  per API key
 */

import type { NextRequest } from "next/server";

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 60_000;

/** Remove expired buckets. Cheap O(n) sweep; called at most once per minute. */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  /** Total allowed requests in the window — convenience for X-RateLimit-Limit header. */
  limit: number;
}

/**
 * Core rate-limit check. Mutates the in-memory bucket for `key`.
 *
 * @param key      Stable identifier (IP, user id, API key, …).
 * @param limit    Max requests allowed in the window.
 * @param windowMs Window length in milliseconds.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { success: true, remaining: limit - 1, resetAt, limit };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      success: false,
      remaining: 0,
      resetAt: existing.resetAt,
      limit,
    };
  }
  return {
    success: true,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    limit,
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
  if (xff) return xff.split(",")[0]!.trim();
  const xri = h.get("x-real-ip");
  if (xri) return xri.trim();
  return "anon";
}

/** Rate limit by client IP — used for unauthenticated endpoints (auth/login). */
export function rateLimitByIp(
  req: NextRequest | Request,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const ip = getClientIp(req);
  return rateLimit(`ip:${ip}`, limit, windowMs);
}

/** Rate limit by authenticated user id (or fall back to IP for anonymous). */
export function rateLimitByUser(
  req: NextRequest | Request,
  userId: string | null | undefined,
  limit: number,
  windowMs: number,
): RateLimitResult {
  if (userId) {
    return rateLimit(`u:${userId}`, limit, windowMs);
  }
  return rateLimitByIp(req, limit, windowMs);
}

/** Rate limit by API key (header `x-api-key`) — used for IoT bridge ingest. */
export function rateLimitByApiKey(
  req: NextRequest | Request,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const key = req.headers.get("x-api-key") ?? "no-key";
  return rateLimit(`k:${key}`, limit, windowMs);
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
