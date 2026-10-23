/**
 * Metrics — a minimal Prometheus-compatible registry.
 *
 * ── WHY NOT prom-client ──────────────────────────────────────────────────────
 * The platform needs counters, gauges and histograms with labels, exported in
 * Prometheus text format. That is a small, well-specified surface and vendoring
 * it keeps the dependency count flat in a codebase that has already been bitten
 * by transitive-package fragility. If the requirements grow — exemplars,
 * native histograms, remote-write — swap this for `prom-client` behind the same
 * interface; nothing outside this file imports the implementation.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * A registry with no label-cardinality guard is a memory-exhaustion bug
 * waiting for a hostile input. `userId` is NEVER a label: it is unbounded, and
 * a label per user would let anyone grow the process heap by requesting
 * different URLs. Labels are limited to small, enumerable sets, and
 * `assertLabelValues` enforces that at write time rather than trusting callers.
 */

type Labels = Record<string, string>;

/** Label names are validated: a typo in a label name silently breaks a query. */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Refuse unbounded label values.
 *
 * A metric keyed by, say, an alarm id would create a new time series per alarm
 * forever — the classic way a metrics endpoint takes down a service. Only
 * small enumerable sets belong in a label.
 */
function assertLabelValues(name: string, labels: Labels): void {
  for (const [k, v] of Object.entries(labels)) {
    if (!LABEL_NAME_RE.test(k)) {
      throw new Error(`invalid metric label name "${k}" on ${name}`);
    }
    if (v.length > 64) {
      throw new Error(
        `metric ${name} label ${k} is ${v.length} chars; labels must be low-cardinality. ` +
          `Never label by user id, alarm id, or any unbounded value.`,
      );
    }
  }
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(",");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export type MetricType = "counter" | "gauge" | "histogram";

abstract class Metric {
  constructor(
    readonly name: string,
    readonly type: MetricType,
    readonly help: string,
  ) {}

  abstract render(): string;
}

class Counter extends Metric {
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    super(name, "counter", help);
  }

  inc(labels: Labels = {}, by = 1): void {
    assertLabelValues(this.name, labels);
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    for (const [k, v] of this.values) out += `${this.name}${k ? `{${k}}` : ""} ${v}\n`;
    return out;
  }
}

class Gauge extends Metric {
  private values = new Map<string, number>();

  constructor(name: string, help: string) {
    super(name, "gauge", help);
  }

  set(labels: Labels, value: number): void {
    assertLabelValues(this.name, labels);
    this.values.set(labelKey(labels), value);
  }

  inc(labels: Labels = {}, by = 1): void {
    assertLabelValues(this.name, labels);
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n`;
    for (const [k, v] of this.values) out += `${this.name}${k ? `{${k}}` : ""} ${v}\n`;
    return out;
  }
}

/**
 * Histogram with fixed buckets.
 *
 * Cumulative counts, as Prometheus expects: each bucket is "observations <= x",
 * so the last is +Inf.
 */
class Histogram extends Metric {
  private counts: number[] = [];
  private sums = new Map<string, number>();
  private totals = new Map<string, number>();

  constructor(
    name: string,
    help: string,
    readonly buckets: number[],
  ) {
    super(name, "histogram", help);
    this.counts = new Array(buckets.length + 1).fill(0); // +1 for +Inf
  }

  observe(labels: Labels, value: number): void {
    assertLabelValues(this.name, labels);
    const k = labelKey(labels);
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        this.counts[i] = (this.counts[i] ?? 0) + 1;
        placed = true;
      }
    }
    // +Inf bucket counts everything, regardless of whether a finite bucket took it.
    this.counts[this.buckets.length] = (this.counts[this.buckets.length] ?? 0) + 1;
    this.sums.set(k, (this.sums.get(k) ?? 0) + value);
    this.totals.set(k, (this.totals.get(k) ?? 0) + 1);
    void placed;
  }

  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    const anyKey = [...this.totals.keys()][0] ?? "";
    for (let i = 0; i < this.buckets.length; i++) {
      const le = String(this.buckets[i]);
      out += `${this.name}_bucket{le="${le}"${anyKey ? "," + anyKey : ""}} ${this.counts[i] ?? 0}\n`;
    }
    out += `${this.name}_bucket{le="+Inf"${anyKey ? "," + anyKey : ""}} ${this.counts[this.buckets.length] ?? 0}\n`;
    for (const [k, total] of this.totals) {
      out += `${this.name}_sum${k ? `{${k}}` : ""} ${this.sums.get(k) ?? 0}\n`;
      out += `${this.name}_count${k ? `{${k}}` : ""} ${total}\n`;
    }
    return out;
  }
}

class Registry {
  private metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    const m = new Counter(name, help);
    this.metrics.set(name, m);
    return m;
  }

  gauge(name: string, help: string): Gauge {
    const m = new Gauge(name, help);
    this.metrics.set(name, m);
    return m;
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    const m = new Histogram(name, help, buckets);
    this.metrics.set(name, m);
    return m;
  }

  /** Prometheus text exposition format for /metrics. */
  render(): string {
    let out = "";
    for (const m of this.metrics.values()) out += m.render();
    return out;
  }

  /** Test seam. */
  clear(): void {
    this.metrics.clear();
  }
}

// ── The platform's metrics ───────────────────────────────────────────────────
//
// Chosen to answer questions an operator actually asks during an incident,
// not to instrument everything. Each one is a thing that has no other signal.

export const registry = new Registry();

// ── Telemetry clock ──────────────────────────────────────────────────────────
export const tickDuration = registry.histogram(
  "fgmp_tick_duration_seconds",
  "Wall time for one scheduler advance across all tenants.",
  [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);
export const lastTickTimestamp = registry.gauge(
  "fgmp_last_tick_timestamp_seconds",
  "Unix time of the last completed scheduler advance. Staleness here means the platform is not generating telemetry.",
);
export const tickErrors = registry.counter(
  "fgmp_tick_errors_total",
  "Scheduler advances that reported an error.",
);
export const tickCount = registry.counter(
  "fgmp_ticks_total",
  "Individual engine ticks executed.",
);

// ── IoT ingest ───────────────────────────────────────────────────────────────
export const ingestReadings = registry.counter(
  "fgmp_ingest_readings_total",
  "Telemetry readings accepted from devices.",
);
export const ingestRejected = registry.counter(
  "fgmp_ingest_rejected_total",
  "Ingest payloads rejected, by reason.",
);
/** No `deviceId` label — unbounded. Reason is a small enum. */
export const ingestDuration = registry.histogram(
  "fgmp_ingest_duration_seconds",
  "Time to process one ingest batch.",
  [0.005, 0.025, 0.1, 0.5, 1, 5],
);

// ── Alarms ───────────────────────────────────────────────────────────────────
export const alarmsRaised = registry.counter(
  "fgmp_alarms_raised_total",
  "Alarms raised, by severity.",
);
/** severity is a 5-value enum — safe as a label. */
export const activeAlarms = registry.gauge(
  "fgmp_active_alarms",
  "Currently active alarms by severity. A fuel-theft alarm here that nobody has acknowledged is the alert this platform exists for.",
);

// ── Interlocks ───────────────────────────────────────────────────────────────
export const interlockDenials = registry.counter(
  "fgmp_interlock_denials_total",
  "Commands denied by a safety interlock, by rule.",
);
/** rule is an enum of interlock rule ids — bounded. */
export const interlockEvaluations = registry.counter(
  "fgmp_interlock_evaluations_total",
  "Interlock evaluations performed.",
);

// ── Fuel theft ───────────────────────────────────────────────────────────────
/**
 * Unexplained-loss candidates the theft detector has produced.
 *
 * Added with Phase 5 alerting, and the metric the `theft_detector_silent` rule
 * depends on. Without it the platform cannot distinguish a detector that has
 * stopped working from a site with no theft — both read as zero, and the second
 * reading is the dangerous one on a platform whose purpose is fuel-theft
 * detection.
 *
 * A counter on purpose: "no detections in six hours" is only meaningful if the
 * detector demonstrably RAN during those six hours, which the alert rules
 * establish by also requiring the ingest metric to be live.
 */
export const theftDetections = registry.counter(
  "fgmp_theft_detections_total",
  "Unexplained-loss candidates produced by the fuel-theft detector. Zero is only meaningful alongside evidence that the detector ran.",
);

// ── Notifications ────────────────────────────────────────────────────────────
export const notificationOutcomes = registry.counter(
  "fgmp_notification_outcomes_total",
  "Notification delivery outcomes. status is SENT | FAILED | NO_TRANSPORT — the three are deliberately distinct.",
);
/** status + channel, both enums. */
export const notificationDuration = registry.histogram(
  "fgmp_notification_send_duration_seconds",
  "Time taken by a notification transport.",
  [0.05, 0.25, 1, 5, 15, 30],
);

// ── Rate limiting ────────────────────────────────────────────────────────────
export const rateLimitRejections = registry.counter(
  "fgmp_rate_limit_rejections_total",
  "Requests refused by the rate limiter. reason=degraded_closed means the shared store was unreachable and the limiter was running per-process.",
);
export const rateLimitDegraded = registry.gauge(
  "fgmp_rate_limit_degraded",
  "1 when the shared rate-limit store is unreachable, so limits are per-process rather than global.",
);

// ── Database ─────────────────────────────────────────────────────────────────
export const dbPoolSaturation = registry.gauge(
  "fgmp_db_pool_saturation_ratio",
  "Fraction of the Prisma connection pool currently in use. Approaching 1 means requests are queueing for a connection.",
);
export const dbQueryErrors = registry.counter(
  "fgmp_db_query_errors_total",
  "Database queries that returned an error.",
);

// ── HTTP ─────────────────────────────────────────────────────────────────────
export const httpRequests = registry.counter(
  "fgmp_http_requests_total",
  "HTTP requests handled, by route and status class.",
);
/** method and status are both small enumerations. */

// ── Scheduler state, for the health endpoint ─────────────────────────────────
export const schedulerRunning = registry.gauge(
  "fgmp_scheduler_running",
  "1 when the server-side telemetry clock is running.",
);

// ── MQTT ─────────────────────────────────────────────────────────────────────
export const mqttBrokerConnected = registry.gauge(
  "fgmp_mqtt_broker_connected",
  "1 when a broker connection has been established. Consumed by the health endpoint.",
);

/** Test seam: reset the registry between cases. */
export function resetMetricsForTest(): void {
  registry.clear();
}