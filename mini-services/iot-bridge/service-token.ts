const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;
const LEGACY_INSECURE_REALTIME_TOKEN = "fgmp-realtime-dev-token";

/** Refuse to start without an explicit, non-public snapshot credential. */
export function requireRealtimeServiceToken(value: string | undefined): string {
  if (
    !value ||
    value.length < MIN_TOKEN_LENGTH ||
    value.length > MAX_TOKEN_LENGTH ||
    value === LEGACY_INSECURE_REALTIME_TOKEN
  ) {
    throw new Error(
      "REALTIME_SERVICE_TOKEN must be explicitly configured with a non-default secret (16–512 characters).",
    );
  }
  return value;
}
