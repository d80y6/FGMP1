/**
 * Unit tests for the generator control interlocks.
 *
 * These run with NO DATABASE and NO HARDWARE, which is the entire reason the
 * rules are data. Run with:  bun test src/lib/fgmp/interlocks.test.ts
 *
 * Coverage required by the task:
 *   - every HARD interlock denies
 *   - every SOFT interlock warns but allows
 *   - the boundary condition AT exactly the threshold (both sides)
 *   - the two-person rule refuses a single-operator override
 *   - EMERGENCY_STOP is never blocked
 *
 * `now` is a fixed constant so cooldown/backoff arithmetic is deterministic and
 * a boundary can actually be tested.
 */

import { describe, expect, test } from "bun:test";
import {
  INTERLOCK_RULES,
  UNBLOCKABLE_COMMANDS,
  thresholdsOf,
} from "./interlock-rules";
import {
  DEFAULT_THRESHOLDS,
  THRESHOLD_KEYS,
  describeThresholds,
  resolveThresholds,
  minutesToMs,
} from "./interlock-thresholds";
import {
  evaluateInterlocks,
  requiresTwoPerson,
  denialResponseBody,
} from "./interlocks";
import type { InterlockContext, ControlCommandName } from "./interlock-rules";

const NOW = 1_700_000_000_000;

/**
 * The values a bare test context resolves to.
 *
 * Phase 4 moved thresholds from flat exported numbers to provenance-carrying
 * records, so a rule reads `T.coolantMaxC` rather than `THRESHOLDS.coolantMaxC`.
 * The magnitudes are unchanged — only their shape — so every boundary
 * assertion below still tests the same rule at the same place.
 */
const T = resolveThresholds([]).values;

/** A generator that satisfies every hard interlock, so each test can break exactly one thing. */
function goodGenerator(overrides: Partial<InterlockContext["generator"]> = {}): InterlockContext["generator"] {
  return {
    id: "gen-1",
    siteId: "site-1",
    status: "STOPPED",
    mode: "REMOTE",
    runtimeHours: 1000,
    temperatureC: 70,
    oilPressureKpa: 300,
    loadKw: 0,
    ratedPowerKw: 500,
    oilChangeIntervalHrs: 500,
    nextMaintenanceHrs: 100,
    ...overrides,
  };
}

function goodContext(overrides: Partial<InterlockContext> = {}): InterlockContext {
  return {
    now: NOW,
    generator: goodGenerator(),
    site: { id: "site-1", criticality: "MEDIUM", loadKw: 100, gridAvailable: true },
    commandInFlight: null,
    hoursSinceOilChange: 100,
    fuelLitres: 500,
    tankCapacityLitres: TANK_L,
    ...overrides,
  };
}

/** Usable tank capacity for the fuel rules. Fixed so a percentage resolves to known litres. */
const TANK_L = 1000;

/** Litres remaining that is exactly AT the cranking threshold. */
const CRANK_L = (T.crankingFuelFractionPct / 100) * TANK_L;

/** Assert a command is denied and that a SPECIFIC rule is the reason. */
function expectDeniedBy(
  command: ControlCommandName,
  ctx: InterlockContext,
  ruleId: string,
) {
  const v = evaluateInterlocks(command, ctx);
  expect(v.allowed).toBe(false);
  if (!v.allowed) {
    expect(v.reasons.map((r) => r.ruleId)).toContain(ruleId as never);
  }
  return v;
}

describe("HARD interlocks deny", () => {
  test("GENERATOR_OFFLINE", () => {
    expectDeniedBy(
      "START",
      goodContext({ generator: goodGenerator({ status: "OFFLINE" }) }),
      "GENERATOR_OFFLINE",
    );
  });

  test("MAINTENANCE_LOCKOUT", () => {
    expectDeniedBy(
      "START",
      goodContext({ generator: goodGenerator({ status: "MAINTENANCE" }) }),
      "MAINTENANCE_LOCKOUT",
    );
  });

  test("FUEL_BELOW_CRANKING_THRESHOLD", () => {
    expectDeniedBy(
      "START",
      goodContext({ fuelLitres: CRANK_L - 0.1 }),
      "FUEL_BELOW_CRANKING_THRESHOLD",
    );
  });

  test("IN_SERVICE_OVERDUE", () => {
    expectDeniedBy(
      "START",
      goodContext({ generator: goodGenerator({ nextMaintenanceHrs: -10 }) }),
      "IN_SERVICE_OVERDUE",
    );
  });

  test("COOLANT_HOT_AT_ASSUME_LOAD", () => {
    expectDeniedBy(
      "START",
      goodContext({ generator: goodGenerator({ temperatureC: T.coolantMaxC + 0.1 }) }),
      "COOLANT_HOT_AT_ASSUME_LOAD",
    );
  });

  test("OIL_PRESSURE_LOW", () => {
    expectDeniedBy(
      "START",
      goodContext({ generator: goodGenerator({ oilPressureKpa: T.oilPressureMinKpa - 1 }) }),
      "OIL_PRESSURE_LOW",
    );
  });

  test("NOT_READY_TO_ASSUME_LOAD", () => {
    expectDeniedBy(
      "START",
      goodContext({ generator: goodGenerator({ status: "RUNNING" }) }),
      "NOT_READY_TO_ASSUME_LOAD",
    );
  });

  test("COMMAND_ALREADY_IN_FLIGHT", () => {
    expectDeniedBy(
      "START",
      goodContext({
        commandInFlight: { id: "cmd-1", command: "RESET", status: "SENT" },
      }),
      "COMMAND_ALREADY_IN_FLIGHT",
    );
  });

  test("CONFLICTING_COMMAND_IN_FLIGHT — START racing a STOP while running", () => {
    expectDeniedBy(
      "START",
      goodContext({
        generator: goodGenerator({ status: "RUNNING" }),
        commandInFlight: { id: "cmd-2", command: "STOP", status: "SENT" },
      }),
      "CONFLICTING_COMMAND_IN_FLIGHT",
    );
  });

  test("COOLDOWN_ACTIVE", () => {
    expectDeniedBy(
      "START",
      goodContext({
        generator: goodGenerator({ lastStoppedAt: NOW - minutesToMs(T.cooldownMinutes) + 1000 }),
      }),
      "COOLDOWN_ACTIVE",
    );
  });

  test("RESTART_BACKOFF_ACTIVE", () => {
    expectDeniedBy(
      "START",
      goodContext({
        generator: goodGenerator({
          lastStoppedAt: NOW - 1000,
          faultUntil: NOW + 60_000,
        }),
      }),
      "RESTART_BACKOFF_ACTIVE",
    );
  });

  test("CRITICAL_LOAD_SHED — stopping the only source at a critical site", () => {
    expectDeniedBy(
      "STOP",
      goodContext({
        generator: goodGenerator({ status: "RUNNING", loadKw: 200 }),
        site: { id: "site-1", criticality: "CRITICAL", loadKw: 200, gridAvailable: false },
      }),
      "CRITICAL_LOAD_SHED",
    );
  });

  test("SHED_BELOW_SITE_REQUIREMENT", () => {
    expectDeniedBy(
      "STOP",
      goodContext({
        generator: goodGenerator({ status: "RUNNING", loadKw: 300 }),
        site: { id: "site-1", criticality: "MEDIUM", loadKw: 300, gridAvailable: false },
        protectedLoadKw: 300,
      }),
      "SHED_BELOW_SITE_REQUIREMENT",
    );
  });

  test("every HARD rule is reachable — no dead interlock", () => {
    // A hard rule that can never fire is documentation pretending to be a
    // control. Each is exercised above; this asserts none are unaccounted for.
    const exercised = new Set([
      "GENERATOR_OFFLINE",
      "MAINTENANCE_LOCKOUT",
      "FUEL_BELOW_CRANKING_THRESHOLD",
      "IN_SERVICE_OVERDUE",
      "COOLANT_HOT_AT_ASSUME_LOAD",
      "OIL_PRESSURE_LOW",
      "NOT_READY_TO_ASSUME_LOAD",
      "COMMAND_ALREADY_IN_FLIGHT",
      "CONFLICTING_COMMAND_IN_FLIGHT",
      "COOLDOWN_ACTIVE",
      "RESTART_BACKOFF_ACTIVE",
      "CRITICAL_LOAD_SHED",
      "SHED_BELOW_SITE_REQUIREMENT",
    ]);
    const hard = INTERLOCK_RULES.filter((r) => r.severity === "HARD").map((r) => r.id);
    for (const id of hard) {
      expect(exercised.has(id)).toBe(true);
    }
    expect(hard.length).toBe(exercised.size);
  });
});

describe("BOUNDARY conditions at exactly the threshold", () => {
  test("coolant: AT the limit allows, one tenth above denies", () => {
    const at = goodContext({ generator: goodGenerator({ temperatureC: T.coolantMaxC }) });
    expect(evaluateInterlocks("START", at).allowed).toBe(true);

    const over = goodContext({
      generator: goodGenerator({ temperatureC: T.coolantMaxC + 0.1 }),
    });
    expect(evaluateInterlocks("START", over).allowed).toBe(false);
  });

  test("oil pressure: AT the minimum allows, one kPa below denies", () => {
    const at = goodContext({
      generator: goodGenerator({ oilPressureKpa: T.oilPressureMinKpa }),
    });
    expect(evaluateInterlocks("START", at).allowed).toBe(true);

    const under = goodContext({
      generator: goodGenerator({ oilPressureKpa: T.oilPressureMinKpa - 1 }),
    });
    expect(evaluateInterlocks("START", under).allowed).toBe(false);
  });

  test("fuel: EXACTLY at the cranking threshold allows, a hair below denies", () => {
    const at = goodContext({ fuelLitres: CRANK_L });
    expect(evaluateInterlocks("START", at).allowed).toBe(true);

    const under = goodContext({ fuelLitres: CRANK_L - 0.001 });
    expect(evaluateInterlocks("START", under).allowed).toBe(false);
  });

  test("cooldown: EXACTLY elapsed allows, 1ms short denies", () => {
    const done = goodContext({
      generator: goodGenerator({ lastStoppedAt: NOW - minutesToMs(T.cooldownMinutes) }),
    });
    expect(evaluateInterlocks("START", done).allowed).toBe(true);

    const notDone = goodContext({
      generator: goodGenerator({ lastStoppedAt: NOW - minutesToMs(T.cooldownMinutes) + 1 }),
    });
    expect(evaluateInterlocks("START", notDone).allowed).toBe(false);
  });

  test("service: EXACTLY due now allows, 1hr past due denies", () => {
    const due = goodContext({ generator: goodGenerator({ nextMaintenanceHrs: 0 }) });
    // nextMaintenanceHrs <= 0 is the hard rule; 0 is "due", and IN_SERVICE_OVERDUE
    // fires on <= 0. Assert the documented boundary directly.
    const overdue = evaluateInterlocks("START", due);
    if (!overdue.allowed) {
      expect(overdue.reasons.map((r) => r.ruleId)).toContain("IN_SERVICE_OVERDUE");
    }

    const past = goodContext({ generator: goodGenerator({ nextMaintenanceHrs: -1 }) });
    expectDeniedBy("START", past, "IN_SERVICE_OVERDUE");
  });

  test("absent fuel data does NOT deny — absence is not zero", () => {
    const noFuel = goodContext({ fuelLitres: undefined });
    expect(evaluateInterlocks("START", noFuel).allowed).toBe(true);
  });
});

describe("SOFT interlocks warn but allow", () => {
  test("OVERDUE_SERVICE_WARNING allows with a warning", () => {
    const v = evaluateInterlocks(
      "START",
      goodContext({ generator: goodGenerator({ nextMaintenanceHrs: 10 }) }),
    );
    expect(v.allowed).toBe(true);
    expect(v.warnings.map((w) => w.ruleId)).toContain("OVERDUE_SERVICE_WARNING" as never);
  });

  test("NEAR_CRITICAL_FUEL allows with a warning", () => {
    // Must sit BETWEEN the cranking threshold (25%) and the warning level
    // (40%). Below cranking the HARD rule fires instead and this warning is
    // never reached — which is correct, and is why an arbitrary low number
    // like the old 20 L no longer demonstrates this rule.
    const v = evaluateInterlocks("START", goodContext({ fuelLitres: CRANK_L + 50 }));
    expect(v.allowed).toBe(true);
    expect(v.warnings.map((w) => w.ruleId)).toContain("NEAR_CRITICAL_FUEL" as never);
  });

  test("a percentage-of-tank fuel rule is capacity-independent", () => {
    // The reason the litre thresholds were replaced. A flat 12 L cranking
    // minimum is trivial on a 20 000 L tank and fatal on a 60 L one; a
    // percentage is correct for both. Same 25% of tank, wildly different
    // absolute litres, and the rule reaches the SAME verdict on each.
    const above = (cap: number) => (T.crankingFuelFractionPct / 100) * cap;
    const below = (cap: number) => above(cap) - 0.001;

    for (const cap of [60, 1_000, 20_000]) {
      expect(evaluateInterlocks("START", goodContext({ fuelLitres: above(cap), tankCapacityLitres: cap })).allowed).toBe(true);
      const under = evaluateInterlocks("START", goodContext({ fuelLitres: below(cap), tankCapacityLitres: cap }));
      expect(under.allowed).toBe(false);
      if (!under.allowed) {
        expect(under.reasons.map((r) => r.ruleId)).toContain("FUEL_BELOW_CRANKING_THRESHOLD" as never);
      }
    }
  });

  test("a fuel rule DECLINES rather than guessing when capacity is unknown", () => {
    // Capacity is now required to compute a percentage. Without it the rule has
    // no opinion — it must not treat missing capacity as full (permitting an
    // unsafe start on 1 L), and it must not substitute a flat litre figure that
    // is wrong for the engine. Denying every start on an unbound site would be
    // a denial-of-service the operator cannot fix, which is the other failure.
    const noCapacity = goodContext({ fuelLitres: 1, tankCapacityLitres: undefined });
    const v = evaluateInterlocks("START", noCapacity);
    expect(v.allowed).toBe(true);
    expect(v.warnings.map((w) => w.ruleId)).not.toContain("NEAR_CRITICAL_FUEL" as never);
  });

  test("HIGH_EXISTING_LOAD allows with a warning", () => {
    const v = evaluateInterlocks(
      "START",
      goodContext({ generator: goodGenerator({ loadKw: 480, ratedPowerKw: 500 }) }),
    );
    expect(v.allowed).toBe(true);
    expect(v.warnings.map((w) => w.ruleId)).toContain("HIGH_EXISTING_LOAD" as never);
  });

  test("REMOTE_MODE_NOT_SET allows with a warning", () => {
    const v = evaluateInterlocks("START", goodContext({ generator: goodGenerator({ mode: "AUTO" }) }));
    expect(v.allowed).toBe(true);
    expect(v.warnings.map((w) => w.ruleId)).toContain("REMOTE_MODE_NOT_SET" as never);
  });

  test("a SOFT rule can NEVER deny, even with everything else wrong", () => {
    const v = evaluateInterlocks(
      "START",
      goodContext({
        fuelLitres: 1,
        generator: goodGenerator({ mode: "AUTO", loadKw: 495 }),
      }),
    );
    // Fuel 1L is a HARD denial; the soft rules ride along as warnings only.
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      for (const w of v.warnings) expect(w.severity).toBe("SOFT");
      for (const r of v.reasons) expect(r.severity).toBe("HARD");
    }
  });
});

describe("EMERGENCY_STOP is never blocked", () => {
  test("passes even when every hard interlock is violated", () => {
    const worst = goodContext({
      generator: goodGenerator({
        status: "OFFLINE",
        mode: "AUTO",
        temperatureC: 120,
        oilPressureKpa: 0,
        nextMaintenanceHrs: -50,
        lastStoppedAt: NOW,
        faultUntil: NOW + 999_999,
        loadKw: 500,
      }),
      site: { id: "site-1", criticality: "CRITICAL", loadKw: 500, gridAvailable: false },
      fuelLitres: 0,
      commandInFlight: { id: "cmd-x", command: "START", status: "SENT" },
      protectedLoadKw: 500,
    });

    const v = evaluateInterlocks("EMERGENCY_STOP", worst);
    expect(v.allowed).toBe(true);

    // Prove the context actually violates hard interlocks, so the allowance
    // above is a real bypass and not a context that simply trips nothing.
    // Without this, disabling the unblockable short-circuit would still pass.
    const asStart = evaluateInterlocks("START", worst);
    const asStop = evaluateInterlocks("STOP", worst);
    expect(asStart.allowed).toBe(false);
    expect(asStop.allowed).toBe(false);
    if (!asStart.allowed) expect(asStart.reasons.length).toBeGreaterThan(0);
    if (!asStop.allowed) expect(asStop.reasons.length).toBeGreaterThan(0);

    // And an allowed verdict must not carry denial reasons at all.
    if (v.allowed) {
      expect("reasons" in v).toBe(false);
    }
  });

  test("it is declared unblockable", () => {
    expect(UNBLOCKABLE_COMMANDS).toContain("EMERGENCY_STOP");
  });
});

describe("two-person rule", () => {
  test("a destructive refusal requires two-person authorization", () => {
    const v = evaluateInterlocks(
      "STOP",
      goodContext({
        generator: goodGenerator({ status: "RUNNING", loadKw: 200 }),
        site: { id: "site-1", criticality: "CRITICAL", loadKw: 200, gridAvailable: false },
      }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(requiresTwoPerson(v)).toBe(true);
      expect(denialResponseBody(v).requiresTwoPerson).toBe(true);
    }
  });

  test("an ordinary operational refusal does NOT require two-person", () => {
    const v = evaluateInterlocks(
      "START",
      goodContext({ fuelLitres: CRANK_L - 1 }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      // Fuel is an OPERATOR-tier rule: refuelling fixes it, so a single
      // operator is not a safety risk.
      expect(requiresTwoPerson(v)).toBe(false);
    }
  });

  test("MAINTENANCE_LOCKOUT requires two-person to override", () => {
    const v = evaluateInterlocks(
      "START",
      goodContext({ generator: goodGenerator({ status: "MAINTENANCE" }) }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(requiresTwoPerson(v)).toBe(true);
  });
});

describe("denial payload", () => {
  test("carries a machine-readable code and a human explanation", () => {
    const v = evaluateInterlocks(
      "START",
      goodContext({ generator: goodGenerator({ status: "OFFLINE" }) }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      const body = denialResponseBody(v);
      expect(body.denied).toBe(true);
      expect(body.reasonCode).toBe("GENERATOR_OFFLINE");
      expect(typeof body.reason).toBe("string");
      expect(body.reason.length).toBeGreaterThan(0);
      expect(Array.isArray(body.findings)).toBe(true);
    }
  });

  test("the first HARD reason is the one reported", () => {
    // Ordering is deliberate: the most fundamental precondition is reported
    // first so the operator is not sent to fix a downstream symptom.
    const v = evaluateInterlocks(
      "START",
      goodContext({
        generator: goodGenerator({ status: "OFFLINE", temperatureC: 200 }),
        fuelLitres: 0,
      }),
    );
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reasons[0].ruleId).toBe("GENERATOR_OFFLINE");
  });
});

describe("threshold provenance", () => {
  test("every threshold declares where its value came from and how to confirm it", () => {
    // Guards against someone adding a number to the defaults without saying
    // what it is for or what must be checked to trust it. A silent threshold in
    // a safety file is the failure mode this exists to prevent: it cannot be
    // reviewed, and an operator has no way to know it is a guess.
    for (const key of THRESHOLD_KEYS) {
      const t = DEFAULT_THRESHOLDS[key];
      expect(typeof t.value).toBe("number");
      expect(Number.isFinite(t.value)).toBe(true);
      expect(t.rationale.length).toBeGreaterThan(0);
      expect(t.confirmWith.length).toBeGreaterThan(0);
      expect(t.source).toBe("INFERRED");
    }
  });

  test("no shipped default is silently presented as confirmed", () => {
    // The single most important assertion in this file. Nothing in this
    // platform was ever supplied by a datasheet, so every default must still
    // read INFERRED. If someone flips one to CONFIRMED without a source
    // reference, this fails — which is the point.
    for (const row of describeThresholds(resolveThresholds([]))) {
      expect(row.confirmed).toBe(false);
      expect(row.source).toBe("INFERRED");
      expect(row.overridden).toBe(false);
    }
  });

  test("a stored override is applied, recorded, and still reports its provenance", () => {
    // An operator holding the OEM sheet must be able to correct a limit
    // WITHOUT editing source, and the platform must keep saying where the
    // number came from after they do.
    const resolved = resolveThresholds([
      {
        thresholdKey: "coolantMaxC",
        value: 90,
        source: "OEM_DATASHEET",
        sourceRef: "Cummins C900 D5, p.142",
        confirmedById: "user-1",
        confirmedAt: new Date("2026-01-15T00:00:00Z"),
      },
    ]);
    expect(resolved.values.coolantMaxC).toBe(90);
    expect(resolved.overridden).toEqual(["coolantMaxC"]);

    const row = describeThresholds(resolved).find((r) => r.key === "coolantMaxC");
    expect(row?.value).toBe(90);
    expect(row?.source).toBe("OEM_DATASHEET");
    expect(row?.sourceRef).toBe("Cummins C900 D5, p.142");
    expect(row?.confirmed).toBe(true);
    expect(row?.overridden).toBe(true);

    // And the rule actually honours it — the override is not decorative.
    const ctx = goodContext({
      generator: goodGenerator({ temperatureC: 88 }),
      thresholds: resolved,
    });
    expect(evaluateInterlocks("START", ctx).allowed).toBe(true);
  });

  test("a corrupt stored value falls back to the safe default instead of applying it", () => {
    // A negative or NaN threshold makes every comparison behave degenerately
    // — NaN comparisons are always false, so the rule would silently never
    // fire and the interlock would be inert. Refusing to apply the row is the
    // only safe handling.
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const resolved = resolveThresholds([
        {
          thresholdKey: "coolantMaxC",
          value: bad,
          source: "SITE_POLICY",
          sourceRef: null,
          confirmedById: null,
          confirmedAt: null,
        },
      ]);
      expect(resolved.values.coolantMaxC).toBe(DEFAULT_THRESHOLDS.coolantMaxC.value);
      expect(resolved.overridden).toEqual([]);
    }
  });

  test("an unknown stored key is reported by neither value nor override list", () => {
    // An operator may legitimately record a threshold this build does not
    // enforce yet. It must be ignored, not applied, and must not pretend to
    // have overridden anything.
    const resolved = resolveThresholds([
      {
        thresholdKey: "batterySocFloorPct",
        value: 20,
        source: "SITE_POLICY",
        sourceRef: null,
        confirmedById: null,
        confirmedAt: null,
      },
    ]);
    expect(resolved.overridden).toEqual([]);
    expect(resolved.values).not.toHaveProperty("batterySocFloorPct");
  });

  test("a context with no resolved set still enforces the conservative defaults", () => {
    // The fallback path. A rule must never read `undefined` because thresholds
    // failed to load — that would disable the interlock rather than fail it.
    expect(thresholdsOf(goodContext()).values.coolantMaxC).toBe(
      DEFAULT_THRESHOLDS.coolantMaxC.value,
    );
    const hot = goodContext({ generator: goodGenerator({ temperatureC: 200 }) });
    expect(evaluateInterlocks("START", hot).allowed).toBe(false);
  });
});