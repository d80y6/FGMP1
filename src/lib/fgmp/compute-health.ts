/**
 * FGMP Health Status Computation (Task 33-B)
 * ─────────────────────────────────────────────────────────────────────────
 * Pure helper that distills the full `/api/fgmp/health` payload down to a
 * 4-tier status indicator suitable for a compact header widget.
 *
 * The classification rules (intentionally lenient on the "healthy" side so
 * the indicator only turns red when something is genuinely wrong):
 *
 *  ── critical ──
 *     realtime disconnected AND >5 errors in the last hour, OR
 *     (implicit) realtime disconnected AND avg response > 500ms — covered
 *     by the `!responseDegraded` branch in the degraded rule below being
 *     promoted to critical when combined with realtime loss. To keep the
 *     rule explicit and predictable we use:
 *
 *       critical  =  !realtimeOk && (errorsLastHour > 5 || !responseDegraded)
 *
 *  ── degraded ──
 *     realtime disconnected, OR
 *     >5 errors in the last hour, OR
 *     avg response time >= 500ms, OR
 *     1+ errors in the last hour, OR
 *     avg response time >= 200ms
 *
 *  ── healthy ──
 *     realtime connected, no errors in the last hour, avg response < 200ms
 *
 *  ── unknown ──
 *     data is null/undefined (initial load, fetch error, 401/403)
 *
 * The function is pure and side-effect-free — given the same input it
 * always returns the same output, which makes it trivial to reason about
 * and unit-testable in isolation.
 */

export type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";

/**
 * Minimal projection of the HealthResponse shape that the computation
 * function needs. The full HealthResponse from /api/fgmp/health has many
 * more fields (memory, database, sessions, …) but the indicator only
 * cares about realtime connectivity, API response time, and the error
 * ring buffer.
 */
export interface HealthSnapshot {
  realtime: { connected: boolean };
  api: { avgResponseMs: number; totalRequests: number };
  errors: Array<{ timestamp: string; status: number }>;
}

/** One hour in milliseconds — used to bucket the error ring buffer. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Compute the 4-tier health status from a health snapshot.
 *
 * Returns "unknown" for null/undefined input so the caller can render the
 * gray "Checking…" state during the initial fetch or after a 401/403
 * (non-admin users, expired session, network failure).
 */
export function computeHealthStatus(data: HealthSnapshot | null): HealthStatus {
  if (!data) return "unknown";

  // ── Bucket: errors recorded within the last 60 minutes ────────────────
  // The error ring buffer is at most 20 entries (see metrics.ts), so this
  // filter is O(1) in practice. We use Date.now() at call time so the
  // bucket slides forward naturally as the indicator polls.
  const now = Date.now();
  const errorsLastHour = (data.errors ?? []).filter((e) => {
    if (!e?.timestamp) return false;
    const ts = new Date(e.timestamp).getTime();
    if (!Number.isFinite(ts)) return false;
    return now - ts < ONE_HOUR_MS;
  }).length;

  // ── Realtime connectivity (TCP probe on :3003 from the API) ───────────
  const realtimeOk = data.realtime?.connected === true;

  // ── API response time buckets ─────────────────────────────────────────
  const avgResponseMs = data.api?.avgResponseMs ?? 0;
  const responseOk = avgResponseMs < 200; // healthy threshold
  const responseDegraded = avgResponseMs < 500; // critical threshold

  // ── Classification (most-severe-first) ────────────────────────────────
  // Critical: realtime is down AND either error count or response time is
  // also bad. This is the "two systems failing at once" signal.
  if (!realtimeOk && (errorsLastHour > 5 || !responseDegraded)) {
    return "critical";
  }

  // Degraded: any single signal is off. Includes:
  //   - realtime disconnected (but errors/response still tolerable)
  //   - >5 errors in the last hour (regardless of realtime)
  //   - avg response >= 500ms (regardless of realtime)
  //   - 1-5 errors in the last hour (with realtime ok)
  //   - avg response 200-500ms (with realtime ok)
  if (
    !realtimeOk ||
    errorsLastHour > 5 ||
    !responseDegraded ||
    errorsLastHour > 0 ||
    !responseOk
  ) {
    return "degraded";
  }

  // Healthy: realtime connected, 0 errors in the last hour, fast API.
  return "healthy";
}
