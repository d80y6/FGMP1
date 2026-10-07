/**
 * Command idempotency — PURE decision core.
 *
 * ── WHAT THIS FIXES ────────────────────────────────────────────────────────
 * Nothing in the control path recognised a replayed request. An operator on a
 * flaky connection double-taps START, or a NOC console retries, and the same
 * command is issued twice. For a generator start that is a real hazard.
 *
 * `interlock-enforce.ts` now detects a same-command duplicate inside a short
 * window, but two things are missing and both are load-bearing:
 *
 *   1. It cannot distinguish a RETRY from a deliberate second command issued
 *      seconds later. "Stop the generator, then stop it again" is not a replay;
 *      suppressing it would be wrong.
 *   2. It cannot REJECT a replay whose payload differs. Reusing one key for two
 *      different commands is a client bug, and answering it with the first
 *      outcome would hide that bug behind a success response.
 *
 * A caller-supplied Idempotency-Key solves both, because it is an explicit
 * statement of "this is the same logical request". The key is the identity; the
 * payload is the check.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 * No database, no Prisma, no HTTP. This decides; the route and the persistence
 * layer apply. That keeps the three rules that matter — replay returns the
 * ORIGINAL outcome, same-key-different-payload is rejected, keys are scoped to
 * the caller and a window — provable without a server.
 */

/** How long a key remains replayable. */
export const DEFAULT_KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * The recorded outcome of a command that has already been accepted.
 *
 * Returned verbatim on a replay. This is the whole point of idempotency: the
 * caller learns what actually happened, rather than a synthesised success that
 * implies the request was freshly executed.
 */
export interface RecordedOutcome {
  commandId: string;
  status: string;
  result: unknown;
  issuedAt: Date;
}

/** A previously accepted request, as stored alongside its key. */
export interface IdempotencyRecord {
  key: string;
  /** Digest of the payload this key was first used with. */
  payloadFingerprint: string;
  /** Who issued it. A key is scoped to its author. */
  issuedById: string;
  issuedAt: Date;
  outcome: RecordedOutcome;
}

export type IdempotencyDecision =
  /** No key supplied — proceed normally. Absence of a key is not an error. */
  | { kind: "proceed" }
  /** Fresh key: execute, then record the outcome against it. */
  | { kind: "execute"; key: string; fingerprint: string }
  /**
   * Same key, same payload: return the ORIGINAL outcome and execute nothing.
   * This is the case that prevents a double-issued START.
   */
  | { kind: "replay"; record: IdempotencyRecord }
  /** Same key, different payload: a client bug, and it must be refused. */
  | { kind: "payload-mismatch"; existingFingerprint: string; incomingFingerprint: string }
  /** Key is older than the TTL: treat as a new request. */
  | { kind: "expired"; key: string; fingerprint: string };

/**
 * Decide what to do with an incoming request that may carry a replay of an
 * earlier one.
 *
 * `now` is injected so every decision is deterministic and replayable.
 *
 * Ordering matters and is deliberate:
 *   1. no key            -> proceed (back-compat: every existing client)
 *   2. unknown key       -> execute
 *   3. known key, expired -> execute; a key cannot resurrect months later
 *   4. known key, payload differs -> reject
 *   5. known key, payload matches  -> replay, execute nothing
 *
 * The expiry check precedes the payload check on purpose: once a key is out of
 * its window it is no longer the same logical request, so comparing payloads
 * against a stale record would reject a legitimate new command.
 */
export function decideIdempotency(args: {
  key: string | null | undefined;
  fingerprint: string;
  issuedById: string;
  existing?: IdempotencyRecord | null;
  now: Date;
  ttlMs?: number;
}): IdempotencyDecision {
  const { key, fingerprint, issuedById, existing, now } = args;
  const ttlMs = args.ttlMs ?? DEFAULT_KEY_TTL_MS;

  // (1) No key. Not an error — the overwhelming majority of existing clients
  // send none, and demanding one would break the control path for all of them.
  if (typeof key !== "string" || key.trim() === "") {
    return { kind: "proceed" };
  }

  const cleanKey = key.trim();

  // (2) Unknown key: first use.
  if (!existing) {
    return { kind: "execute", key: cleanKey, fingerprint };
  }

  // (3) Expired. Deliberately checked before the payload comparison.
  if (now.getTime() - existing.issuedAt.getTime() >= ttlMs) {
    return { kind: "expired", key: cleanKey, fingerprint };
  }

  // A key is scoped to its author. If a different user presents someone else's
  // key, that is not a replay — it is a client bug or an attempt to read another
  // operator's outcome. Refuse it rather than returning their result.
  if (existing.issuedById !== issuedById) {
    return {
      kind: "payload-mismatch",
      existingFingerprint: "<owned by another user>",
      incomingFingerprint: fingerprint,
    };
  }

  // (4) Same key, different payload: a client reusing a key for a different
  // command. Returning the first outcome here would disguise that bug as a
  // successful retry.
  if (existing.payloadFingerprint !== fingerprint) {
    return {
      kind: "payload-mismatch",
      existingFingerprint: existing.payloadFingerprint,
      incomingFingerprint: fingerprint,
    };
  }

  // (5) Genuine replay.
  return { kind: "replay", record: existing };
}

/**
 * Build the payload fingerprint stored against a key.
 *
 * A short digest rather than the raw body: it is fixed-width, it does not turn
 * a column into a store of arbitrary client input, and it is enough to detect
 * the same-key-different-payload case. Field order is normalised so that a client
 * which serialises the same object differently is not falsely flagged.
 */
export function fingerprintPayload(
  parts: { command: string; generatorId?: string; reason?: string | null },
): string {
  const canonical = JSON.stringify({
    command: parts.command,
    generatorId: parts.generatorId ?? null,
    reason: parts.reason ?? null,
  });
  return hashString(canonical);
}

/**
 * FNV-1a, rendered base36.
 *
 * Chosen for being tiny, dependency-free and stable across runs. NOT a
 * cryptographic hash and it is not used as one: this guards against a client
 * accidentally reusing a key, not against an adversary choosing a colliding
 * payload. A collision would let a genuinely different command be answered with
 * an earlier outcome — worth noting, and the reason the same-key-different-payload
 * case is still worth handling explicitly rather than relying on the digest alone.
 */
export function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Human-readable reason code for a refusal, stable enough for clients to match on. */
export function idempotencyRefusalCode(decision: IdempotencyDecision): string | null {
  if (decision.kind !== "payload-mismatch") return null;
  return "IDEMPOTENCY_KEY_CONFLICT";
}