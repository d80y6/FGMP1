/**
 * Wiring alert metrics to the sources that actually produce them.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * Several alert rules referenced series that nothing published. A rule reading a
 * metric no code increments is decoration: it is in the config, it appears in
 * the preview, and it can never fire. That is the same defect as a threshold
 * table nothing reads — a table that looks like the system knows something it
 * does not.
 *
 * So each function here derives its metric from the real state of the thing it
 * describes, and each is honest about what it can and cannot observe.
 *
 * ── A METRIC THAT CANNOT BE OBSERVED IS NOT FABRICATED ─────────────────────
 * `dbPoolSaturationRatio` is the case worth reading. This Prisma build exposes
 * no pool statistics — no `$stats`, no `getStats`, verified against the runtime —
 * so there is genuinely no way to ask "how many of my N connections are in use".
 *
 * The tempting fix is to derive a proxy and publish it as the real metric. That
 * would be worse than leaving it absent: an operator would tune a threshold
 * against a number that does not mean what the rule says it means, and the rule
 * would fire for the wrong reason. It is therefore reported as ABSENT unless it
 * can be observed for real, and the rule that uses it evaluates to `unknown`
 * rather than `ok`. See docs/alerting.md#pool-saturation.
 */

import { registry } from "@/lib/observability/metrics";
import {
  theftDetections,
  schedulerRunning as schedulerRunningMetric,
  rateLimitDegraded as rateLimitDegradedMetric,
  ingestReadings,
} from "@/lib/observability/metrics";
// Aliased: the gauge and the exported FUNCTION that reports scheduler state are
// both called schedulerRunning, and importing both under one name silently
// shadows the function the gauge is supposed to be derived from.
import { schedulerRunning } from "@/lib/fgmp/scheduler";

/**
 * Publish whether the process-level scheduler is running.
 *
 * A gauge rather than a counter because it describes current state. Pushed from
 * the places where the answer can CHANGE — startup, each tick, shutdown — rather
 * than polled, because a gauge nobody sets reads as absent, and an absent gauge
 * makes `scheduler_not_running` evaluate to `unknown` rather than firing.
 *
 * Push points are in scheduler.ts, which owns the lifecycle. This module is the
 * single place that knows the metric exists and what it means.
 */
export function publishSchedulerRunning(): void {
  schedulerRunningMetric.set({}, schedulerRunning() ? 1 : 0);
}

/** Publish scheduler state, and clear it if the handle has gone away. */
export function publishSchedulerState(running: boolean): void {
  schedulerRunningMetric.set({}, running ? 1 : 0);
}

/**
 * Publish the theft-detector evidence the silence rule depends on.
 *
 * Counts EVALUATIONS as well as hits, keyed by result. The distinction is the
 * whole point of `theft_detector_silent`:
 *
 *   NO_CANDIDATE > 0  the detector RAN and found nothing. A real, healthy zero.
 *   CANDIDATE    > 0  the detector ran and found something.
 *   nothing at all    the detector has never run — a broken pipeline.
 *
 * Publishing only hits would make the first and third cases identical, which is
 * exactly the blindness the rule exists to remove.
 */
export function publishTheftEvaluation(result: "CANDIDATE" | "NO_CANDIDATE", by = 1): void {
  theftDetections.inc({ result }, by);
}

/**
 * Ingest liveness, used by the silence rules as corroborating evidence.
 *
 * A theft rule that requires live ingest can distinguish "the detector had
 * nothing to say" from "the detector was never given anything to look at".
 */
export function publishIngestLive(by = 1): void {
  ingestReadings.inc({}, by);
}

/**
 * Publish rate-limiter degradation.
 *
 * The limiter already sets this gauge itself at the point it degrades; this
 * exists so the alerting layer can RESET it when the limiter recovers. Without
 * that, a single degraded event pins the gauge at 1 forever and the rule fires
 * permanently after a blip — an alert nobody can silence except by editing the
 * config, which trains people to ignore alerting.
 */
export function publishRateLimitDegraded(degraded: boolean): void {
  rateLimitDegradedMetric.set({}, degraded ? 1 : 0);
}

/**
 * Publish database pool saturation.
 *
 * HONEST IMPLEMENTATION: reports whether saturation is OBSERVABLE, and does not
 * invent a number when it is not.
 *
 * This Prisma build exposes no pool statistics (`$stats` and `getStats` are both
 * absent — verified against the runtime rather than assumed from documentation).
 * With no in-use count there is no honest ratio to publish, and a proxy would be
 * worse than nothing: an operator tuning a threshold against a number that does
 * not mean what the metric name claims is precisely the "fires for the wrong
 * reason" failure.
 *
 * So the gauge is left UNSET, and `db_pool_saturated` evaluates to `unknown`.
 * That is the correct and intended behaviour — `unknown` says "I cannot see
 * this", which is true, where `ok` would say "this is fine", which is not.
 *
 * If a pool-stats API becomes available, `observePoolSaturation(inUse, limit)`
 * below is the single place that needs to change.
 */
export function observePoolSaturation(_inUse: number, _limit: number): number {
  // Deliberately a no-op until the runtime can actually report these numbers.
  // Recorded as a function so the future wiring has an obvious home and the
  // absence is visible in the source rather than implied by a missing line.
  return Number.NaN;
}

/**
 * Current saturation ratio, or null when it cannot be observed.
 *
 * Returning null rather than 0 is deliberate and is the same absent-versus-zero
 * distinction the alert rules are built on: an unobservable pool is not an idle
 * pool.
 */
export function poolSaturationRatio(): number | null {
  const rendered = registry.render();
  const line = rendered.split("\n").find((l) => l.startsWith("fgmp_db_pool_saturation_ratio"));
  if (!line) return null;
  const value = Number(line.trim().split(/\s+/)[1]);
  return Number.isFinite(value) ? value : null;
}
