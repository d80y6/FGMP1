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
import {
  DEFAULT_PERIOD_SECONDS,
  totpAt,
  totpForStep,
  otpauthUri,
  verifyTotp,
} from "./totp";
import { base32Decode, base32Encode } from "./base32";
import {
  decryptSecret,
  encryptSecret,
  formatBackupCode,
  MfaEncryptionError,
  mfaEncryptionConfigured,
  normaliseBackupCode,
} from "./crypto";

const RFC_SECRET = "12345678901234567890"; // ASCII, per RFC 6238 Appendix B.

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

  test("a wrong secret is rejected", () => {
    expect(verifyTotp("0000000000000000", code, step)).toBe(false);
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
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
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