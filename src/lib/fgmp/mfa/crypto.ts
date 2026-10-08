/**
 * Envelope encryption for MFA secrets.
 *
 * ── WHY ENCRYPT AT ALL ──────────────────────────────────────────────────────
 * A TOTP secret is a BEARER credential for the second factor. Anyone who reads
 * it can generate valid codes forever, with no second factor at all. So a
 * plaintext `mfaSecret` column is not a weakness in MFA — it is MFA with the
 * second factor removed, while still looking like MFA is on.
 *
 * This matters concretely here: the platform's operator sessions can already
 * read cross-tenant data, and the database is the most likely thing to be
 * exfiltrated. An encrypted secret means a database dump does not hand over
 * every operator's second factor.
 *
 * ── THE SCHEME ───────────────────────────────────────────────────────────────
 * AES-256-GCM (authenticated encryption — tampering is detected, not silently
 * decrypted into garbage), with the data key derived from a master secret via
 * scrypt.
 *
 * Stored form is `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version
 * prefix exists so the scheme can be rotated without guessing: an unrecognised
 * version fails LOUDLY rather than decrypting to nonsense.
 *
 * ── WHY THE MASTER KEY IS REQUIRED ───────────────────────────────────────────
 * Encryption without a key held outside the database provides no protection
 * against exactly the threat above. So `FGMP_MFA_ENCRYPTION_KEY` is mandatory
 * when MFA is enabled, and MFA CANNOT BE ENABLED WITHOUT IT. That is the
 * "never let a half-configured MFA lock anyone out" rule expressed in code
 * rather than in a runbook: an operator cannot accidentally enable a control
 * whose secret handling is broken.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size.
const KEY_BYTES = 32; // AES-256.
const SALT = "fgmp-mfa-v1";
/**
 * scrypt cost.
 *
 * N=2^14 (16384) is deliberate, and was chosen by measurement rather than by
 * picking a round number. N=2^15 needs 128 * N * r = 32 MB of memory, which
 * exceeds OpenSSL's default maxmem and throws
 * `MEMORY_LIMIT_EXCEEDED` — the first implementation used 2^15 and failed on
 * EVERY call, which a happy-path-only test would not necessarily have caught.
 *
 * N=2^14 needs 16 MB: comfortably under the limit, still ~50-100ms per
 * derivation, and the key is a high-entropy 256-bit master secret rather than a
 * human password, so brute-forcing it is not the threat this cost defends
 * against. That is where the security actually comes from.
 */
const SCRYPT_COST = 16384;

/** Thrown when MFA is enabled but the encryption key is absent or wrong. */
export class MfaEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaEncryptionError";
  }
}

function masterKey(): string {
  const key = process.env.FGMP_MFA_ENCRYPTION_KEY?.trim();
  if (!key) {
    throw new MfaEncryptionError(
      "FGMP_MFA_ENCRYPTION_KEY is not set. MFA cannot be enabled without it: an " +
        "encrypted secret is only protective while the key lives outside the database.",
    );
  }
  if (key.length < 32) {
    throw new MfaEncryptionError(
      `FGMP_MFA_ENCRYPTION_KEY must be at least 32 characters (got ${key.length}). ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  return key;
}

/** Derive the data key. Deterministic per master key; salt is a fixed constant
 *  because the master key itself is the secret, not the salt. */
function deriveKey(): Buffer {
  return scryptSync(masterKey(), SALT, KEY_BYTES, { N: SCRYPT_COST, r: 8, p: 1 });
}

/**
 * Encrypt a TOTP secret for storage.
 *
 * A fresh IV per call — reusing a nonce with GCM is catastrophic and would leak
 * the XOR of plaintexts, so it is generated inside rather than passed in.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/**
 * Decrypt a stored secret.
 *
 * Throws rather than returning a wrong-but-plausible value: a decryption failure
 * means the secret is unrecoverable, and pretending otherwise would surface as
 * "wrong code" at the login prompt forever with no way to diagnose it.
 */
export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new MfaEncryptionError(
      "stored MFA secret is not a recognised format (expected v1.<iv>.<tag>.<ciphertext>)",
    );
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv(ALGO, deriveKey(), Buffer.from(ivB64, "base64url"));
    // A wrong key produces a tag mismatch, which is exactly the check we want:
    // GCM authenticates, so tampering or a wrong key fails loudly.
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new MfaEncryptionError(
      "MFA secret could not be decrypted. Either FGMP_MFA_ENCRYPTION_KEY changed " +
        "since enrolment, or the stored value was tampered with. Recovery requires " +
        "re-enrolment via a second authorised operator — do NOT silently reset, as " +
        "that would let anyone who can write the row bypass the second factor.",
    );
  }
}

/** Is MFA usable in this deployment? Enablement is gated on this. */
export function mfaEncryptionConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

/** Why MFA cannot be enabled here. Null when it can. */
export function mfaEncryptionProblem(): string | null {
  try {
    masterKey();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// ── Backup codes ─────────────────────────────────────────────────────────────

/** Format a backup code for humans to transcribe: XXXX-XXXX. */
export function formatBackupCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return c.length <= 5 ? c : `${c.slice(0, 5)}-${c.slice(5)}`;
}

/** Normalise user input back to comparable form. */
export function normaliseBackupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type BackupCodeHash = {
  /** bcrypt hash — backup codes are high-entropy so bcrypt's cost is acceptable. */
  hash: string;
  /** Index into the user's code set, so consumption is precise. */
  index: number;
};

/**
 * Backup codes are hashed with bcrypt, the SAME function used for passwords.
 *
 * They are generated from a CSPRNG rather than a word list, so guessing one
 * requires brute force rather than a dictionary attack — but bcrypt is still
 * the right tool because it means one hash function governs every credential in
 * the system, and a compromise of the hash store does not reveal a code.
 */
export async function hashBackupCode(
  code: string,
  bcrypt: { hash(s: string, rounds: number): Promise<string> },
): Promise<string> {
  return bcrypt.hash(normaliseBackupCode(code), 10);
}

/** Constant-time-ish comparison of a candidate against a stored bcrypt hash. */
export async function verifyBackupCode(
  candidate: string,
  bcrypt: { compare(s: string, h: string): Promise<boolean> },
  storedHash: string,
): Promise<boolean> {
  return bcrypt.compare(normaliseBackupCode(candidate), storedHash);
}

/** Timing-safe equality for two short strings (used for correlating challenges). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}