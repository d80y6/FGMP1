import { describe, expect, test } from "bun:test";
import { classifyWalkControl, isWalkProbeInconclusive, walkExitCode } from "./rbac-live-walk-logic";

describe("live RBAC walk probe verdicts", () => {
  test("rate limiting, timeouts, unavailable responses, and missing responses are inconclusive", () => {
    for (const status of [0, 408, 429, 500, 503]) {
      expect(isWalkProbeInconclusive(status)).toBe(true);
      expect(classifyWalkControl(true, status)).toBe("unknown");
      expect(classifyWalkControl(false, status)).toBe("unknown");
    }
  });

  test("a permitted capability is wrong when the API denies it", () => {
    expect(classifyWalkControl(true, 401)).toBe("wrong");
    expect(classifyWalkControl(true, 403)).toBe("wrong");
  });

  test("a denied capability is correct only when the API denies it", () => {
    expect(classifyWalkControl(false, 401)).toBe("ok");
    expect(classifyWalkControl(false, 403)).toBe("ok");
    expect(classifyWalkControl(false, 200)).toBe("wrong");
  });

  test("successful or resource-level responses are not mistaken for authorization denials", () => {
    expect(classifyWalkControl(true, 200)).toBe("ok");
    expect(classifyWalkControl(true, 400)).toBe("ok");
    expect(classifyWalkControl(true, 404)).toBe("ok");
  });

  test("mismatches and inconclusive probes both fail the walk, with distinct exit codes", () => {
    expect(walkExitCode(false, false)).toBe(0);
    expect(walkExitCode(true, false)).toBe(1);
    expect(walkExitCode(false, true)).toBe(2);
    expect(walkExitCode(true, true)).toBe(1);
  });
});
