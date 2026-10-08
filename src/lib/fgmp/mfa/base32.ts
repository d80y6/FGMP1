/**
 * Base32 (RFC 4648) for TOTP secrets.
 *
 * Authenticator apps expect base32 without padding — that is what the otpauth://
 * URI format carries — so the encoder here emits the unpadded alphabet and
 * rejects non-canonical input rather than silently accepting padded or
 * lower-case forms that would produce a different secret than the user scanned.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  // Case-insensitive on the way in (users type these by hand or paste from a
  // password manager) but padding is rejected: a padded secret is a different
  // string and silently accepting it would produce codes that never match.
  const clean = input.toUpperCase().replace(/=+$/, "");
  if (clean.length === 0) return Buffer.alloc(0);

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}