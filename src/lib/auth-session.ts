/**
 * Session lifetime configuration.
 *
 * Kept in its own module, free of Prisma and NextAuth imports, for two reasons:
 *
 *  1. The tests exercise it with an explicit environment object. An earlier
 *     version lived in `auth.ts` and the tests re-imported that module with a
 *     cache-busting query string, which made them depend on Bun's module-cache
 *     semantics — green in isolation, red when run after the other cases.
 *  2. Importing `auth.ts` transits `@/lib/db`, which constructs a Prisma client
 *     at module load. A pure validation unit test should not need a database
 *     driver, let alone fail with an engine error.
 *
 * The values and the failure modes are unchanged; `auth.ts` calls
 * `resolveSessionConfig()` once at boot, so a nonsensical configuration still
 * throws before the first request is served.
 */

/**
 * maxAge 8h — one shift. Long enough that an operator is not re-authenticating
 * constantly during an incident, short enough that a stolen token expires while
 * the shift it was stolen on is still relevant. Deliberately NOT sliding:
 * a token with no absolute expiry is a permanent credential.
 */
export const DEFAULT_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * updateAge 1h — how often a SESSION cookie is refreshed when the user is
 * active. This is what makes a shift-long session possible while still bounding
 * how long an INACTIVE token stays usable without any human present.
 */
export const DEFAULT_SESSION_UPDATE_AGE_MS = 60 * 60 * 1000;

export interface SessionConfig {
  maxAge: number;
  updateAge: number;
}

/** The subset of `process.env` this module reads. */
export type SessionEnv = Record<string, string | undefined>;

/**
 * Reject a session configuration that would silently remove the bound.
 *
 * `Number("")` is 0 and `Number("abc")` is NaN, so a typo like
 * FGMP_SESSION_MAX_AGE_MS= (empty) would produce a zero or NaN lifetime and
 * reintroduce exactly the unbounded-session defect this change exists to fix.
 * A loud failure at boot beats a silently-insecure default.
 */
export function assertSaneSessionConfig(maxAge: number, updateAge: number): void {
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    throw new Error(
      `FGMP_SESSION_MAX_AGE_MS is not a positive number (got ${maxAge}). ` +
        `A session with no valid lifetime is unbounded, which is the defect ` +
        `this setting exists to prevent.`,
    );
  }
  if (!Number.isFinite(updateAge) || updateAge < 0) {
    throw new Error(
      `FGMP_SESSION_UPDATE_AGE_MS must be a non-negative number (got ${updateAge}).`,
    );
  }
  if (updateAge >= maxAge) {
    // updateAge >= maxAge means the cookie is never refreshed before expiry,
    // so every user is logged out at maxAge regardless of activity.
    throw new Error(
      `FGMP_SESSION_UPDATE_AGE_MS (${updateAge}) must be less than ` +
        `FGMP_SESSION_MAX_AGE_MS (${maxAge}), otherwise active sessions are ` +
        `never refreshed and expire mid-shift.`,
    );
  }
}

/**
 * Resolve and validate the session lifetime from an environment.
 *
 * Both values are env-overridable because the right number is a deployment
 * decision: a site with a physical control room may want longer, a field tablet
 * on a moving vehicle may want shorter. The DEFAULTS are the safe ones — an
 * operator who forgets to configure this still gets bounded sessions.
 */
export function resolveSessionConfig(
  env: SessionEnv = process.env,
): SessionConfig {
  const maxAge = Number(env.FGMP_SESSION_MAX_AGE_MS ?? DEFAULT_SESSION_MAX_AGE_MS);
  const updateAge = Number(
    env.FGMP_SESSION_UPDATE_AGE_MS ?? DEFAULT_SESSION_UPDATE_AGE_MS,
  );
  assertSaneSessionConfig(maxAge, updateAge);
  return { maxAge, updateAge };
}
