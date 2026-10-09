/**
 * Dispatch contract tests.
 *
 * The load-bearing one is "EXECUTED requires an acknowledgement". Everything
 * else exists to keep that property from being satisfied by accident.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { selfTest, OUTCOME_SEMANTICS, assertNoExecutedWithoutAck } from "./dispatch-safety.contract";
import { requireExecuted } from "./types";
import { SimulatedGeneratorDispatch, simulatedControlEnabled, SIMULATED_FLAG } from "./simulated";
import type { DispatchOutcome } from "./types";

/**
 * Set the simulation flag on the REAL process.env and restore it afterwards.
 *
 * The previous version of this file cast object literals to `NodeJS.ProcessEnv`,
 * which TypeScript correctly flagged. Widening the cast to
 * `as unknown as ProcessEnv` would silence it while proving nothing — a
 * fabricated env object is not the one production reads.
 *
 * Mutating the real thing is both honest and more faithful: `simulatedControl`
 * reads `process.env`, so this exercises the same path a deployment does.
 */
const ORIGINAL = process.env[SIMULATED_FLAG];
function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[SIMULATED_FLAG];
  else process.env[SIMULATED_FLAG] = value;
}
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[SIMULATED_FLAG];
  else process.env[SIMULATED_FLAG] = ORIGINAL;
});

const req = { command: "START" as const, generatorId: "gen-1" };

describe("the safety invariant harness", () => {
  test("proves it can FAIL — a harness that cannot fail proves nothing", () => {
    // Positive AND negative control in one: selfTest() throws if the harness
    // fails to reject a lying dispatch. This is the same discipline as
    // mutation-testing the RLS suite.
    expect(() => selfTest()).not.toThrow();
  });

  test("rejects a dispatch that returned EXECUTED with no acknowledgement", () => {
    expect(() =>
      assertNoExecutedWithoutAck([
        { dispatch: null as never, ackReceived: false, label: "liar" },
      ]),
    ).toThrow(/SAFETY INVARIANT VIOLATED/);
  });
});

describe("SimulatedGeneratorDispatch", () => {
  test("DEFAULT OFF — returns NO_TRANSPORT, never EXECUTED", async () => {
    setFlag(undefined);
    const d = new SimulatedGeneratorDispatch();
    const o = await d.dispatch(req);
    expect(o.kind).toBe("NO_TRANSPORT");
    expect(o.acknowledgement).toBeUndefined();
    expect(o.reason).toContain(SIMULATED_FLAG);
  });

  test("ENABLED — still does NOT claim EXECUTED", async () => {
    // The counter-intuitive one, and the one that matters. Simulation updates
    // in-memory state so existing behaviour is preserved, but there is no
    // device behind it, so the honest outcome is NO_TRANSPORT.
    let applied = 0;
    setFlag("1");
    const d = new SimulatedGeneratorDispatch({ applyInMemory: () => { applied += 1; } });
    const o = await d.dispatch(req);
    expect(applied).toBe(1);          // in-memory behaviour preserved
    expect(o.kind).toBe("NO_TRANSPORT"); // but no false success
    expect(o.acknowledgement).toBeUndefined();
    expect(o.reason).toContain("no generator was contacted");
  });

  test("flag parsing is strict — a typo does not enable control", () => {
    for (const v of ["true", "yes", "on", "", "0", " 1", "1 "]) {
      setFlag(v);
      expect(simulatedControlEnabled()).toBe(false);
    }
    setFlag("1");
    expect(simulatedControlEnabled()).toBe(true);
    setFlag(undefined);
    expect(simulatedControlEnabled()).toBe(false);
  });

  test("NEVER produces EXECUTED under any configuration", async () => {
    // The property, tested against the real implementation rather than a model.
    for (const value of [undefined, "1", "0"]) {
      setFlag(value);
      const d = new SimulatedGeneratorDispatch();
      for (const command of ["START", "STOP", "EMERGENCY_STOP", "RESET"] as const) {
        const o = await d.dispatch({ ...req, command });
        expect(o.kind).not.toBe("EXECUTED");
        expect(o.acknowledgement).toBeUndefined();
      }
    }
  });
});

describe("outcome semantics", () => {
  test("TIMEOUT_AMBIGUOUS is never retry-safe and always needs a human", () => {
    // Deliberately NOT reused from the notification layer. A notification
    // timeout means "probably not delivered" and resending is safe. A control
    // timeout means "we do not know whether an engine was told to start", and
    // resending is a different command with different consequences.
    expect(OUTCOME_SEMANTICS.TIMEOUT_AMBIGUOUS.retrySafeByDefault).toBe(false);
    expect(OUTCOME_SEMANTICS.TIMEOUT_AMBIGUOUS.humanMustDecide).toBe(true);
  });

  test("NO_TRANSPORT is retry-safe — nothing was attempted", () => {
    expect(OUTCOME_SEMANTICS.NO_TRANSPORT.retrySafeByDefault).toBe(true);
  });
});

describe("requireExecuted", () => {
  test("throws on EXECUTED with no acknowledgement — the bug this prevents", () => {
    const lying: DispatchOutcome = { kind: "EXECUTED" };
    expect(() => requireExecuted(lying)).toThrow(/EXECUTED without an acknowledgement/);
  });

  test("returns the acknowledgement when genuinely present", () => {
    const honest: DispatchOutcome = {
      kind: "EXECUTED",
      acknowledgement: { transport: "modbus-tcp", at: 1, detail: "coil 1 = 0xFF" },
    };
    expect(requireExecuted(honest).transport).toBe("modbus-tcp");
  });
});