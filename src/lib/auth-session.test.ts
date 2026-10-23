/**
 * Session-hardening tests.
 *
 * Run: bun test src/lib/auth-session.test.ts
 *
 * What is asserted here is narrow and deliberately so: that a session cannot be
 * configured without a valid lifetime. That is the defect Phase 5 task 4 was
 * about — `session: { strategy: "jwt" }` with no maxAge meant a token stayed
 * valid until the signing secret rotated, which on a platform that can
 * remote-start a generator is a real risk.
 *
 * These tests import `./auth-session` — a module with no Prisma or NextAuth
 * imports — and pass the environment they mean to test. The previous version
 * re-imported `./auth` with a cache-busting query string and relied on Bun
 * re-evaluating it: run on its own the suite passed, but run after the other
 * cases a stale evaluation leaked `updateAge === maxAge` into the next test.
 * A suite that changes colour with execution order is worse than no suite,
 * because it teaches people to re-run until green. Importing the pure module
 * also stops the test run from constructing a Prisma client it never uses.
 *
 * MFA is deliberately NOT tested because it is deliberately NOT implemented.
 * See docs/MFA.md for why a half-built TOTP would be worse than none.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SESSION_MAX_AGE_MS,
  DEFAULT_SESSION_UPDATE_AGE_MS,
  assertSaneSessionConfig,
  resolveSessionConfig,
} from "./auth-session";

describe("session lifetime", () => {
  test("defaults to a bounded session, not an unbounded one", () => {
    // The original defect: maxAge was undefined, so the token was valid
    // until the secret rotated.
    const { maxAge, updateAge } = resolveSessionConfig({});

    expect(maxAge).toBe(DEFAULT_SESSION_MAX_AGE_MS);
    expect(updateAge).toBe(DEFAULT_SESSION_UPDATE_AGE_MS);
    expect(maxAge).toBeGreaterThan(0);
    expect(updateAge).toBeLessThan(maxAge);
  });

  test("maxAge is one shift, not a token lifetime of forever", () => {
    const { maxAge, updateAge } = resolveSessionConfig({});
    const eightHours = 8 * 60 * 60 * 1000;

    expect(maxAge).toBe(eightHours);
    expect(updateAge).toBeLessThan(eightHours);
  });

  test("env overrides are honoured", () => {
    const { maxAge, updateAge } = resolveSessionConfig({
      FGMP_SESSION_MAX_AGE_MS: String(60 * 60 * 1000),
      FGMP_SESSION_UPDATE_AGE_MS: String(5 * 60 * 1000),
    });

    expect(maxAge).toBe(3_600_000);
    expect(updateAge).toBe(300_000);
  });

  test("the caller's own environment is the default source", () => {
    // `auth.ts` calls resolveSessionConfig() with no argument at boot; this
    // pins the shape of that call without importing the NextAuth module.
    const { maxAge } = resolveSessionConfig(process.env);
    expect(maxAge).toBeGreaterThan(0);
  });
});

describe("misconfiguration fails loudly rather than silently un-securing", () => {
  // A typo would reintroduce exactly the unbounded-session defect.
  test("an empty maxAge is rejected at boot", () => {
    expect(() => resolveSessionConfig({ FGMP_SESSION_MAX_AGE_MS: "" })).toThrow(
      /not a positive number/,
    );
  });

  test("a non-numeric maxAge is rejected", () => {
    expect(() =>
      resolveSessionConfig({ FGMP_SESSION_MAX_AGE_MS: "abc" }),
    ).toThrow(/not a positive number/);
  });

  test("a negative maxAge is rejected", () => {
    expect(() =>
      resolveSessionConfig({ FGMP_SESSION_MAX_AGE_MS: "-1" }),
    ).toThrow(/not a positive number/);
  });

  test("updateAge >= maxAge is rejected", () => {
    // Otherwise an active operator is logged out mid-shift, because the cookie
    // would never be refreshed before expiry.
    expect(() =>
      resolveSessionConfig({
        FGMP_SESSION_MAX_AGE_MS: "3600000",
        FGMP_SESSION_UPDATE_AGE_MS: "3600000",
      }),
    ).toThrow(/must be less than/);
  });

  test("an invalid updateAge is rejected", () => {
    expect(() =>
      resolveSessionConfig({ FGMP_SESSION_UPDATE_AGE_MS: "soon" }),
    ).toThrow(/non-negative number/);
  });

  test("assertSaneSessionConfig is exported for direct validation", () => {
    expect(() => assertSaneSessionConfig(0, 0)).toThrow(/not a positive number/);
    expect(() => assertSaneSessionConfig(1000, 1000)).toThrow(/must be less/);
    expect(() => assertSaneSessionConfig(1000, 10)).not.toThrow();
  });
});
