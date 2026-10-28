import { createHash, timingSafeEqual } from "node:crypto";

/** The legacy checked-in value is public and must never be accepted as a secret. */
const LEGACY_INSECURE_REALTIME_TOKEN = "fgmp-realtime-dev-token";
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;

/**
 * Validates configuration for the global cross-tenant realtime snapshot token.
 * Keep the configured length bounded and refuse the historically committed
 * development token even if an operator accidentally copies it into secrets.
 */
export function isRealtimeServiceTokenConfigured(
  value: string | undefined,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_TOKEN_LENGTH &&
    value.length <= MAX_TOKEN_LENGTH &&
    value !== LEGACY_INSECURE_REALTIME_TOKEN
  );
}

/**
 * Compare service credentials without a content-dependent string equality.
 * Hashing both operands first gives timingSafeEqual fixed-length digests even
 * when the untrusted header has a different length. The caller also bounds
 * request header size through the HTTP server and this explicit length guard.
 */
export function matchesRealtimeServiceToken(
  supplied: string | null,
  expected: string,
): boolean {
  if (supplied === null || supplied.length > MAX_TOKEN_LENGTH) return false;
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
