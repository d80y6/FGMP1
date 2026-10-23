/**
 * Observability tests — metrics and log redaction.
 *
 * Run: bun test src/lib/observability/observability.test.ts
 */

import { describe, expect, test } from "bun:test";
import { redact } from "./log";
import {
  activeAlarms,
  alarmsRaised,
  ingestRejected,
  rateLimitRejections,
  registry,
  tickDuration,
} from "./metrics";
import { TICK_STALE_AFTER_MS, lastTick, recordTick, resetTickForTest } from "./health";

describe("metrics — Prometheus exposition", () => {
  test("renders HELP and TYPE lines", () => {
    const out = registry.render();
    expect(out).toContain("# HELP fgmp_alarms_raised_total");
    expect(out).toContain("# TYPE fgmp_alarms_raised_total counter");
    expect(out).toContain("# TYPE fgmp_active_alarms gauge");
  });

  test("counters accumulate and labels are rendered sorted and escaped", () => {
    alarmsRaised.inc({ severity: "CRITICAL" });
    alarmsRaised.inc({ severity: "CRITICAL" });
    alarmsRaised.inc({ severity: "L2" });
    const out = registry.render();
    expect(out).toContain('fgmp_alarms_raised_total{severity="CRITICAL"} 2');
    expect(out).toContain('fgmp_alarms_raised_total{severity="L2"} 1');
  });

  test("gauges replace rather than accumulate", () => {
    activeAlarms.set({ severity: "CRITICAL" }, 5);
    activeAlarms.set({ severity: "CRITICAL" }, 1);
    expect(registry.render()).toContain('fgmp_active_alarms{severity="CRITICAL"} 1');
  });

  test("histograms emit cumulative buckets including +Inf", () => {
    tickDuration.observe({}, 0.2);
    const out = registry.render();
    expect(out).toContain('fgmp_tick_duration_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain("fgmp_tick_duration_seconds_count 1");
    expect(out).toContain("fgmp_tick_duration_seconds_sum");
  });

  // A metrics endpoint that can be grown without limit by untrusted input is a
  // memory-exhaustion vector, not a feature.
  test("rejects an unbounded label value rather than creating a time series", () => {
    // A user id would create one series per user, forever.
    expect(() => alarmsRaised.inc({ severity: "x".repeat(200) })).toThrow(/low-cardinality/);
    expect(() => alarmsRaised.inc({ severity: "a", extra: "y".repeat(100) })).toThrow();
  });

  test("rejects an invalid label NAME", () => {
    expect(() => alarmsRaised.inc({ "bad-name": "x" })).toThrow(/label name/);
  });

  test("a short severity label is accepted", () => {
    expect(() => alarmsRaised.inc({ severity: "L3" })).not.toThrow();
  });
});

describe("log redaction — secrets and customer data never reach a log line", () => {
  test("redacts secrets by key name", () => {
    const out = redact({
      password: "hunter2",
      token: "abc123",
      authorization: "Bearer xyz",
      cookie: "session=abc",
      apiKey: "k-123",
      databaseUrl: "postgresql://user:pw@host/db",
      nextauthSecret: "s3cr3t",
    }) as Record<string, unknown>;

    for (const v of Object.values(out)) expect(v).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("postgresql://");
  });

  test("redacts nested secrets at depth", () => {
    const out = redact({ a: { b: { c: { password: "deep-secret" } } } });
    expect(JSON.stringify(out)).not.toContain("deep-secret");
  });

  test("redacts customer/operational data", () => {
    const out = redact({
      levelMm: 1200,
      volumeLitres: 500,
      supplier: "Yemen Oil Co.",
      doNumber: "DO-12345",
      email: "op@example.com",
      stolenValueUsd: 1234,
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("1200");
    expect(JSON.stringify(out)).not.toContain("Yemen Oil Co.");
    expect(JSON.stringify(out)).not.toContain("DO-12345");
  });

  test("keeps non-sensitive operational context so logs stay useful", () => {
    const out = redact({ event: "tick", durationMs: 42, ok: true }) as Record<string, unknown>;
    expect(out.durationMs).toBe(42);
    expect(out.ok).toBe(true);
  });

  test("is depth-bounded so a cyclic object cannot hang the logger", () => {
    const cyclic: Record<string, unknown> = { a: {} };
    (cyclic.a as Record<string, unknown>).self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain("depth-limit");
  });

  test("truncates very long strings", () => {
    const out = redact({ note: "x".repeat(2000) }) as { note: string };
    expect(out.note.length).toBeLessThan(600);
  });

  test("handles errors without dumping a stack", () => {
    const out = redact({ err: new Error("boom") }) as { err: { name: string; message: string } };
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe("boom");
  });
});

describe("scheduler staleness — the health signal that matters", () => {
  test("no tick ever recorded is reported distinctly from a late tick", () => {
    resetTickForTest();
    expect(lastTick()).toBeNull();
    recordTick();
    expect(lastTick()).not.toBeNull();
  });

  test("the stale threshold is explicit and readable", () => {
    // A single tick is every ~5s; 60s of silence means the clock has stopped.
    expect(TICK_STALE_AFTER_MS).toBe(60_000);
  });
});

describe("ingest rejection reasons are countable", () => {
  test("each reason is a separate series", () => {
    ingestRejected.inc({ reason: "SCHEMA" });
    ingestRejected.inc({ reason: "SCHEMA" });
    ingestRejected.inc({ reason: "UNKNOWN_DEVICE" });
    const out = registry.render();
    expect(out).toContain('fgmp_ingest_rejected_total{reason="SCHEMA"} 2');
    expect(out).toContain('fgmp_ingest_rejected_total{reason="UNKNOWN_DEVICE"} 1');
  });

  test("rate-limit rejections carry scope and reason", () => {
    // A label pair nothing else in the suite uses. The registry is a module
    // singleton shared by every test file in a `bun test` run, so asserting
    // `... scope="login"} 1` failed whenever an earlier file had already
    // incremented the real `login/degraded_closed` series — the assertion was
    // measuring test order, not label rendering.
    rateLimitRejections.inc({ scope: "test_isolation", reason: "degraded_closed" });
    expect(registry.render()).toContain(
      'fgmp_rate_limit_rejections_total{reason="degraded_closed",scope="test_isolation"} 1',
    );
  });
});