/**
 * FGMP In-Memory Metrics Tracker (Task 32-A)
 * ─────────────────────────────────────────────────────────────────────────
 * A lightweight, dependency-free metrics collector that lives in the Node.js
 * process memory. Designed to be sampled by the `/api/fgmp/health` endpoint
 * and populated by the `withMetrics()` higher-order wrapper around hot API
 * routes (state, alarms).
 *
 * What it tracks:
 *   - requestCount        : total number of wrapped-route invocations since boot
 *   - totalResponseTimeMs : cumulative handler duration (ms) since boot
 *   - errorBuffer         : ring buffer of the last 20 captured error events
 *
 * What it does NOT track:
 *   - Per-route histograms (kept simple on purpose; Prometheus is out of scope)
 *   - Persisted metrics   (lost on process restart — acceptable for NOC display)
 *
 * Concurrency note:
 *   Node.js is single-threaded for JS execution, so the simple `+= 1` / push /
 *   shift mutations below are safe without locks. The metrics module is shared
 *   across all route handlers via the module singleton.
 */

export interface RecordedError {
  /** ISO timestamp string (new Date().toISOString()). */
  timestamp: string;
  /** HTTP method (GET, POST, …). */
  method: string;
  /** URL pathname (no query string). */
  path: string;
  /** HTTP status code returned to the client (e.g. 500). */
  status: number;
  /** Short human-readable error description. */
  message: string;
}

export interface MetricsSnapshot {
  /** Total invocations of `recordRequest` since process boot. */
  requestCount: number;
  /** Cumulative response-time in milliseconds across all recorded requests. */
  totalResponseTimeMs: number;
  /** Process boot epoch (ms). Used by /api/fgmp/health for `startedAt`. */
  startedAt: number;
  /** Most-recent-first list of captured errors (max length = MAX_ERRORS). */
  errorBuffer: RecordedError[];
}

/** Maximum number of error entries retained in the ring buffer. */
const MAX_ERRORS = 20;

/**
 * Module-level singleton. All exported helpers below mutate / read this
 * object. The reference is stable for the lifetime of the Node.js process.
 */
const metrics: MetricsSnapshot = {
  requestCount: 0,
  totalResponseTimeMs: 0,
  startedAt: Date.now(),
  errorBuffer: [],
};

/**
 * Record a single API request observation. Called by `withMetrics()` after
 * the wrapped handler returns (or throws). When the status is >= 400 the
 * request is also pushed to the error ring buffer with a generic message.
 */
export function recordRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
): void {
  metrics.requestCount += 1;
  metrics.totalResponseTimeMs += Math.max(0, Math.round(durationMs));
  if (status >= 400) {
    pushError({
      timestamp: new Date().toISOString(),
      method,
      path,
      status,
      message: `HTTP ${status}`,
    });
  }
}

/**
 * Push a structured error entry to the ring buffer. Used by `withMetrics()`
 * for caught exceptions and by `recordRequest()` for 4xx/5xx responses.
 * The buffer keeps the most recent `MAX_ERRORS` entries; the oldest is
 * discarded when capacity is exceeded.
 */
export function recordError(
  method: string,
  path: string,
  status: number,
  message: string,
): void {
  pushError({
    timestamp: new Date().toISOString(),
    method,
    path,
    status,
    message,
  });
}

function pushError(entry: RecordedError): void {
  metrics.errorBuffer.push(entry);
  if (metrics.errorBuffer.length > MAX_ERRORS) {
    // Drop the oldest entry — O(n) but n is tiny (20).
    metrics.errorBuffer.shift();
  }
}

/**
 * Return a defensive copy of the current metrics snapshot. Mutating the
 * returned object does not affect the live metrics.
 */
export function getMetrics(): MetricsSnapshot {
  return {
    requestCount: metrics.requestCount,
    totalResponseTimeMs: metrics.totalResponseTimeMs,
    startedAt: metrics.startedAt,
    errorBuffer: [...metrics.errorBuffer],
  };
}

/**
 * Average response time in milliseconds across all recorded requests.
 * Returns 0 when no requests have been observed (avoids NaN).
 */
export function getAvgResponseMs(): number {
  if (metrics.requestCount === 0) return 0;
  return Math.round(metrics.totalResponseTimeMs / metrics.requestCount);
}

/**
 * Return up to `limit` most-recent errors in reverse chronological order
 * (newest first). Used by the health endpoint to populate the `errors`
 * array on the dashboard.
 */
export function getRecentErrors(limit = 10): RecordedError[] {
  const buf = metrics.errorBuffer;
  // Buffer is append-order (oldest → newest). Slice the tail and reverse
  // so callers always get newest-first without re-sorting.
  const start = Math.max(0, buf.length - limit);
  return buf.slice(start).reverse();
}

/**
 * Reset all counters and clear the error buffer. Intended for tests and
 * operational reset scripts — never called from request hot paths.
 */
export function resetMetrics(): void {
  metrics.requestCount = 0;
  metrics.totalResponseTimeMs = 0;
  metrics.errorBuffer.length = 0;
  metrics.startedAt = Date.now();
}
