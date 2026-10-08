/**
 * Reading live metric values for alert evaluation.
 *
 * ── WHY THIS PARSES THE RENDERED TEXT ─────────────────────────────────────
 * `Metric.get(labels)` returns `this.values.get(k) ?? 0`. That collapses
 * "this series has never been reported" into "this series is zero", and those
 * are opposite facts: one means the pipeline is silent, the other means the
 * thing measured did not happen.
 *
 * That collapse is precisely what makes an alerting system harmful if left
 * unchecked — a monitor that reports healthy because it received nothing is
 * trusted in exactly the situation where it is useless. So this module reads
 * `registry.render()` and asks whether a line EXISTS, rather than asking for a
 * value and being told zero.
 *
 * `render()` is not private and is the same text `/metrics` serves, so this
 * reads exactly what an operator would see by curling the endpoint.
 *
 * ── WHY NOT ADD has() TO THE REGISTRY ──────────────────────────────────────
 * It would be the cleaner fix, and `src/lib/observability/**` is inside my write
 * scope. It was left alone because the registry is a shared seam: changing its
 * public surface to suit one consumer risks the other metrics consumers, and a
 * local parse needs no coordination. Flagged in docs/alerting.md as the
 * preferred upstream change if the alert surface grows.
 */

import { registry } from "@/lib/observability/metrics";
import type { AlertRule, MetricReading } from "./rules";

/**
 * Parse Prometheus exposition text into readings.
 *
 * Exported and pure so the absent-vs-zero behaviour is unit-testable without a
 * live registry — that distinction is the whole point of this file, so it must
 * not be something only an integration test can see.
 */
export function parseExposition(text: string): Map<string, MetricReading> {
  const out = new Map<string, MetricReading>();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // HELP/TYPE carry no value and would otherwise parse as NaN.
    if (line.startsWith("#")) continue;

    // A sample line is: metric_name{label="v",…} value [timestamp]
    // or:             metric_name value [timestamp]
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9.eE+]+|NaN)(\s+[0-9]+)?\s*$/.exec(
      line,
    );
    if (!match) continue;

    const [, name, labelPart, valuePart] = match;

    // Multiple series can share a metric name (different label sets). They are
    // kept apart by a key that includes the labels, and the unlabelled form is
    // also recorded so a rule with no label filter can read it.
    const key = labelPart ? `${name}${labelPart}` : name;
    const value = valuePart === "NaN" ? null : Number(valuePart);

    // A later series for the same name does not overwrite the unlabelled reading.
    if (!out.has(key)) out.set(key, { value, reported: true });
    if (!labelPart && !out.has(name)) out.set(name, { value, reported: true });
  }

  return out;
}

/**
 * Look up the series a rule cares about.
 *
 * Returns `{ value: null, reported: false }` when no such line exists — which is
 * the honest answer and the one `Metric.get()` cannot give.
 */
export function readingFor(
  exposition: Map<string, MetricReading>,
  rule: AlertRule,
): MetricReading {
  const labels = rule.labels ?? {};
  const entries = Object.entries(labels);

  if (entries.length === 0) {
    return exposition.get(rule.metric) ?? { value: null, reported: false };
  }

  // Build the label fragment the exposition format would have used, and fall
  // back to a scan so label ORDER does not have to be guessed correctly.
  const fragment =
    "{" + entries.map(([k, v]) => `${k}="${v}"`).join(",") + "}";
  const exact = exposition.get(`${rule.metric}${fragment}`);
  if (exact) return exact;

  for (const [key, reading] of exposition) {
    if (!key.startsWith(rule.metric + "{")) continue;
    const labelBlob = key.slice(rule.metric.length);
    const matches = entries.every(([k, v]) =>
      labelBlob.includes(`${k}="${v}"`),
    );
    if (matches) return reading;
  }

  return { value: null, reported: false };
}

/** Snapshot every reading the current registry can produce. */
export function currentReadings(): Map<string, MetricReading> {
  return parseExposition(registry.render());
}

/**
 * Age in seconds of the most recent tick, derived from the last-tick gauge.
 *
 * Kept separate because it is the one rule whose "value" is not directly the
 * metric — the metric is an absolute timestamp and the rule wants an age, which
 * is what an operator reads.
 *
 * Returns reported:false when the gauge has never been set, which for this rule
 * means "the scheduler has never run" rather than "zero seconds ago".
 */
export function tickAgeSeconds(
  readings: Map<string, MetricReading>,
  nowMs: number,
): MetricReading {
  const raw = readings.get("fgmp_last_tick_timestamp_seconds");
  // `!raw.reported` is the absence test. An earlier version wrote `raw.reported`
  // here, which returned absent whenever data HAD been reported — so the
  // scheduler-stall rule could never evaluate, let alone fire. Found by a test
  // asserting a 60s age and receiving absent.
  if (!raw || !raw.reported || raw.value === null) {
    return { value: null, reported: false };
  }
  return { value: Math.max(0, (nowMs / 1000) - raw.value), reported: true };
}