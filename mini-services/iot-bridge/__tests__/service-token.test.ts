import { describe, expect, test } from "bun:test";
import { requireRealtimeServiceToken } from "../service-token";

describe("IoT bridge snapshot credential configuration", () => {
  test("accepts an explicitly configured valid secret without changing it", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(requireRealtimeServiceToken(token)).toBe(token);
  });

  test("fails closed for missing, short, oversized, and publicly known secrets", () => {
    for (const value of [
      undefined,
      "",
      "too-short",
      "x".repeat(513),
      "fgmp-realtime-dev-token",
    ]) {
      expect(() => requireRealtimeServiceToken(value)).toThrow(
        "REALTIME_SERVICE_TOKEN must be explicitly configured",
      );
    }
  });
});
