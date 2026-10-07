/**
 * Health checks — operational, not cosmetic.
 *
 * ── WHY THE OLD ONE WAS NOT ENOUGH ───────────────────────────────────────────
 * The previous health endpoint reported uptime and RSS: process-local facts
 * that are true while the process is alive and the database is unreachable,
 * the telemetry clock has stopped, and no telemetry has been ingested in six
 * hours. Those are precisely the conditions under which a fuel platform is
 * worthless and an operator needs to know.
 *
 * So the checks here answer: can we reach the database, is the telemetry clock
 * advancing, and is anything actually arriving?
 *
 * A dependency failure reports DEGRADED with HTTP 200 rather than failing
 * outright. A monitoring system that flaps to "down" because Redis blipped
 * trains its operators to ignore it, and then ignores the real outage. The
 * distinction between HEALTHY and DEGRADED is the useful signal; UNHEALTHY is
 * reserved for "this process cannot serve".
 */

import { mqttBrokerConnected } from "./metrics";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type CheckResult = {
  name: string;
  status: HealthStatus;
  detail: string;
  /** Milliseconds the check took. */
  durationMs: number;
};

export type HealthReport = {
  status: HealthStatus;
  checks: CheckResult[];
  checkedAt: string;
};

/** Uptime is reported for context, but never used as the verdict. */
const startedAt = Date.now();

/**
 * Is the telemetry clock running, and when did it last advance?
 *
 * `lastTickAt` is set by the scheduler's advance callback in instrumentation.ts.
 * Staleness is reported here rather than inlined as a magic threshold so the
 * policy lives in one readable place.
 */
let lastTickAt: number | null = null;
/** A tick is "stale" beyond this. The scheduler runs every ~5 s in normal operation. */
export const TICK_STALE_AFTER_MS = 60_000;

export function recordTick(at: number = Date.now()): void {
  lastTickAt = at;
}

export function lastTick(): number | null {
  return lastTickAt;
}

/** Test seam. */
export function resetTickForTest(): void {
  lastTickAt = null;
}

async function checkDatabase(): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    // A trivial round trip. SELECT 1 does not touch a table, so it proves
    // connectivity and auth without depending on any particular schema object
    // existing.
    const { db } = await import("@/lib/db");
    await db.$queryRaw`SELECT 1`;
    return { name: "database", status: "healthy", detail: "reachable", durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      name: "database",
      // Not "unhealthy": the process still serves reads it can answer from cache,
      // and a hard DOWN here would page for a transient blip.
      status: "degraded",
      detail: err instanceof Error ? err.message.slice(0, 160) : "unreachable",
      durationMs: Date.now() - t0,
    };
  }
}

function checkScheduler(): CheckResult {
  const t0 = Date.now();
  if (lastTickAt === null) {
    return {
      name: "scheduler",
      status: "degraded",
      // "Never" is different from "late": the first means it never started
      // (simulation refused, or instrumentation did not run), the second means
      // it started and stopped. Both matter and they need different fixes.
      detail: "no tick has ever been recorded — the telemetry clock is not running",
      durationMs: Date.now() - t0,
    };
  }
  const age = Date.now() - lastTickAt;
  if (age > TICK_STALE_AFTER_MS) {
    return {
      name: "scheduler",
      status: "degraded",
      detail: `last tick ${Math.round(age / 1000)}s ago (> ${TICK_STALE_AFTER_MS / 1000}s)`,
      durationMs: Date.now() - t0,
    };
  }
  return {
    name: "scheduler",
    status: "healthy",
    detail: `last tick ${Math.round(age / 1000)}s ago`,
    durationMs: Date.now() - t0,
  };
}

/**
 * MQTT broker connectivity.
 *
 * Reported from the same metrics the limiter and transports already record, so
 * health does not open its own connection to the broker just to ask.
 */
function checkBroker(): CheckResult {
  const t0 = Date.now();
  // Read the gauge the MQTT layer already publishes rather than opening a second
  // broker connection just to ask whether it is up.
  const connected = mqttBrokerConnected.get() === 1;
  return {
    name: "mqtt-broker",
    status: connected ? "healthy" : "degraded",
    detail: connected
      ? "connected"
      : "no broker connection has been recorded; telemetry publish/subscribe may be failing",
    durationMs: Date.now() - t0,
  };
}

/**
 * Full health report.
 *
 * Overall status is the worst individual check. The process itself is only
 * UNHEALTHY when it cannot answer at all, which the caller determines by having
 * reached this function.
 */
export async function checkHealth(): Promise<HealthReport> {
  const checks: CheckResult[] = [await checkDatabase(), checkScheduler(), checkBroker()];

  const status: HealthStatus = checks.some((c) => c.status === "unhealthy")
    ? "unhealthy"
    : checks.some((c) => c.status === "degraded")
      ? "degraded"
      : "healthy";

  return {
    status,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

export function uptimeMs(): number {
  return Date.now() - startedAt;
}