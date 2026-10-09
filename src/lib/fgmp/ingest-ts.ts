/**
 * The ingest timestamp contract.
 *
 * ── THE DEFECT THIS FIXES ────────────────────────────────────────────────────
 * `SensorReading` carries `@@unique([entityId, metric, ts])` — the database-level
 * guarantee that a retried reading is not stored twice. That guarantee is only as
 * good as `ts`.
 *
 * The route previously did `new Date(deviceTs ?? nowMs)`. A device that omitted
 * `ts` therefore got SERVER time as its identity, so a retry of the same logical
 * reading produced a DIFFERENT `ts`, missed the unique constraint, and was
 * accepted as new data. Verified: two inserts of the same reading, each with a
 * per-insert `now()` in separate transactions, both succeeded.
 *
 * The consequence is not one bad row. `ts` is the identity of the measurement, so
 * every guarantee built on dedup — replay safety, the unique constraint, the
 * watermark — silently inherited a fiction, and duplicate readings accumulated
 * forever without any signal that they were duplicates.
 *
 * ── THE DECISION: ACCEPT BUT MARK (option 2) ────────────────────────────────
 * PROVENANCE: INFERRED. No supplied specification defines an ingest timestamp
 * contract — the previous behaviour was simply whatever the code did.
 * CONFIRM WITH: whoever owns the device firmware fleet and the ingest
 * specification. If a real contract exists that this contradicts, the flag
 * default below should change.
 *
 * Chosen over rejecting outright, because the blast radius of rejection is real:
 * `ts` is optional in the existing payload contract, so rejecting would fail
 * every legacy device in the fleet the day it ships, turning a data-quality
 * improvement into an outage on a platform whose purpose is fuel and generator
 * monitoring.
 *
 * Chosen over "reject immediately", because the operator-facing value of marking
 * is that the blind spot becomes MEASURABLE. Under the old behaviour an
 * undated reading was indistinguishable from a timestamped one at every layer
 * downstream. Now a query can find them, count them, and alarm on a device that
 * has been replaying an unsynced clock buffer for a month.
 *
 * The honest limit of this decision: an undated row still cannot be deduplicated
 * against ITSELF, because two retries get two different server times. The UNIQUE
 * constraint is NOT claimed for undated rows — it is only claimed for
 * device-stamped ones. Marking makes that limit visible instead of pretending it
 * is absent, which is the most that can be done without breaking the fleet.
 *
 * Staged rejection (option 3) is available for an operator who has measured their
 * fleet: set the site flag below to REJECT and the same rollout happens
 * deliberately, per site, with the device owner in the loop.
 */

/**
 * What to do with a reading that carries no device timestamp.
 *
 * MARK   — accept with server time, record tsSource=SERVER. Default, because the
 *          existing payload contract makes `ts` optional and rejecting outright
 *          would fail the whole legacy fleet on deploy.
 * REJECT — refuse with 422. For a fleet that has been migrated and verified.
 */
export const TS_POLICY = {
  DEFAULT: "MARK",
  REJECT: "REJECT",
} as const;

export type TsSource = "DEVICE" | "SERVER";
export type TsPolicy = (typeof TS_POLICY)[keyof typeof TS_POLICY];

/** How far a device clock may lead before the reading is refused as a forgery. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type TsDecision =
  | { ok: true; readingTs: Date; source: "DEVICE" | "SERVER"; dedupGuaranteed: boolean }
  | { ok: false; status: number; error: string; code: string };

/** Parse a device-supplied timestamp. Returns null when absent or unusable. */
export function parseDeviceTs(raw: unknown, nowMs: number): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // Devices send seconds or milliseconds. Anything below ~1e11 is far too
    // small to be milliseconds for any plausible date, so it is seconds.
    const ms = raw < 1e11 ? raw * 1000 : raw;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return null;
    // A string that parses to the epoch is a malformed value, not a real 1970
    // reading, and accepting it would collide with a legitimate row.
    return parsed <= 0 ? null : parsed;
  }
  return null;
}

/**
 * Decide how to handle a reading's timestamp.
 *
 * `policy` is per-site so an operator can stage the change; see the module
 * comment for why MARK is the default.
 */
export function resolveReadingTs(params: {
  deviceTs: number | null;
  nowMs: number;
  policy?: TsPolicy;
}): TsDecision {
  const policy = params.policy ?? TS_POLICY.DEFAULT;

  if (params.deviceTs === null) {
    if (policy === TS_POLICY.REJECT) {
      return {
        ok: false,
        status: 422,
        error:
          "Reading has no device timestamp. `ts` is the identity of a measurement: " +
          "without it a retry cannot be deduplicated, so this reading is refused. " +
          "Supply `ts` (ISO 8601 or epoch seconds/milliseconds), or set this site's " +
          "tsPolicy to MARK if the device genuinely cannot supply one.",
        code: "TS_REQUIRED",
      };
    }
    return {
      ok: true,
      // Server time is the only value available, but it is NOT the reading's
      // identity and the row says so.
      readingTs: new Date(params.nowMs),
      source: "SERVER",
      // Explicitly NOT guaranteed. A retry of this same reading will land on a
      // different server timestamp and be accepted again. Recording that here
      // keeps the claim honest instead of letting the unique constraint imply it.
      dedupGuaranteed: false,
    };
  }

  const ts = params.deviceTs;

  // A clock more than MAX_FUTURE_SKEW_MS ahead is not a skewed clock; it is a
  // value that will never sort correctly against real history.
  if (ts > params.nowMs + MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      status: 422,
      error: `Device timestamp is more than ${Math.round(MAX_FUTURE_SKEW_MS / 1000)}s in the future.`,
      code: "TS_FUTURE",
    };
  }

  return {
    ok: true,
    readingTs: new Date(ts),
    source: "DEVICE",
    // Only device-stamped readings carry a real dedup guarantee.
    dedupGuaranteed: true,
  };
}

/**
 * Human-readable provenance for the ingest contract, so the decision is not
 * invisible to the next person who reads this code.
 */
export const TS_CONTRACT_PROVENANCE = {
  source: "INFERRED" as const,
  rationale:
    "No supplied specification defines an ingest timestamp contract. The previous " +
    "behaviour (default to server time) silently defeated the UNIQUE(entityId, " +
    "metric, ts) dedup guarantee for any device that omitted `ts`. Rejecting " +
    "outright would fail the whole legacy fleet, because `ts` is optional in the " +
    "existing payload contract, so undated readings are accepted and MARKED " +
    "instead. The dedup guarantee is claimed ONLY for device-stamped rows.",
  confirmWith:
    "the owner of the device firmware fleet and whoever specifies the ingest " +
    "payload contract. If a real contract exists that this contradicts, change " +
    "TS_POLICY.DEFAULT.",
} as const;
