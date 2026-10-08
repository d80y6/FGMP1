/**
 * The pending MFA challenge.
 *
 * ── WHY THIS EXISTS RATHER THAN A SECOND FACTOR INSIDE authorize() ───────────
 * NextAuth's Credentials `authorize(credentials)` returns a user or `null`. There
 * is no multi-step return, so the second factor cannot live inside the
 * credentials callback without forking the authentication flow.
 *
 * The standard way around that constraint is to have `authorize()` return a
 * user WITHOUT a session when MFA is pending, and have the client complete a
 * second, separate request that exchanges a challenge token for a session. So:
 *
 *   1. POST /api/auth/mfa/challenge  — password verified, returns a challenge
 *      token. NO session is issued.
 *   2. POST /api/auth/mfa/verify     — challenge token + code, returns a session.
 *
 * The challenge token is the whole security boundary between the two halves, so
 * it is treated as a credential:
 *
 *   - single use, consumed atomically (a replay cannot complete twice)
 *   - expires in MINUTES, not hours — it is a live door, not a session
 *   - unguessable (128 bits from a CSPRNG)
 *   - bound to the userId AND tenantId it was issued for, so it cannot be
 *     replayed against a different account
 *   - invalidated by a FAILED attempt, so guessing is bounded by one try
 *
 * ── WHY NOT A JWT ────────────────────────────────────────────────────────────
 * A self-contained challenge token would not be revocable and not single-use.
 * Both properties matter: revoking on a password change is a real requirement,
 * and single-use is what stops an intercepted token from being replayed after
 * the legitimate user has already logged in.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/** Bytes of entropy. 128 bits — the same order as a session id. */
const CHALLENGE_BYTES = 16;

/**
 * How long a challenge stays valid.
 *
 * Deliberately short. A challenge is not a session: it authorises exactly one
 * transition, and the operator is standing at a login screen with the code in
 * hand. Five minutes is generous and anything longer widens the window in which
 * a token captured from a log, a proxy trace, or shoulder-surfing is useful.
 */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Only the HASH of a challenge token is ever stored.
 *
 * Same reasoning as a password: if the store is read, the attacker gets hashes,
 * not live tokens. The plaintext exists only in the response to the browser that
 * legitimately requested it.
 */
export function hashChallengeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate a challenge token. Only its hash should be persisted. */
export function newChallengeToken(): { token: string; tokenHash: string } {
  const token = randomBytes(CHALLENGE_BYTES).toString("base64url");
  return { token, tokenHash: hashChallengeToken(token) };
}

/** Constant-time comparison of a presented token against a stored hash. */
export function challengeMatches(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashChallengeToken(token));
  const stored = Buffer.from(storedHash);
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/** Is a challenge still usable at `now`? */
export function isChallengeFresh(expiresAt: Date, now: number = Date.now()): boolean {
  return expiresAt.getTime() > now;
}

/**
 * What the login response tells the client.
 *
 * Deliberately minimal: it says MFA is required and nothing else. It must NOT
 * reveal whether an account exists, which is why the password check happens
 * BEFORE this is returned and the same response shape is used for "no such user"
 * and "wrong password".
 */
export type MfaChallengeResponse = {
  /** Client stores this and posts it back with the code. */
  challengeToken: string;
  /** Seconds until expiry, for a countdown in the UI. */
  expiresInSeconds: number;
  /** The account's display name so the operator knows which account to enter the
   *  code for. Sourced from the authenticated user, not the request. */
  accountLabel: string;
  /** True when the operator may use a backup code instead of the authenticator. */
  backupCodesAvailable: boolean;
};