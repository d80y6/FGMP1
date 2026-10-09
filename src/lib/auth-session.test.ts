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
 * MFA is deliberately NOT tested because it is deliberately NOT implemented.
 * See docs/mfa-assessment.md for why a half-built TOTP would be worse than none.
 */

import { describe, expect, test } from "bun:test";

/**
 * Import the module under a specific session configuration.
 *
 * The restore happens in a `finally`, not in a caller-invoked `restore()`.
 *
 * The reason is specific and cost a debugging session: `auth.ts` THROWS for a
 * nonsensical session configuration, and that throw happens inside the dynamic
 * `import()`. A `restore()` the caller must remember to invoke is therefore
 * never invoked on exactly the tests that assert rejection — so those tests
 * left `FGMP_SESSION_MAX_AGE_MS=3600000` and
 * `FGMP_SESSION_UPDATE_AGE_MS=3600000` in `process.env` for every LATER test
 * file in the run, and any module importing `auth.ts` afterwards failed with
 * `updateAge must be less than maxAge` — an error naming a config nobody set.
 *
 * Restoring unconditionally means a rejected configuration cannot escape.
 */
async function loadAuth(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    // Cache-bust so the module re-evaluates with the new configuration.
    const mod = await import("./auth?cfg=" + Math.random());
    return { restore, authOptions: mod.authOptions };
  } finally {
    restore();
  }
}

describe("session lifetime", () => {
  test("defaults to a bounded session, not an unbounded one", async () => {
    const { restore, authOptions } = await loadAuth({
      FGMP_SESSION_MAX_AGE_MS: undefined,
      FGMP_SESSION_UPDATE_AGE_MS: undefined,
    });
    try {
      // The original defect: maxAge was undefined, so the token was valid
      // until the secret rotated.
      expect(authOptions.session?.maxAge).toBeDefined();
      expect(authOptions.session?.maxAge).toBeGreaterThan(0);
      expect(authOptions.session?.updateAge).toBeDefined();
    } finally {
      restore();
    }
  });

  test("maxAge is one shift, not a token lifetime of forever", async () => {
    const { restore, authOptions } = await loadAuth({});
    try {
      const eightHours = 8 * 60 * 60 * 1000;
      expect(authOptions.session?.maxAge).toBe(eightHours);
      expect(authOptions.session?.updateAge).toBeLessThan(eightHours);
    } finally {
      restore();
    }
  });

  test("env overrides are honoured", async () => {
    const { restore, authOptions } = await loadAuth({
      FGMP_SESSION_MAX_AGE_MS: String(60 * 60 * 1000),
      FGMP_SESSION_UPDATE_AGE_MS: String(5 * 60 * 1000),
    });
    try {
      expect(authOptions.session?.maxAge).toBe(3_600_000);
      expect(authOptions.session?.updateAge).toBe(300_000);
    } finally {
      restore();
    }
  });
});

describe("misconfiguration fails loudly rather than silently un-securing", () => {
  // A typo would reintroduce exactly the unbounded-session defect.
  test("an empty maxAge is rejected at boot", async () => {
    await expect(
      loadAuth({ FGMP_SESSION_MAX_AGE_MS: "" }),
    ).rejects.toThrow(/not a positive number/);
  });

  test("a non-numeric maxAge is rejected", async () => {
    await expect(loadAuth({ FGMP_SESSION_MAX_AGE_MS: "abc" })).rejects.toThrow(
      /not a positive number/,
    );
  });

  test("updateAge >= maxAge is rejected", async () => {
    // Otherwise an active operator is logged out mid-shift, because the cookie
    // would never be refreshed before expiry.
    await expect(
      loadAuth({
        FGMP_SESSION_MAX_AGE_MS: "3600000",
        FGMP_SESSION_UPDATE_AGE_MS: "3600000",
      }),
    ).rejects.toThrow(/must be less than/);
  });
});