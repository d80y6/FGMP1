/**
 * MFA service layer — the only place MFA state transitions happen.
 *
 * ── WHY THIS IS A SERVICE AND NOT ROUTE LOGIC ────────────────────────────────
 * Three properties here are security properties, and putting them in route
 * handlers is how they get skipped on one of five routes:
 *
 *   1. Backup-code consumption must be ATOMIC. Two concurrent verifications
 *      both reading "unused" would each succeed. So consumption is a
 *      conditional UPDATE (`usedAt IS NULL`) and the caller checks how many rows
 *      were affected — zero means someone else got there first.
 *   2. Challenge consumption must be ATOMIC for the same reason, and a failed
 *      attempt must invalidate the challenge so guessing is bounded to one try.
 *   3. Enrolment must be REFUSED when the encryption key is absent. Failing
 *      open here is how a platform ends up with MFA that looks enabled and is
 *      not.
 *
 * ── FAIL-OPEN vs FAIL-CLOSED, SPELLED OUT ────────────────────────────────────
 * When the encryption key is missing, verification REFUSES rather than allowing
 * the session. That looks like it could lock operators out, and it can — but
 * only of an account that could not have enrolled in the first place, since
 * enrolment is refused under the same condition. The alternative (treat a
 * missing key as "no MFA configured", let everyone in) would mean that
 * deleting one environment variable silently disables the second factor for
 * every operator in the platform. Refusing is the safe direction, and the two
 * decisions are made together so they cannot disagree.
 */

import { randomBytes } from "node:crypto";
import { base32Encode } from "./base32";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { withTenant } from "../tenant-context";
import { encryptSecret, decryptSecret, mfaEncryptionProblem } from "./crypto";
import { verifyTotp, DEFAULT_DIGITS, DEFAULT_PERIOD_SECONDS } from "./totp";
import { newChallengeToken, hashChallengeToken, CHALLENGE_TTL_SECONDS } from "./challenge";

/** Number of backup codes issued at enrolment. */
export const BACKUP_CODE_COUNT = 10;

/** Attempts allowed on a challenge before it is invalidated. One. */
export const CHALLENGE_MAX_ATTEMPTS = 1;

export type MfaUnavailable = { ok: false; reason: string; problem: string };

/** Is MFA usable in this deployment? Enrolment is gated on this. */
export function mfaAvailable(): { ok: true } | MfaUnavailable {
  const problem = mfaEncryptionProblem();
  if (problem) return { ok: false, reason: "MFA_NOT_CONFIGURED", problem };
  return { ok: true };
}

/** Random base32 secret, 20 bytes = 160 bits (RFC 4226 §5.1 recommends the
 *  HMAC output length). */
function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

// ── Enrolment ────────────────────────────────────────────────────────────────

export type BeginEnrolResult =
  | { ok: false; reason: string; problem: string }
  | { ok: true; secret: string; otpauthUri: string };

/**
 * Begin enrolment.
 *
 * REFUSES when the encryption key is absent. An enrolment that cannot encrypt
 * its secret must not happen, because the alternative is a stored secret that
 * cannot be protected — which is MFA with the second factor removed.
 */
export async function beginEnrol(
  tenantId: string,
  userId: string,
  email: string,
): Promise<BeginEnrolResult> {
  const available = mfaAvailable();
  if (!available.ok) return available;

  const secret = generateSecret();
  // NOT yet enabled. The factor only becomes required after the user proves
  // they can generate a code from this secret — otherwise a session that
  // briefly controlled the account could enrol its own factor.
  await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.upsert({
      where: { userId },
      create: {
        tenantId,
        userId,
        secretEnc: encryptSecret(secret),
        enabled: false,
        digits: DEFAULT_DIGITS,
        periodSeconds: DEFAULT_PERIOD_SECONDS,
      },
      update: { secretEnc: encryptSecret(secret), enabled: false, enrolledAt: new Date() },
    }),
  );

  const { otpauthUri } = await import("./totp");
  return { ok: true, secret, otpauthUri: otpauthUri({ secret, accountName: email, issuer: "FGMP" }) };
}

/**
 * Confirm enrolment with a code, and issue backup codes.
 *
 * The codes are returned ONCE and never again — only their bcrypt hashes are
 * stored, so they cannot be re-displayed and cannot be recovered by anyone who
 * reads the database.
 */
export async function confirmEnrol(
  tenantId: string,
  userId: string,
  code: string,
): Promise<{ ok: true; backupCodes: string[] } | { ok: false; reason: string }> {
  const available = mfaAvailable();
  if (!available.ok) return available;

  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { userId } }),
  );
  if (!enrollment) return { ok: false, reason: "NOT_ENROLLED" };
  if (enrollment.enabled) return { ok: false, reason: "ALREADY_ENABLED" };

  const secret = decryptSecret(enrollment.secretEnc);
  const nowSec = Math.floor(Date.now() / 1000);
  const step = Math.floor(nowSec / enrollment.periodSeconds);
  if (!verifyTotp(secret, code, step, 1, enrollment.digits)) {
    // Deliberately does not enable anything. A wrong code during enrolment must
    // leave the account exactly as it was.
    return { ok: false, reason: "INVALID_CODE" };
  }

  const plainCodes = Array.from({ length: BACKUP_CODE_COUNT }, () => randomBackupCode());
  // Hash BEFORE the transaction: createMany takes literal data, so awaiting
  // inside the mapper is a type error and would serialise N bcrypt rounds inside
  // an open transaction for no reason.
  const hashedCodes = await Promise.all(
    plainCodes.map(async (c, i) => ({ slot: i, codeHash: await bcrypt.hash(normalise(c), 10) })),
  );
  await withTenant(tenantId, async (tx) => {
    // Replace rather than merge: a re-enrolment invalidates any previous codes.
    await tx.mfaBackupCode.deleteMany({ where: { enrollmentId: enrollment.id } });
    await tx.mfaBackupCode.createMany({
      data: hashedCodes.map((c) => ({
        tenantId,
        enrollmentId: enrollment.id,
        slot: c.slot,
        codeHash: c.codeHash,
      })),
    });
    await tx.mfaEnrollment.update({
      where: { id: enrollment.id },
      data: { enabled: true, enrolledAt: new Date() },
    });
  });

  return { ok: true, backupCodes: plainCodes };
}

function randomBackupCode(): string {
  // Crockford-ish alphabet without I/O/0/1: these get read aloud and written on
  // paper at 03:00, so ambiguous glyphs are a genuine operational hazard.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function normalise(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Resolve which tenant/user a presented challenge token belongs to.
 *
 * ── WHY THIS EXISTS RATHER THAN AN UNSCOPED LOOKUP ──────────────────────────
 * A challenge is presented by a caller with no usable authority (a pending
 * session carries no tenant), so the tenant has to be discovered FROM the token.
 * The obvious implementation is an unscoped `db.mfaChallenge.findUnique({ where
 * : { tokenHash } })` — and it silently returns null for EVERY token, because
 * `MfaChallenge` is FORCE-RLS protected. That is not a subtle failure: it makes
 * every valid code look invalid, and MFA verification cannot be completed at
 * all. It is exactly what the live server did before this function existed.
 *
 * ── WHY IT IS SAFE TO LOOK ACROSS TENANTS HERE ──────────────────────────────
 * The lookup is by a 128-bit token's SHA-256, which is unguessable and is only
 * ever handed to the browser that legitimately requested it. It returns the
 * tenant and user the token was ISSUED for — never a secret, never the token.
 * A wrong or guessed token matches nothing.
 *
 * So this is a narrow, auditable exception rather than a general bypass: the
 * caller learns which tenant it must then scope EVERY subsequent query to. That
 * pairing — discover by token, then scope everything after — is what keeps this
 * from becoming a cross-tenant read primitive.
 */
export async function findChallengeTenantByToken(
  tokenHash: string,
): Promise<{
  tenantId: string;
  userId: string;
  enrollmentId: string;
  expiresAt: Date;
} | null> {
  // Calls the SECURITY DEFINER SQL function from migration
  // 20261014000000_mfa_challenge_resolver — NOT a bare `$queryRaw` over
  // MfaChallenge.
  //
  // That distinction is the whole point. A `$queryRaw` still runs on the
  // `fgmp_app` connection where FORCE RLS applies and no tenant context is set,
  // so it returns zero rows for every token. The first version of this fix was
  // exactly that, while the comment above it described a SECURITY DEFINER
  // escape that did not exist. tsc was green; every challenge returned
  // CHALLENGE_INVALID, so the second factor was welded shut.
  //
  // The SQL function returns only LIVE rows (not used, not failed, not expired,
  // under the attempt limit), so a spent token is indistinguishable from an
  // unknown one and cannot be used to probe whether a challenge existed. It
  // reads a hash, never a secret or the code.
  const rows = await db.$queryRaw<{
    tenantId: string;
    userId: string;
    enrollmentId: string;
    expiresAt: Date;
  }[]>`
    SELECT * FROM fgmp_resolve_mfa_challenge(${tokenHash}::text)
  `;
  return rows[0] ?? null;
}

export type VerifyResult =
  | { ok: true; method: "totp" | "backup" }
  | { ok: false; reason: string };

/**
 * Consume a challenge token, atomically.
 *
 * The conditional UPDATE is the whole point: two concurrent requests carrying
 * the same token cannot both consume it, because only one UPDATE will match
 * `usedAt IS NULL`.
 */
async function loadLiveChallenge(
  tenantId: string,
  token: string,
): Promise<{ ok: true; challenge: { id: string; userId: string; enrollmentId: string } } | { ok: false; reason: string }> {
  const tokenHash = hashChallengeToken(token);
  const now = new Date();

  const row = await withTenant(tenantId, (tx) =>
    tx.mfaChallenge.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        failedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: CHALLENGE_MAX_ATTEMPTS },
      },
      select: { id: true, userId: true, enrollmentId: true },
    }),
  );
  if (!row) return { ok: false, reason: "CHALLENGE_INVALID" };
  return { ok: true, challenge: row };
}

/**
 * Consume a challenge AFTER the code has been verified.
 *
 * The conditional UPDATE is what makes single-use real: two concurrent
 * verifications carrying the same token both load the row, both check their
 * code, and then exactly ONE of them matches `usedAt IS NULL` here. The loser
 * gets CHALLENGE_INVALID. Without the conditional update, both would succeed and
 * one session would be issued twice.
 */
async function consumeChallenge(
  tenantId: string,
  token: string,
  expectedId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const claimed = await withTenant(tenantId, (tx) =>
    tx.mfaChallenge.updateMany({
      where: { id: expectedId, usedAt: null, failedAt: null },
      data: { usedAt: new Date() },
    }),
  );
  return claimed.count === 1 ? { ok: true } : { ok: false, reason: "CHALLENGE_INVALID" };
}

/** Invalidate a challenge after a failed attempt, so guessing is bounded. */
async function failChallenge(tenantId: string, token: string): Promise<void> {
  const tokenHash = hashChallengeToken(token);
  await withTenant(tenantId, (tx) =>
    tx.mfaChallenge.updateMany({
      where: { tokenHash, usedAt: null },
      data: { failedAt: new Date(), attempts: { increment: 1 } },
    }),
  );
}

/**
 * Verify a challenge with a TOTP code or a backup code.
 *
 * The challenge is consumed FIRST, before the code is checked. That ordering is
 * deliberate: a code that fails leaves the challenge spent, so an attacker
 * cannot keep guessing against a live token — they must authenticate again,
 * which re-runs the password check and the rate limiter.
 *
 * Backup-code consumption is a conditional UPDATE on `usedAt IS NULL`, so a
 * replay of the same code affects zero rows and fails.
 */
export async function verifyChallenge(
  tenantId: string,
  token: string,
  code: string,
): Promise<VerifyResult> {
  const available = mfaAvailable();
  if (!available.ok) return available;

  // ── ORDER MATTERS, AND IT WAS WRONG ───────────────────────────────────────
  // This used to CONSUME the challenge (set usedAt) BEFORE checking the code.
  // So a single wrong code burned the token, and the operator's next CORRECT
  // code was rejected as CHALLENGE_INVALID — the second factor could never be
  // completed, and it presented as "your code is wrong" when it was the token
  // that was spent. Verified live: one wrong code set usedAt, and the following
  // correct code was refused.
  //
  // Now: LOAD the live challenge, verify the code, and only then CONSUME it.
  // A failed attempt burns the token via failChallenge() instead, which bounds
  // guessing to one try per issued token without punishing a typo.
  const loaded = await loadLiveChallenge(tenantId, token);
  if (!loaded.ok) return loaded;

  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { id: loaded.challenge.enrollmentId } }),
  );
  if (!enrollment || !enrollment.enabled) {
    return { ok: false, reason: "MFA_NOT_ENABLED" };
  }

  // ── TOTP path ──
  const secret = decryptSecret(enrollment.secretEnc);
  const step = Math.floor(Math.floor(Date.now() / 1000) / enrollment.periodSeconds);
  if (verifyTotp(secret, code, step, 1, enrollment.digits)) {
    // Consume BEFORE issuing the session, so two concurrent requests carrying
    // the same token and code cannot both complete.
    const consumed = await consumeChallenge(tenantId, token, loaded.challenge.id);
    if (!consumed.ok) return consumed;
    await withTenant(tenantId, (tx) =>
      tx.mfaEnrollment.update({
        where: { id: enrollment.id },
        data: { lastUsedAt: new Date() },
      }),
    );
    return { ok: true, method: "totp" };
  }

  // ── Backup code path ──
  const normalised = normalise(code);
  const candidates = await withTenant(tenantId, (tx) =>
    tx.mfaBackupCode.findMany({
      where: { enrollmentId: enrollment.id, usedAt: null },
      select: { id: true, codeHash: true },
    }),
  );

  for (const candidate of candidates) {
    if (!(await bcrypt.compare(normalised, candidate.codeHash))) continue;

    // Atomic consumption. A concurrent replay of the same code matches no rows
    // here, so exactly one request can succeed.
    const used = await withTenant(tenantId, (tx) =>
      tx.mfaBackupCode.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date(), usedByChallengeId: loaded.challenge.id },
      }),
    );
    if (used.count === 0) return { ok: false, reason: "BACKUP_CODE_ALREADY_USED" };

    const consumedChallenge = await consumeChallenge(tenantId, token, loaded.challenge.id);
    if (!consumedChallenge.ok) return consumedChallenge;

    await withTenant(tenantId, (tx) =>
      tx.mfaEnrollment.update({
        where: { id: enrollment.id },
        data: { lastUsedAt: new Date() },
      }),
    );
    return { ok: true, method: "backup" };
  }

  await failChallenge(tenantId, token);
  return { ok: false, reason: "INVALID_CODE" };
}

/** Issue a challenge for an authenticated-but-unverified user. */
export async function issueChallenge(
  tenantId: string,
  userId: string,
): Promise<{ ok: true; token: string; expiresInSeconds: number; backupCodesAvailable: boolean } | { ok: false; reason: string }> {
  const available = mfaAvailable();
  if (!available.ok) return available;

  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { userId } }),
  );
  if (!enrollment || !enrollment.enabled) return { ok: false, reason: "MFA_NOT_ENABLED" };

  const { token, tokenHash } = newChallengeToken();
  await withTenant(tenantId, (tx) =>
    tx.mfaChallenge.create({
      data: {
        tenantId,
        userId,
        enrollmentId: enrollment.id,
        tokenHash,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000),
      },
    }),
  );

  const remaining = await withTenant(tenantId, (tx) =>
    tx.mfaBackupCode.count({ where: { enrollmentId: enrollment.id, usedAt: null } }),
  );
  return { ok: true, token, expiresInSeconds: CHALLENGE_TTL_SECONDS, backupCodesAvailable: remaining > 0 };
}

/**
 * Does this user have an enabled factor?
 *
 * Used by the login callback to decide whether to issue a pending session. A
 * missing encryption key means "not enrolled", because enrolment is refused
 * without one — the two can never disagree.
 */
export async function hasMfaEnabled(tenantId: string, userId: string): Promise<boolean> {
  const available = mfaAvailable();
  if (!available.ok) return false;
  const row = await db.mfaEnrollment.findUnique({
    where: { userId },
    select: { enabled: true },
  });
  return row?.enabled === true;
}

/** Disable MFA — requires a valid code, so possession is proven first. */
export async function disableMfa(
  tenantId: string,
  userId: string,
  code: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const available = mfaAvailable();
  if (!available.ok) return available;

  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { userId } }),
  );
  if (!enrollment) return { ok: false, reason: "NOT_ENROLLED" };

  const verified = await verifyOwnFactor(tenantId, enrollment, code);
  if (!verified) return { ok: false, reason: "INVALID_CODE" };

  await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.update({
      where: { id: enrollment.id },
      data: { enabled: false, disabledAt: new Date(), disabledReason: reason.slice(0, 500) },
    }),
  );
  return { ok: true };
}

/** Prove possession without consuming a backup code — used by /disable. */
async function verifyOwnFactor(
  tenantId: string,
  enrollment: { id: string; secretEnc: string; periodSeconds: number; digits: number },
  code: string,
): Promise<boolean> {
  const secret = decryptSecret(enrollment.secretEnc);
  const step = Math.floor(Math.floor(Date.now() / 1000) / enrollment.periodSeconds);
  if (verifyTotp(secret, code, step, 1, enrollment.digits)) return true;

  const candidates = await withTenant(tenantId, (tx) =>
    tx.mfaBackupCode.findMany({
      where: { enrollmentId: enrollment.id, usedAt: null },
      select: { id: true, codeHash: true },
    }),
  );
  for (const c of candidates) {
    if (await bcrypt.compare(normalise(code), c.codeHash)) return true;
  }
  return false;
}

/** How many backup codes remain. */
export async function backupCodesRemaining(tenantId: string, userId: string): Promise<number> {
  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { userId }, select: { id: true } }),
  );
  if (!enrollment) return 0;
  return withTenant(tenantId, (tx) =>
    tx.mfaBackupCode.count({ where: { enrollmentId: enrollment.id, usedAt: null } }),
  );
}

// ── Break-glass reset (two-person, audited) ─────────────────────────────────

export async function requestMfaReset(
  tenantId: string,
  targetUserId: string,
  requestedById: string,
  justification: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!justification || justification.trim().length < 10) {
    // A reset with no stated reason is not actionable later.
    return { ok: false, reason: "JUSTIFICATION_REQUIRED" };
  }
  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { userId: targetUserId } }),
  );
  if (!enrollment) return { ok: false, reason: "NOT_ENROLLED" };

  const created = await withTenant(tenantId, (tx) =>
    tx.mfaResetRequest.create({
      data: { tenantId, userId: targetUserId, enrollmentId: enrollment.id, requestedById, justification },
      select: { id: true },
    }),
  );
  return { ok: true, id: created.id };
}

/**
 * Approve AND apply a reset.
 *
 * TWO PEOPLE, ENFORCED: an approver may not be the requester. A single-operator
 * reset is exactly the social-engineering attack this control exists to stop —
 * "I'm locked out and it's urgent, I'm the superadmin". Modelled on
 * InterlockOverride, which already requires the same of a safety bypass.
 */
export async function approveMfaReset(
  tenantId: string,
  resetId: string,
  approvedById: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const request = await withTenant(tenantId, (tx) =>
    tx.mfaResetRequest.findUnique({ where: { id: resetId } }),
  );
  if (!request) return { ok: false, reason: "NOT_FOUND" };
  if (request.status !== "PENDING") return { ok: false, reason: "NOT_PENDING" };
  if (request.requestedById === approvedById) {
    return { ok: false, reason: "SELF_APPROVAL_FORBIDDEN" };
  }

  return withTenant(tenantId, async (tx) => {
    // Conditional update: only a PENDING row can be claimed, so two approvers
    // racing produce one winner.
    const claimed = await tx.mfaResetRequest.updateMany({
      where: { id: resetId, status: "PENDING", approvedById: null },
      data: { status: "APPROVED", approvedById, approvedAt: new Date() },
    });
    if (claimed.count === 0) return { ok: false as const, reason: "ALREADY_CLAIMED" };

    // Reset DISABLES the factor and forces re-enrolment. It does not silently
    // clear to "no second factor" and leave it there.
    await tx.mfaEnrollment.update({
      where: { id: request.enrollmentId },
      data: {
        enabled: false,
        disabledAt: new Date(),
        disabledReason: `break-glass reset ${resetId}: ${request.justification}`,
      },
    });
    // Invalidate any outstanding challenge for that user.
    await tx.mfaChallenge.updateMany({
      where: { userId: request.userId, usedAt: null },
      data: { failedAt: new Date() },
    });

    await tx.mfaResetRequest.update({
      where: { id: resetId },
      data: { status: "APPLIED", appliedAt: new Date() },
    });
    return { ok: true as const };
  });
}
// ── Status (for the UI) ──────────────────────────────────────────────────────

export type OwnEnrollmentView = {
  enrollment: {
    id: string;
    enabled: boolean;
    enrolledAt: Date | null;
    lastUsedAt: Date | null;
    disabledAt: Date | null;
    disabledReason: string | null;
    digits: number;
    periodSeconds: number;
  } | null;
  backupCodesRemaining: number;
};

/**
 * Describe the CALLER'S OWN enrolment, for the UI.
 *
 * ── WHY THIS NEEDS ITS OWN PATH ─────────────────────────────────────────────
 * Every other function here is tenant-scoped through `withTenant`. A PENDING MFA
 * session deliberately carries NO tenant, so it cannot open a tenant-scoped
 * transaction at all — and `GET /api/fgmp/mfa/status` is precisely what a user
 * who has just been asked for a code needs to read.
 *
 * So this lookup is keyed on the caller's own `userId` and touches only their own
 * row. It grants nothing: a tenant-less session learns only its own enrolment
 * state, which is what it is already being asked about, and the response carries
 * a COUNT of unused backup codes rather than the codes themselves.
 *
 * The backup-code COUNT is a separate tenant-scoped query, so it is only counted
 * when the session genuinely has a tenant. A pending session sees 0 remaining
 * rather than opening a transaction it is not entitled to.
 */
export async function describeOwnEnrollment(
  userId: string,
  tenantId: string | undefined,
): Promise<OwnEnrollmentView> {
  // A PENDING session has no tenant, so it cannot open a tenant-scoped
  // transaction — and it genuinely has no enrolment to describe, because
  // enrolment is what CREATED the pending session. Returning "not enrolled" is
  // therefore correct, not a gap.
  if (!tenantId) return { enrollment: null, backupCodesRemaining: 0 };

  // MUST be tenant-scoped. `MfaEnrollment` is FORCE-RLS protected, so an
  // unscoped `db.mfaEnrollment.findUnique(...)` returns NULL for every user —
  // silently, with no error. That is exactly what this function did: the live
  // server reported `enabled: false, backupCodesRemaining: 0` for a user the
  // database had enabled, while /challenge correctly served the same session.
  //
  // A status endpoint that reports "MFA is off" to an operator whose MFA IS on
  // is worse than a 500: they would conclude they were unprotected.
  const { enrollment: row, remaining } = await withTenant(tenantId, async (tx) => {
    const enrollment = await tx.mfaEnrollment.findUnique({
      where: { userId },
      select: {
        id: true,
        enabled: true,
        enrolledAt: true,
        lastUsedAt: true,
        disabledAt: true,
        disabledReason: true,
        digits: true,
        periodSeconds: true,
      },
    });
    if (!enrollment) return { enrollment: null, remaining: 0 };
    const backupCodesRemaining = await tx.mfaBackupCode.count({
      where: { enrollmentId: enrollment.id, usedAt: null },
    });
    return { enrollment, remaining: backupCodesRemaining };
  });

  return { enrollment: row, backupCodesRemaining: remaining };
}

// ── Audit (tenant-scoped) ────────────────────────────────────────────────────

/**
 * Write an MFA audit row through the TENANT-SCOPED connection.
 *
 * ── WHY NOT THE AMBIENT `audit()` HELPER ────────────────────────────────────
 * `audit()` prefers the ambient `db` client, which is tenant-scoped only when
 * the caller has already opened a tenant context. `GET /challenge` runs OUTSIDE
 * any context — it resolves the tenant FROM the token — so the ambient write is
 * rejected by RLS and the helper silently falls back to the OWNER connection.
 *
 * That fallback writes the row correctly, but it is exactly the failure the
 * audit helper warns about: an owner-connection write proves nothing about the
 * caller's tenant scope, and it is indistinguishable from the 300+ route
 * queries that silently return zero rows for the same reason. It was observed
 * in the live log on every MFA_CHALLENGE_VERIFIED and MFA_CHALLENGE_ISSUED.
 *
 * So MFA audit rows are written INSIDE `withTenant`, where the tenant context is
 * established by the code rather than assumed from an ambient connection.
 */
export async function auditMfa(params: {
  tenantId: string;
  userId: string;
  action: string;
  entity: string;
  entityId: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const data = {
    tenantId: params.tenantId,
    userId: params.userId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    details: JSON.stringify(params.details ?? {}),
    ip: null,
  };
  try {
    await withTenant(params.tenantId, (tx) => tx.auditLog.create({ data }));
  } catch (err) {
    // Never throw: the verification has already happened, and failing the
    // request here would invite a retry that consumes a second backup code.
    console.error(
      `[mfa] audit write failed for ${params.action} (tenant ${params.tenantId})`,
      err,
    );
  }
}
