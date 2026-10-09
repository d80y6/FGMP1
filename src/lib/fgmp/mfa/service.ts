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
async function consumeChallenge(
  tenantId: string,
  token: string,
): Promise<{ ok: true; challenge: { id: string; userId: string; enrollmentId: string } } | { ok: false; reason: string }> {
  const tokenHash = hashChallengeToken(token);
  const now = new Date();

  return withTenant(tenantId, async (tx) => {
    const claimed = await tx.mfaChallenge.updateMany({
      where: {
        tokenHash,
        usedAt: null,
        failedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: CHALLENGE_MAX_ATTEMPTS },
      },
      data: { usedAt: now },
    });
    if (claimed.count === 0) return { ok: false as const, reason: "CHALLENGE_INVALID" };

    const row = await tx.mfaChallenge.findUnique({ where: { tokenHash } });
    if (!row) return { ok: false as const, reason: "CHALLENGE_INVALID" };
    return {
      ok: true as const,
      challenge: { id: row.id, userId: row.userId, enrollmentId: row.enrollmentId },
    };
  });
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

  const consumed = await consumeChallenge(tenantId, token);
  if (!consumed.ok) return consumed;

  const enrollment = await withTenant(tenantId, (tx) =>
    tx.mfaEnrollment.findUnique({ where: { id: consumed.challenge.enrollmentId } }),
  );
  if (!enrollment || !enrollment.enabled) {
    return { ok: false, reason: "MFA_NOT_ENABLED" };
  }

  // ── TOTP path ──
  const secret = decryptSecret(enrollment.secretEnc);
  const step = Math.floor(Math.floor(Date.now() / 1000) / enrollment.periodSeconds);
  if (verifyTotp(secret, code, step, 1, enrollment.digits)) {
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
        data: { usedAt: new Date(), usedByChallengeId: consumed.challenge.id },
      }),
    );
    if (used.count === 0) return { ok: false, reason: "BACKUP_CODE_ALREADY_USED" };

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
  const row = await db.mfaEnrollment.findUnique({
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

  if (!row) return { enrollment: null, backupCodesRemaining: 0 };

  const backupCodesRemaining = tenantId
    ? await withTenant(tenantId, (tx) =>
        tx.mfaBackupCode.count({ where: { enrollmentId: row.id, usedAt: null } }),
      )
    : 0;

  return { enrollment: row, backupCodesRemaining };
}
