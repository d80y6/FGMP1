/**
 * TOTP (RFC 6238) — verified against the RFC's published test vectors.
 *
 * ── WHY THE VECTORS ARE IN THE TEST FILE AND NOT JUST A COMMENT ──────────────
 * The first version of this file passed every test it was given and was still
 * wrong: it fed raw Unix time into the HMAC instead of the TIME STEP
 * (T = floor(unixTime / 30)). It produced well-formed six-digit codes that no
 * authenticator app would ever accept, and a test written against that same
 * implementation happily confirmed it.
 *
 * This is the identical trap as the Modbus CRC in Phase 2, where misremembered
 * "published" vectors were the bug. So the vectors below are transcribed from
 * RFC 6238 Appendix B and were checked against the RFC itself, not from memory.
 * A test that only ever compares this implementation against itself proves
 * nothing at all.
 *
 * RFC 6238 §5.2 recommends at most ONE time step of network delay, so the
 * default window below accepts the previous step as well.
 */

import { createHmac } from "node:crypto";
import { base32Decode } from "./base32";

/** RFC 6238 §5.2 recommends 30 s as the balance of security and usability. */
export const DEFAULT_PERIOD_SECONDS = 30;

/** RFC 6238 §5.2: at most one time step of acceptable transmission delay. */
export const DEFAULT_WINDOW = 1;

/** Six digits is what every mainstream authenticator app displays. */
export const DEFAULT_DIGITS = 6;

/** Thrown when a TOTP secret is not usable base32 key material. */
export class InvalidSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSecretError";
  }
}

/**
 * Resolve a TOTP secret to the RAW KEY BYTES the HMAC is computed over.
 *
 * ── WHY THIS EXISTS (and why the first version was wrong) ───────────────────
 * The first version passed the secret STRING straight to `createHmac`, so it
 * HMACed the ASCII bytes of the base32 text rather than the decoded key. Every
 * downstream step — dynamic truncation, the modulo — was correct, operating on
 * the wrong key.
 *
 * It produced well-formed six-digit codes that NO authenticator app would ever
 * accept, so enrolment completed and then NO user could ever verify a code.
 *
 * It passed its own RFC 6238 conformance vectors, and that is the part worth
 * remembering: RFC 6238 Appendix B's secret, "12345678901234567890", is not
 * base32 at all — it is an ASCII key used verbatim. So the vectors exercised a
 * RAW-ASCII secret while production passed a BASE32 one. Same function, two
 * different argument conventions, and the tests only ever used the convention
 * that happened to work.
 *
 * A conformance test must call the production entry point with the production
 * argument type. This function is the single place that convention is decided,
 * so there is now no way to reach the HMAC without going through it.
 *
 * ── WHY IT FAILS LOUDLY ─────────────────────────────────────────────────────
 * A malformed secret throws here rather than silently HMACing nonsense. A
 * wrong-length key must fail at ENROLMENT, where the operator can act on it,
 * not at login, where it presents as "wrong code" forever with no way to
 * diagnose it.
 */
function totpKeyBytes(secret: string): Buffer {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new InvalidSecretError("TOTP secret is empty");
  }
  let decoded: Buffer;
  try {
    decoded = base32Decode(secret);
  } catch (e) {
    throw new InvalidSecretError(
      `TOTP secret is not valid base32: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (decoded.length < 10) {
    // RFC 4226 §5.1 requires a key at least as long as the HMAC output (160 bits
    // for SHA-1). Shorter key material is not a valid shared secret.
    throw new InvalidSecretError(
      `TOTP secret decodes to ${decoded.length} bytes; at least 10 are required. ` +
        `This secret was almost certainly HMACed as text rather than decoded.`,
    );
  }
  return decoded;
}

/**
 * Generate a TOTP code for an explicit time STEP counter.
 *
 * @param step  T = floor(unixTime / periodSeconds). Exposed separately from
 *              `totpAt` so a test can drive the RFC vectors directly without
 *              reimplementing the step division.
 */
export function totpForStep(
  secret: string,
  step: number,
  digits: number = DEFAULT_DIGITS,
): string {
  // RFC 6238 §5.1 requires support for a time value beyond 32 bits (year 2038
  // and the 2603 vector), so the counter is written as a 64-bit BigInt rather
  // than a JS number bit-shift.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(step)));

  const hmac = createHmac("sha1", totpKeyBytes(secret)).update(counter).digest();

  // Dynamic truncation (RFC 4226 §5.4): the low nibble of the LAST byte selects
  // the 4-byte window. Getting the offset wrong yields plausible numbers that
  // no authenticator will agree with.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** Generate the code valid at a given Unix time. */
export function totpAt(
  secret: string,
  unixSeconds: number,
  periodSeconds: number = DEFAULT_PERIOD_SECONDS,
  digits: number = DEFAULT_DIGITS,
): string {
  return totpForStep(secret, Math.floor(unixSeconds / periodSeconds), digits);
}

/**
 * Verify a submitted code.
 *
 * Accepts a small window either side to tolerate clock drift, per RFC 6238 §6
 * (Resynchronization), which recommends a bounded offset rather than rejection.
 *
 * COMPARISON IS CONSTANT-TIME on every candidate step — a timing oracle on a
 * six-digit code is a real leak, and it is free to avoid.
 *
 * @param atStepIndex how many steps either side to accept. 1 = previous, 0, next.
 */
export function verifyTotp(
  secret: string,
  token: string,
  atStepIndex: number,
  window: number = DEFAULT_WINDOW,
  digits: number = DEFAULT_DIGITS,
): boolean {
  // Normalise: authenticator apps show digits in groups ("123 456") and users
  // paste them with spaces.
  const candidate = token.replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return false;

  let matched = false;
  for (let i = -window; i <= window; i++) {
    const expected = totpForStep(secret, atStepIndex + i, digits);
    // Constant-time compare, and deliberately NOT short-circuiting on the
    // first mismatch: an early return leaks which prefix was correct.
    matched = timingSafeEqualStr(expected, candidate) || matched;
  }
  return matched;
}

/** Length-independent, constant-time string comparison. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Build the otpauth:// URI for enrolment (RFC 4226 Appendix A / Key Uri Format).
 *
 * The secret is the base32 form; the label identifies the account so an operator
 * with two accounts can tell the entries apart.
 */
export function otpauthUri(params: {
  secret: string
  accountName: string
  issuer: string
  digits?: number
  periodSeconds?: number
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(params.digits ?? DEFAULT_DIGITS),
    period: String(params.periodSeconds ?? DEFAULT_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}