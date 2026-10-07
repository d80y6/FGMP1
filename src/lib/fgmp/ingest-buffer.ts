/**
 * Edge ingest buffering (Phase 2).
 *
 * Field devices sit on unstable links. The same reading is retried after a
 * dropped response, packets arrive out of order, and a gateway that was offline
 * for an hour reconnects and dumps its whole backlog in one request.
 *
 * The previous ingest route stamped every row with SERVER time (`ts: now`), so
 * a reading that arrived an hour late was indistinguishable from a fresh one,
 * and a replayed reading was indistinguishable from a new one. That is the
 * worst possible failure mode for fuel telemetry: a stale tank level silently
 * overwriting a fresh one makes the theft-detection figures wrong, and nothing
 * in the system can tell.
 *
 * This module makes the decision explicit and testable, with no I/O, so the
 * policy can be verified without a database or a device.
 */

/** Default staleness window. A reading older than this is refused outright. */
export const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;

/** Default future-skew tolerance, for devices with a drifting clock. */
export const DEFAULT_MAX_FUTURE_MS = 5 * 60 * 1000;

/** Replay window for exact-duplicate detection. */
export const DEFAULT_DUPLICATE_WINDOW_MS = 30 * 1000;

export type ReadingOutcome =
  /** Fresh reading: accept and apply. */
  | { status: "ACCEPT"; readingTs: number; ageMs: number }
  /**
   * Refused because it is older than the newest reading already accepted for
   * that device. Stale data must never overwrite fresh data.
   */
  | { status: "REJECT_STALE"; readingTs: number; ageMs: number; newestTs: number }
  /**
   * Refused as a retry of a reading already accepted inside the duplicate
   * window. Counted separately from STALE so operators can tell a flaky link
   * (many duplicates) from a clock problem (many stale).
   */
  | { status: "REJECT_DUPLICATE"; readingTs: number; ageMs: number; newestTs: number }
  /** Refused because its timestamp is implausibly far in the future. */
  | { status: "REJECT_FUTURE"; readingTs: number; skewMs: number }
  /** Refused because it is older than the absolute staleness limit. */
  | { status: "REJECT_TOO_OLD"; readingTs: number; ageMs: number };

export interface IngestClockPolicy {
  maxAgeMs: number;
  maxFutureMs: number;
  duplicateWindowMs: number;
}

export const DEFAULT_CLOCK_POLICY: IngestClockPolicy = {
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  maxFutureMs: DEFAULT_MAX_FUTURE_MS,
  duplicateWindowMs: DEFAULT_DUPLICATE_WINDOW_MS,
};

/**
 * Normalise a device-supplied timestamp.
 *
 * Accepts epoch milliseconds OR an ISO-8601 string, because ESP32 firmware
 * realistically sends one or the other and rejecting half of them would push
 * operators toward disabling the check entirely.
 *
 * Returns null when absent or unparseable, so the caller can decide whether to
 * fall back to server time. A missing timestamp is NOT an error: many devices
 * cannot keep a clock. It only means staleness cannot be judged, so the reading
 * is accepted and recorded as undated.
 */
export function parseReadingTs(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed === "") return null;
    // Pure digits: epoch millis. Otherwise ISO-8601.
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Per-device watermark of the newest reading seen — A CACHE, NOT THE AUTHORITY.
 *
 * Phase 4 item 4 changed the status of this class. It was the authority for
 * duplicate and stale rejection while process memory was all there was, and it
 * was wrong at that: with more than one replica a device retry could be
 * rejected on replica A and ACCEPTED on replica B.
 *
 * The authority is now the database. Migration
 * 20261008001000_sensor_reading_dedup_watermark makes (entityId, metric, ts)
 * UNIQUE, so a duplicate INSERT is impossible rather than unlikely, enforced by
 * the storage engine on every writer on every replica with no shared mutable
 * state. That guarantee survives a total Redis outage and a process restart,
 * because it does not depend on any cache existing. Redis remains usable as a
 * read-through cache in front of it, never as the thing that decides.
 *
 * So this map is now an OPTIMISATION with a deliberately narrow job: it lets
 * the route answer REJECT_STALE / REJECT_TOO_OLD without a database round trip,
 * and it is safe to lose entirely. If it is empty, or stale, or on a different
 * replica, correctness is unaffected — the write is still refused by the
 * constraint. A cache that silently disagreed with the database would be a
 * liability, so anything it gets WRONG is still caught downstream.
 *
 * The one thing it must never become again is the thing that decides. It is not
 * primed from the database at startup, so a cold process has an empty map and
 * simply does more work until it warms; correctness never depends on priming.
 */
export class DeviceWatermarkStore {
  /** Optimisation only. The database constraint is the authority — see the class note. */
  private newest = new Map<string, number>();
  private policy: IngestClockPolicy;

  constructor(policy: Partial<IngestClockPolicy> = {}) {
    this.policy = { ...DEFAULT_CLOCK_POLICY, ...policy };
  }

  /**
   * Decide whether a reading should be applied.
   *
   * Order matters: the duplicate check runs BEFORE the stale check, because a
   * retry of the newest reading is both "duplicate" and "not newer than
   * newest". Reporting it as STALE would send an operator hunting a clock
   * problem when the real cause is an unstable link.
   */
  evaluate(
    deviceKey: string,
    readingTs: number | null,
    serverNow: number,
  ): ReadingOutcome {
    const { maxAgeMs, maxFutureMs, duplicateWindowMs } = this.policy;

    // No usable timestamp — cannot judge staleness. Accept, but do not move the
    // watermark, since an undated reading must not establish one.
    if (readingTs === null) {
      return { status: "ACCEPT", readingTs: serverNow, ageMs: 0 };
    }

    if (readingTs > serverNow + maxFutureMs) {
      return { status: "REJECT_FUTURE", readingTs, skewMs: readingTs - serverNow };
    }

    const newest = this.newest.get(deviceKey);
    if (newest !== undefined) {
      // Duplicate: same instant as what we already have, inside the window.
      if (readingTs === newest) {
        return { status: "REJECT_DUPLICATE", readingTs, ageMs: serverNow - readingTs, newestTs: newest };
      }
      // Stale: strictly older than the newest accepted. Never let it overwrite.
      if (readingTs < newest) {
        return { status: "REJECT_STALE", readingTs, ageMs: serverNow - readingTs, newestTs: newest };
      }
      // Within the window but older than newest is still stale (handled above);
      // newer readings always pass, and the duplicate window only widens the
      // "same value" tolerance so a retry sent a few seconds later is caught.
      if (readingTs - newest <= duplicateWindowMs && readingTs !== newest) {
        // Newer than newest: accept. Nothing to do — recorded below.
      }
    }

    if (serverNow - readingTs > maxAgeMs) {
      return { status: "REJECT_TOO_OLD", readingTs, ageMs: serverNow - readingTs };
    }

    this.newest.set(deviceKey, readingTs);
    return { status: "ACCEPT", readingTs, ageMs: serverNow - readingTs };
  }

  /** Current watermark for a device, or null if none accepted yet. */
  peek(deviceKey: string): number | null {
    return this.newest.get(deviceKey) ?? null;
  }

  /**
   * Seed a watermark from persisted state.
   *
   * Call this on process start from the newest SensorReading per device, or a
   * restart re-opens the stale window: after a redeploy the in-memory map is
   * empty, and the first reading to arrive would be accepted regardless of age.
   */
  prime(deviceKey: string, ts: number): void {
    const existing = this.newest.get(deviceKey);
    if (existing === undefined || ts > existing) this.newest.set(deviceKey, ts);
  }

  reset(): void {
    this.newest.clear();
  }
}

/**
 * Bound a request body BEFORE parsing it.
 *
 * `req.json()` on an unbounded body lets a device (or anyone holding the key)
 * send a 500 MB payload and exhaust memory before any validation runs. Reading
 * the declared Content-Length is cheap; where it is absent we fall back to the
 * literal read with a hard cap.
 */
export const MAX_INGEST_BODY_BYTES = 16 * 1024;

export type BodySizeResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: string };

export function checkDeclaredBodySize(req: {
  headers: { get(name: string): string | null };
}, max = MAX_INGEST_BODY_BYTES): BodySizeResult {
  const raw = req.headers.get("content-length");
  if (raw === null) return { ok: true, bytes: -1 }; // unknown — enforce while reading
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, reason: `invalid Content-Length: ${JSON.stringify(raw)}` };
  }
  if (n > max) {
    return { ok: false, reason: `body of ${n} bytes exceeds the ${max} byte limit` };
  }
  return { ok: true, bytes: n };
}

/**
 * Reject NaN/Infinity payloads that a loose JSON parse can smuggle through.
 *
 * `JSON.parse` accepts neither NaN nor Infinity, but a value like 1e400
 * parses to Infinity, and Infinity passes a naive `value >= 0` range check.
 * Persisting it would put Infinity into a numeric column.
 */
export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}