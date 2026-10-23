/**
 * MFA crypto tests.
 *
 * Run: bun test src/lib/fgmp/mfa/mfa-crypto.test.ts
 *
 * The TOTP vectors here are transcribed from RFC 6238 Appendix B (fetched from
 * the RFC, not from memory). That matters: the first version of totp.ts passed
 * every test written against it and was still wrong, because the tests asserted
 * the same misunderstanding. A conformance vector from an external document is
 * the only thing that catches that class of bug.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  DEFAULT_PERIOD_SECONDS,
  totpAt,
  totpForStep,
  otpauthUri,
  verifyTotp,
} from "./totp";
import { base32Decode, base32Encode } from "./base32";
import { InvalidSecretError } from "./totp";
import {
  decryptSecret,
  encryptSecret,
  formatBackupCode,
  MfaEncryptionError,
  mfaEncryptionConfigured,
  normaliseBackupCode,
} from "./crypto";

// RFC 6238 Appendix B specifies the shared secret "12345678901234567890" as an
// ASCII key. An authenticator app receives it BASE32-encoded, which is what
// /api/fgmp/mfa/enrol actually issues, so that is the form used here.
//
// The earlier version of this file passed the raw ASCII string — which is why a
// broken implementation (one that HMACed the base32 TEXT instead of decoding it)
// passed every vector below. See the PRODUCTION-argument block at the end.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("TOTP — RFC 6238 Appendix B conformance vectors", () => {
  // Values from the SHA1 column of Table 1, with T = floor(time / 30).
  const VECTORS: { time: number; step: number; expected: string }[] = [
    { time: 59, step: 1, expected: "94287082" },
    { time: 1111111109, step: 37037036, expected: "07081804" },
    { time: 1111111111, step: 37037037, expected: "14050471" },
    { time: 1234567890, step: 41152263, expected: "89005924" },
    { time: 2000000000, step: 66666666, expected: "69279037" },
    { time: 20000000000, step: 666666666, expected: "65353130" },
  ];

  test("every published 8-digit vector matches at its time step", () => {
    for (const v of VECTORS) {
      expect(totpForStep(RFC_SECRET, v.step, 8)).toBe(v.expected);
    }
  });

  test("every published vector matches through totpAt (time -> step division)", () => {
    // This is the regression that mattered: passing raw Unix time as the HMAC
    // counter produced well-formed codes that no authenticator would accept.
    for (const v of VECTORS) {
      expect(totpAt(RFC_SECRET, v.time, DEFAULT_PERIOD_SECONDS, 8)).toBe(v.expected);
    }
  });

  test("T is floor(unixTime / 30), not unixTime", () => {
    // Guards the exact bug explicitly rather than relying on the vectors above
    // to catch it incidentally.
    expect(totpAt(RFC_SECRET, 59, DEFAULT_PERIOD_SECONDS, 8)).toBe(
      totpForStep(RFC_SECRET, 1, 8),
    );
  });

  test("a time beyond 32 bits works (RFC 6238 R: post-2038)", () => {
    // The year-2603 vector. A 32-bit implementation would overflow here.
    expect(totpForStep(RFC_SECRET, 666666666, 8)).toBe("65353130");
  });

  test("six-digit default derives from the eight-digit value", () => {
    expect(totpForStep(RFC_SECRET, 1, 6)).toBe(totpForStep(RFC_SECRET, 1, 8).slice(-6));
  });
});

describe("TOTP verification window", () => {
  const now = 1111111109;
  const step = Math.floor(now / DEFAULT_PERIOD_SECONDS);
  const code = totpForStep(RFC_SECRET, step, 6);

  test("accepts the current step", () => {
    expect(verifyTotp(RFC_SECRET, code, step)).toBe(true);
  });

  test("accepts one step back (RFC 6238 §5.2 transmission delay)", () => {
    const prev = totpForStep(RFC_SECRET, step - 1, 6);
    expect(verifyTotp(RFC_SECRET, prev, step)).toBe(true);
  });

  test("rejects a code from two steps ago", () => {
    const old = totpForStep(RFC_SECRET, step - 2, 6);
    expect(verifyTotp(RFC_SECRET, old, step)).toBe(false);
  });

  test("tolerates spaces and dashes as pasted from an app", () => {
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, step)).toBe(true);
  });

  test("rejects malformed input without throwing", () => {
    for (const bad of ["", "abcdef", "12345", "1234567", "١٢٣٤٥٦"]) {
      expect(verifyTotp(RFC_SECRET, bad, step)).toBe(false);
    }
  });

  test("a DIFFERENT but valid base32 secret is rejected", () => {
    // Both keys must be valid base32, or this would assert a throw rather than
    // a rejected code.
    const wrongKey = base32Encode(Buffer.from("0000000000000000", "ascii"));
    expect(verifyTotp(wrongKey, code, step)).toBe(false);
  });
});

describe("otpauth URI", () => {
  test("carries the parameters an authenticator app needs", () => {
    const uri = otpauthUri({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "operator@fgmp.local",
      issuer: "FGMP",
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=FGMP");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("base32", () => {
  test("round-trips", () => {
    const original = Buffer.from("fgmp-mfa-secret-material");
    expect(base32Decode(base32Encode(original)).toString()).toBe(original.toString());
  });

  test("matches the RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foo"))).toBe("MZXW6");
    expect(base32Encode(Buffer.from("foob"))).toBe("MZXW6YQ");
    expect(base32Encode(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  test("rejects invalid characters rather than silently producing a wrong secret", () => {
    expect(() => base32Decode("MZXW6!TB")).toThrow(/invalid base32/);
  });
});

describe("secret encryption at rest", () => {
  const KEY = "a".repeat(64);
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.FGMP_MFA_ENCRYPTION_KEY;
    process.env.FGMP_MFA_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FGMP_MFA_ENCRYPTION_KEY;
    else process.env.FGMP_MFA_ENCRYPTION_KEY = saved;
  });

  test("round-trips a TOTP secret", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  test("the ciphertext does NOT contain the plaintext", () => {
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("JBSWY3DPEHPK3PXP");
  });

  test("a fresh IV each time, so identical secrets do not collide", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  test("tampering is detected (authenticated encryption)", () => {
    const stored = encryptSecret("secret");
    const parts = stored.split(".");
    // Flip a ciphertext byte. GCM must refuse rather than decrypt to garbage.
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow(MfaEncryptionError);
  });

  test("a different key cannot decrypt", () => {
    const stored = encryptSecret("secret");
    process.env.FGMP_MFA_ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptSecret(stored)).toThrow(/could not be decrypted/);
  });

  test("a malformed envelope fails loudly, never silently", () => {
    expect(() => decryptSecret("garbage")).toThrow(MfaEncryptionError);
    expect(() => decryptSecret("v2.a.b.c")).toThrow(/not a recognised format/);
  });

  // ── The "never lock anyone out with a half-configured MFA" rule ────────────
  test("MFA is NOT considered configured without the encryption key", () => {
    delete process.env.FGMP_MFA_ENCRYPTION_KEY;
    expect(mfaEncryptionConfigured()).toBe(false);
  });

  test("a short key is rejected", () => {
    process.env.FGMP_MFA_ENCRYPTION_KEY = "too-short";
    expect(mfaEncryptionConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/at least 32 characters/);
  });

  test("a long enough key is accepted", () => {
    expect(mfaEncryptionConfigured()).toBe(true);
  });
});

describe("backup codes", () => {
  test("format and normalise round-trip", () => {
    expect(normaliseBackupCode(formatBackupCode("abc12def34"))).toBe("ABC12DEF34");
  });

  test("a user pasting with spaces or dashes matches the stored form", () => {
    expect(normaliseBackupCode("abcde-fghij")).toBe("ABCDEFGHIJ");
    expect(normaliseBackupCode("abcde fghij")).toBe("ABCDEFGHIJ");
  });

  test("code display is unambiguous", () => {
    expect(formatBackupCode("abc12def34")).toBe("ABC12-DEF34");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION-ARGUMENT CONFORMANCE
//
// This block exists because the original vector test was green against a
// completely broken implementation.
//
// RFC 6238 Appendix B's secret, "12345678901234567890", is NOT base32 — it is
// an ASCII key used verbatim. So those vectors exercised a RAW-ASCII secret
// while production passes a BASE32 one. Same function, two argument
// conventions, and the tests only ever used the one that happened to work.
//
// Reverting the fix — passing the secret STRING to createHmac instead of the
// decoded key bytes — leaves the original 27 tests GREEN. Only the tests below
// fail, because they use the production argument type: a base32 secret, exactly
// as /api/fgmp/mfa/enrol returns it.
//
// The vectors are recomputed here through the same path a real enrolment takes,
// so a check that cannot fail has nowhere left to hide.
// ─────────────────────────────────────────────────────────────────────────────
describe("TOTP with a PRODUCTION base32 secret", () => {
  // RFC 6238's ASCII key, encoded the way an authenticator app would receive it.
  // This is the exact shape /api/fgmp/mfa/enrol hands to an operator.
  // The same key as the RFC vectors, named for what it represents here: the
  // exact string /api/fgmp/mfa/enrol hands to an operator.
  const PRODUCTION_SECRET = RFC_SECRET;
  const VECTORS: { time: number; expected: string }[] = [
    { time: 59, expected: "94287082" },
    { time: 1111111109, expected: "07081804" },
    { time: 1111111111, expected: "14050471" },
    { time: 1234567890, expected: "89005924" },
    { time: 2000000000, expected: "69279037" },
    { time: 20000000000, expected: "65353130" },
  ];

  test("the production secret is genuinely base32, not the RFC ASCII string", () => {
    // Guards this whole file against silently reverting to an ASCII-secret test,
    // which is precisely how the broken implementation passed.
    expect(PRODUCTION_SECRET).toMatch(/^[A-Z2-7]+$/);
    expect(PRODUCTION_SECRET).not.toBe("12345678901234567890");
  });

  test("every RFC vector still holds when the secret is base32", () => {
    for (const v of VECTORS) {
      expect(totpAt(PRODUCTION_SECRET, v.time, DEFAULT_PERIOD_SECONDS, 8)).toBe(v.expected);
    }
  });

  test("decoding is what makes the key correct", () => {
    // A raw ASCII secret is NOT a valid TOTP secret here, and must be refused
    // rather than silently HMACed. This is the convention boundary: base32 in,
    // raw key bytes to the HMAC.
    expect(() => totpAt("12345678901234567890", 59, DEFAULT_PERIOD_SECONDS, 8)).toThrow(
      InvalidSecretError,
    );
  });

  test("a base32 secret produces a DIFFERENT code than HMACing its text", () => {
    // The regression itself, isolated: these two must not be equal.
    const step = 1;
    const viaBase32 = totpForStep(PRODUCTION_SECRET, step, 8);
    // Reproduce the old defect inline and assert it differed.
    const wrong = (() => {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(step));
      const h = createHmac("sha1", PRODUCTION_SECRET).update(counter).digest();
      const off = h[h.length - 1] & 0x0f;
      const bin =
        ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) |
        ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
      return String(bin % 10 ** 8).padStart(8, "0");
    })();
    expect(viaBase32).not.toBe(wrong);
  });

  test("a malformed secret throws at ENROLMENT, not silently at login", () => {
    // A wrong-length key must fail where an operator can act on it.
    for (const bad of ["", "   ", "not-base32!", "A"]) {
      expect(() => totpAt(bad, 59, DEFAULT_PERIOD_SECONDS, 6)).toThrow(InvalidSecretError);
    }
  });

  test("a too-short key is rejected with an actionable message", () => {
    expect(() => totpAt("MZXW6YTB", 59, DEFAULT_PERIOD_SECONDS, 6)).toThrow(/at least 10/);
  });

  test("verifyTotp rejects a malformed secret loudly rather than returning false", () => {
    // verifyTotp must NOT swallow this into a bare `false`, which would present
    // at the login prompt as "wrong code" forever with no diagnosis.
    expect(() => verifyTotp("A", "123456", 1)).toThrow(InvalidSecretError);
  });
});
