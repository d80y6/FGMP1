/**
 * The ingest `ts` contract — testing the GUARANTEE, not the shape of the code.
 *
 * Run: bun test src/lib/fgmp/ingest-ts.test.ts
 *
 * ── WHY THESE TESTS EXIST ────────────────────────────────────────────────────
 * `ts` is the identity of a measurement, and UNIQUE(entityId, metric, ts) is the
 * replay guarantee. The route previously did `new Date(deviceTs ?? nowMs)`, so a
 * device that omitted `ts` got a different identity on every retry and the
 * constraint could never fire — duplicate readings, silently, forever.
 *
 * So the assertions below are about GUARANTEES:
 *   - a device-stamped reading keeps a stable identity, so dedup applies
 *   - an undated reading is MARKED, and the guarantee is explicitly NOT claimed
 *   - a future-dated clock is refused
 * A test that only checked the helper returned something plausible would pass
 * against the original buggy behaviour too.
 */

import { describe, expect, test } from "bun:test";
import {
  resolveReadingTs,
  parseDeviceTs,
  MAX_FUTURE_SKEW_MS,
  TS_POLICY,
  TS_CONTRACT_PROVENANCE,
} from "./ingest-ts";

const NOW = 1_700_000_000_000; // fixed clock, so nothing depends on real time.

describe("device timestamps parse", () => {
  test("epoch seconds and milliseconds both work", () => {
    const seconds = parseDeviceTs(1_700_000_000, NOW);
    const millis = parseDeviceTs(1_700_000_000_000, NOW);
    expect(seconds).toBe(1_700_000_000_000);
    expect(millis).toBe(1_700_000_000_000);
  });

  test("ISO strings work", () => {
    expect(parseDeviceTs("2023-11-14T22:13:20.000Z", NOW)).toBe(1_700_000_000_000);
  });

  test("absent, malformed and epoch-zero all read as absent", () => {
    // Absent is the whole defect: a row that must be marked rather than trusted.
    for (const bad of [undefined, null, "", "   ", "not-a-date", NaN, 0, "1970-01-01T00:00:00.000Z"]) {
      expect(parseDeviceTs(bad, NOW)).toBeNull();
    }
  });
});

describe("the dedup guarantee — what is actually claimed", () => {
  test("a DEVICE-stamped reading claims dedup and keeps its identity", () => {
    const d = resolveReadingTs({ deviceTs: 1_700_000_000_000, nowMs: NOW });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.source).toBe("DEVICE");
    // THIS is the guarantee. A retry of the same reading produces the same ts,
    // so UNIQUE(entityId, metric, ts) fires and the second insert is refused.
    expect(d.dedupGuaranteed).toBe(true);
    expect(d.readingTs.getTime()).toBe(1_700_000_000_000);
  });

  test("a DEVICE-stamped reading is IDENTICAL across retries", () => {
    // This is the regression, stated as a property: the original bug made the
    // identity depend on arrival time, so a retry differed.
    const ts = 1_699_999_000_000;
    const first = resolveReadingTs({ deviceTs: ts, nowMs: NOW });
    const retry = resolveReadingTs({ deviceTs: ts, nowMs: NOW + 60_000 });
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.readingTs.getTime()).toBe(first.readingTs.getTime());
  });

  test("an undated reading is ACCEPTED but MARKED SERVER, and claims NO guarantee", () => {
    const d = resolveReadingTs({ deviceTs: null, nowMs: NOW });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.source).toBe("SERVER");
    // The honest part: the row exists, but nothing promises it will deduplicate.
    expect(d.dedupGuaranteed).toBe(false);
  });

  test("two undated retries are NOT deduplicable — and the helper says so", () => {
    // The limit that cannot be fixed without breaking the fleet. Asserted rather
    // than hidden, so nobody re-derives a false guarantee from the code.
    const first = resolveReadingTs({ deviceTs: null, nowMs: NOW });
    const retry = resolveReadingTs({ deviceTs: null, nowMs: NOW + 1 });
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.readingTs.getTime()).not.toBe(first.readingTs.getTime());
    expect(first.dedupGuaranteed).toBe(false);
    expect(retry.dedupGuaranteed).toBe(false);
  });
});

describe("staged rejection is available per site", () => {
  test("policy REJECT refuses an undated reading", () => {
    const d = resolveReadingTs({ deviceTs: null, nowMs: NOW, policy: TS_POLICY.REJECT });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.status).toBe(422);
    expect(d.code).toBe("TS_REQUIRED");
  });

  test("policy MARK is the default", () => {
    expect(TS_POLICY.DEFAULT).toBe("MARK");
    expect(resolveReadingTs({ deviceTs: null, nowMs: NOW }).ok).toBe(true);
  });

  test("a device-stamped reading is accepted under EITHER policy", () => {
    // Rejecting must only ever affect undated readings, never a valid device.
    for (const policy of [TS_POLICY.DEFAULT, TS_POLICY.REJECT]) {
      expect(resolveReadingTs({ deviceTs: NOW - 1000, nowMs: NOW, policy }).ok).toBe(true);
    }
  });
});

describe("clock sanity", () => {
  test("a future timestamp beyond the skew window is refused", () => {
    const d = resolveReadingTs({ deviceTs: NOW + MAX_FUTURE_SKEW_MS + 60_000, nowMs: NOW });
    expect(d.ok).toBe(false);
    if (d.ok) return;
    expect(d.code).toBe("TS_FUTURE");
  });

  test("a timestamp inside the skew window is tolerated", () => {
    // Devices do drift; refusing everything ahead of us would fail a fleet with
    // ordinary clock error.
    expect(resolveReadingTs({ deviceTs: NOW + MAX_FUTURE_SKEW_MS, nowMs: NOW }).ok).toBe(true);
  });

  test("a long-past timestamp is accepted (a replayed buffer is still real data)", () => {
    expect(resolveReadingTs({ deviceTs: NOW - 86_400_000, nowMs: NOW }).ok).toBe(true);
  });
});

describe("provenance", () => {
  // An INFERRED threshold that does not say so is a guess someone will later
  // mistake for a specification.
  test("the contract records that it is INFERRED, with who to confirm it with", () => {
    expect(TS_CONTRACT_PROVENANCE.source).toBe("INFERRED");
    expect(TS_CONTRACT_PROVENANCE.rationale.length).toBeGreaterThan(0);
    expect(TS_CONTRACT_PROVENANCE.confirmWith.length).toBeGreaterThan(0);
  });

  test("the rationale states the dedup limit explicitly", () => {
    expect(TS_CONTRACT_PROVENANCE.rationale).toContain("ONLY for device-stamped");
  });
});
