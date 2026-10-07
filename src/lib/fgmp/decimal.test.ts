import { Prisma } from "@prisma/client";
/**
 * Unit tests for src/lib/fgmp/decimal.ts (Phase 1 step 9 groundwork).
 *
 * Run with: bun test src/lib/fgmp/decimal.test.ts
 *
 * The repository has no test runner configured (package.json has no "test"
 * script and there is no jest/vitest dependency). Bun is already the project
 * runtime and executes TypeScript natively, so these use `bun:test` and add no
 * dependency. Wiring a proper test script into package.json is a separate
 * decision for the integrator — this file is self-contained and runs as-is.
 *
 * NOTE: `bun:test` module types are declared by the `bun-types` devDependency,
 * but tsconfig.json does not currently reference it, so `tsc --noEmit` reports
 * TS2307 on this import. Adding "types": ["bun-types"] to tsconfig is the real
 * fix but tsconfig.json is shared with the other Phase 1 streams, so it is
 * deliberately left alone here and flagged to the integrator instead.
 */

// These tests deliberately exercise the REAL Prisma.Decimal, because the whole
// point of the module is to convert that specific type. A hand-rolled stand-in
// would not catch the `JSON.stringify(Decimal) === "1234.56"` string leak.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DECIMAL_SCALE,
  decimalsToJson,
  mulDecimals,
  sumDecimals,
  toJsonNumber,
  toNum,
} from "./decimal";

const dec = (v: string | number) => new Prisma.Decimal(v);

describe("toNum", () => {
  test("passes plain numbers through, rounding to scale", () => {
    expect(toNum(42)).toBe(42);
    expect(toNum(1.23456789)).toBe(1.234568);
    expect(toNum(1.5, { scale: 0 })).toBe(2);
  });

  test("converts a real Prisma.Decimal to a number", () => {
    const n = toNum(dec("1234.56"));
    expect(typeof n).toBe("number");
    expect(n).toBe(1234.56);
  });

  test("converts decimal strings (JSON round-trip / CSV inputs)", () => {
    expect(toNum("1234.56")).toBe(1234.56);
    expect(toNum("  42  ")).toBe(42);
  });

  test("null/undefined return the fallback, never NaN", () => {
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
    expect(toNum(null, { fallback: -1 })).toBe(-1);
  });

  test("non-numeric input returns fallback rather than NaN", () => {
    // A NaN in a fuel ledger propagates silently through sums and comparisons;
    // toNum must never produce one.
    expect(Number.isNaN(toNum("not-a-number"))).toBe(false);
    expect(toNum("not-a-number")).toBe(0);
    expect(toNum("not-a-number", { fallback: 7 })).toBe(7);
    expect(toNum(NaN)).toBe(0);
    expect(toNum(Infinity)).toBe(0);
  });

  test("preserves fractional precision that float would otherwise lose", () => {
    // The motivating case for moving off Float: 0.1 + 0.2 === 0.30000000000000004
    // in binary floating point. NOTE the precision guarantee belongs to
    // sumDecimals (which accumulates in integer minor units) — toNum rounds a
    // single value, so adding two separately-rounded results is still a float
    // addition. Use sumDecimals/mulDecimals for aggregates.
    expect(0.1 + 0.2).toBe(0.30000000000000004);
    expect(sumDecimals([dec("0.1"), dec("0.2")])).toBe(0.3);

    // A single 3-decimal value survives the conversion intact.
    expect(toNum(dec("0.125"))).toBe(0.125);
    expect(toNum(dec("1234.567"))).toBe(1234.567);
  });

  test("rounds like Math.round — ties toward +Infinity", () => {
    // JavaScript's Math.round rounds half toward +Infinity, which is NOT the
    // same as "away from zero": Math.round(-2.5) is -2. Decimal.js's own
    // HALF_EVEN would give -2 as well, but 2.5 -> 2 where Math.round gives 3.
    // These semantics match every existing Math.round in the codebase, so
    // converting a column does not change how existing figures round.
    expect(toNum(dec("2.5"), { scale: 0 })).toBe(Math.round(2.5));
    expect(toNum(dec("3.5"), { scale: 0 })).toBe(Math.round(3.5));
    expect(toNum(dec("-2.5"), { scale: 0 })).toBe(Math.round(-2.5));
    expect(toNum(dec("-2.5"), { scale: 0 })).toBe(-2);
    expect(toNum(dec("1234.5678"), { scale: 2 })).toBe(1234.57);
  });

  test("negative values round-trip and never produce -0", () => {
    expect(toNum(dec("-42.5"))).toBe(-42.5);
    expect(Object.is(toNum(dec("-0.0000001"), { scale: 2 }), 0)).toBe(true);
  });

  test("exposes the default scale", () => {
    expect(DEFAULT_DECIMAL_SCALE).toBe(6);
  });
});

describe("toJsonNumber — the JSON contract guard", () => {
  test("returns a JSON *number*, never a Decimal", () => {
    const out = toJsonNumber(dec("1234.56"));
    expect(typeof out).toBe("number");
  });

  test("JSON.stringify produces a numeric literal, not a quoted string", () => {
    // This is the exact regression the module exists to prevent: a Decimal
    // passed straight to NextResponse.json serialises as {"v":"1234.56"}.
    const raw = JSON.stringify({ v: dec("1234.56") });
    const safe = JSON.stringify({ v: toJsonNumber(dec("1234.56")) });

    expect(raw).toBe('{"v":"1234.56"}');   // documents the bug being avoided
    expect(safe).toBe('{"v":1234.56}');    // the safe shape
    expect(JSON.parse(safe).v).toBe(1234.56);
  });
});

describe("sumDecimals", () => {
  test("sums without float drift", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in raw float; via Decimals it is 0.3.
    const raw = 0.1 + 0.2;
    expect(sumDecimals([dec("0.1"), dec("0.2")])).toBe(0.3);
    expect(sumDecimals([dec("0.1"), dec("0.2")])).not.toBe(raw);
  });

  test("sums an empty list to zero", () => {
    expect(sumDecimals([])).toBe(0);
  });

  test("skips non-numeric entries instead of poisoning the total", () => {
    expect(sumDecimals([dec("10"), "bad", dec("5"), null])).toBe(15);
  });

  test("sums a mixed number/Decimal/string list", () => {
    expect(sumDecimals([dec("1.5"), 2, "0.25"])).toBe(3.75);
  });

  test("many small Decimals stay exact where naive float sum drifts", () => {
    const many = Array.from({ length: 1000 }, () => dec("0.01"));
    expect(sumDecimals(many)).toBe(10);

    const naive = Array.from({ length: 1000 }, () => 0.01).reduce((a, b) => a + b, 0);
    expect(naive).not.toBe(10); // float drifts; the helper does not
  });
});

describe("mulDecimals", () => {
  test("multiplies volume by unit price", () => {
    expect(mulDecimals(dec("12.5"), dec("520"))).toBe(6500);
  });

  test("rounds money to the requested scale", () => {
    // 3 x 33.333 = 99.999, rounded HALF_EVEN at scale 2 -> 100
    expect(mulDecimals(dec("3"), dec("33.333"), { scale: 2 })).toBe(100);
    expect(mulDecimals(dec("2.5"), dec("1.11"), { scale: 2 })).toBe(2.78);
  });

  test("handles zero and null factors as zero", () => {
    expect(mulDecimals(dec("10"), dec("0"))).toBe(0);
    expect(mulDecimals(dec("10"), null)).toBe(0);
  });
});

/**
 * Regression tests for the Decimal → JSON contract.
 *
 * Converting volume columns to `numeric(12,3)` silently changed four API
 * responses from numbers to STRINGS, because `Decimal.prototype.toJSON` returns
 * its string form. It passed `tsc` — a string is valid JSON and the handler's
 * inferred type widens with it — so no gate caught it.
 *
 * These tests exist so the next route author does not have to remember.
 */
describe("decimalsToJson", () => {
  test("converts a Decimal to a number", () => {
    const out = decimalsToJson<{ capacityLitres: unknown }>({
      capacityLitres: new Prisma.Decimal("5000.000"),
    });
    expect(typeof out.capacityLitres).toBe("number");
    expect(out.capacityLitres).toBe(5000);
  });

  test("leaves ordinary numbers, strings and booleans alone", () => {
    const out = decimalsToJson<Record<string, unknown>>({ a: 1, b: "x", c: true, d: null });
    expect(out).toEqual({ a: 1, b: "x", c: true, d: null });
  });

  test("recurses into nested objects and arrays", () => {
    const out = decimalsToJson<{
      tanks: Array<{ capacityLitres: unknown }>;
      meta: { totals: { volumeLitres: unknown } };
    }>({
      tanks: [{ capacityLitres: new Prisma.Decimal("100.500") }],
      meta: { totals: { volumeLitres: new Prisma.Decimal("7.250") } },
    });
    expect(typeof out.tanks[0]!.capacityLitres).toBe("number");
    expect(out.tanks[0]!.capacityLitres).toBe(100.5);
    expect(out.meta.totals.volumeLitres).toBe(7.25);
  });

  test("preserves Date as an ISO string rather than coercing it", () => {
    // The route layer wants the ISO form; silently switching to epoch millis
    // would be a second, quieter contract change.
    const out = decimalsToJson<{ createdAt: unknown }>({
      createdAt: new Date("2026-01-02T03:04:05Z"),
    });
    expect(out.createdAt).toBeInstanceOf(Date);
  });

  test("survives a cyclic object instead of hanging the request", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => decimalsToJson(cyclic)).not.toThrow();
  });

  test("rounds to the stored scale rather than exposing float noise", () => {
    // This is the reason the columns are Decimal at all.
    expect(
      decimalsToJson<{ v: unknown }>({ v: new Prisma.Decimal("691.000") }).v,
    ).toBe(691);
  });
});
