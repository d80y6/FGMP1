import { describe, expect, test } from "bun:test";
import {
  isRealtimeServiceTokenConfigured,
  matchesRealtimeServiceToken,
} from "../service-token";

describe("global realtime service credential", () => {
  test("requires a bounded configured secret and rejects the public legacy default", () => {
    expect(isRealtimeServiceTokenConfigured(undefined)).toBe(false);
    expect(isRealtimeServiceTokenConfigured("")).toBe(false);
    expect(isRealtimeServiceTokenConfigured("too-short")).toBe(false);
    expect(isRealtimeServiceTokenConfigured("fgmp-realtime-dev-token")).toBe(false);
    expect(isRealtimeServiceTokenConfigured("x".repeat(513))).toBe(false);
    expect(isRealtimeServiceTokenConfigured("x".repeat(32))).toBe(true);
  });

  test("matches only the exact credential, including different-length candidates", () => {
    const expected = "0123456789abcdef0123456789abcdef";
    expect(matchesRealtimeServiceToken(expected, expected)).toBe(true);
    expect(matchesRealtimeServiceToken(`${expected}x`, expected)).toBe(false);
    expect(matchesRealtimeServiceToken(expected.slice(0, -1), expected)).toBe(false);
    expect(matchesRealtimeServiceToken("wrong-token", expected)).toBe(false);
    expect(matchesRealtimeServiceToken(null, expected)).toBe(false);
    expect(matchesRealtimeServiceToken("x".repeat(513), expected)).toBe(false);
  });
});
