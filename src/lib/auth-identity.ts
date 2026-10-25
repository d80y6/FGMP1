/**
 * Authentication database access — the ONE deliberate cross-tenant exception.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Phase 1 enabled FORCE Row Level Security on every tenant table. Any query
 * without `app.tenant_id` in scope now returns zero rows instead of erroring,
 * which turned four authentication queries into silent empty results and made
 * the platform unloginable:
 *
 *     db.user.findUnique({ where: { email } })      -> null, for EVERY user
 *
 * The login lookup CANNOT be tenant-scoped, and wrapping it is not merely
 * awkward — it is impossible. You cannot know the tenant until you have found
 * the user, and "email -> user" is inherently cross-tenant. That is what
 * authentication *is*. So this module is the deliberate exception.
 *
 * ── WHY IT IS SAFE, AND WHY IT IS NARROW ───────────────────────────────────
 * The temptation is to "just move the web app to the owner role", which would
 * make every bug disappear by disabling the backstop this phase exists to
 * build. That is explicitly rejected. Instead:
 *
 *   1. The app's own DATABASE_URL is untouched. It stays `fgmp_app`, so RLS
 *      continues to enforce everywhere else.
 *   2. This module exposes ONLY the specific operations authentication needs —
 *      find a user by email, read a user by id, update that user's own
 *      lockout/lastLogin fields. There is no generic "run anything" escape
 *      hatch and no way to reach an arbitrary table through it.
 *   3. Every write is constrained to the row that was just authenticated. You
 *      cannot use this module to modify another user's record.
 *   4. It is only importable from the auth path; nothing else uses it.
 *
 * ── ENUMERATION ────────────────────────────────────────────────────────────
 * `findUserByEmail` is the one genuinely cross-tenant read here, so it is
 * rate-limited at the call site and paired with a constant-time password
 * comparison against a dummy hash. A missing user, a wrong password, a
 * disabled account and a locked account must be indistinguishable to the
 * caller in both response and timing — otherwise login becomes a user-enumeration
 * oracle. See `loginTimingGuard` in auth.ts.
 */

import type { PrismaClient, Role } from "@prisma/client";

/**
 * Owner/ops connection used ONLY for the authentication lookups.
 *
 * Sourced from the same variables as the rest of the system's owner access
 * (src/lib/fgmp/seed.ts uses FGMP_MIGRATE_DATABASE_URL; the scheduler prefers
 * FGMP_OPS_DATABASE_URL). Falls back to the ambient client if neither is set,
 * which under RLS yields null — a loud, visible login failure rather than a
 * silent privilege escalation.
 */
import { getOpsDb } from "@/lib/fgmp/owner-db";
import { db as ambientDb } from "@/lib/db";

/**
 * The client used for identity lookups.
 *
 * ── WHY THE FALLBACK IS A STATIC IMPORT (security fix, 2026-10) ─────────────
 * This used to be `require("@/lib/db").db` inside the function. Under the
 * bundler `require` of the `@/` alias does not resolve at runtime, so the
 * expression evaluated to `undefined` and the very next `.user.findUnique`
 * threw
 *
 *     Cannot read properties of undefined (reading 'user')
 *
 * which NextAuth surfaced as a login redirect to
 * `/api/auth/error?error=Cannot%20read%20properties%20of%20undefined…`. With no
 * ops credential configured — the documented posture for the web service, and
 * the state the retired Render blueprint actually deployed — NOBODY could sign
 * in, and the
 * failure looked like a credential problem. Reproduced on a live server: the
 * same login succeeded as soon as FGMP_OPS_DATABASE_URL was added, with no code
 * change.
 *
 * The fallback now resolves statically. Without an ops credential the lookup
 * runs on the RLS-enforced app role, which returns NO row for an unscoped read:
 * login then fails closed (invalid credentials) instead of crashing, and the
 * boot-time warning in src/lib/env.ts tells the operator why. That is the
 * intended behaviour — under FORCE RLS an identity lookup genuinely cannot be
 * done on the app role, so the missing credential must be visible, not fatal.
 */
function client(): PrismaClient {
  return getOpsDb() ?? ambientDb;
}

/** The user shape the auth path needs. Deliberately minimal. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
  passwordHash: string | null;
  active: boolean;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  sessionEpoch: number;
}

/**
 * Look up a user by email, across tenants.
 *
 * This is the one operation that cannot be tenant-scoped: the tenant is not
 * known until the user is found. Callers MUST rate-limit this and must not
 * reveal whether the email exists — see the enumeration notes above.
 */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const user = await client().user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      tenantId: true,
      passwordHash: true,
      active: true,
      failedLoginAttempts: true,
      lockedUntil: true,
      sessionEpoch: true,
    },
  });
  return user;
}

/**
 * Read a user's role and tenant by id.
 *
 * Used by the JWT callback on session refresh. The id comes from the SIGNED
 * token, never from client input, so this does not become a lookup oracle.
 */
export async function findUserIdentity(
  id: string,
): Promise<{ role: Role; tenantId: string; active: boolean; sessionEpoch: number } | null> {
  const user = await client().user.findFirst({
    where: { id },
    select: { role: true, tenantId: true, active: true, sessionEpoch: true },
  });
  return user;
}

/**
 * The authoritative state of the account behind a session token.
 *
 * Called on EVERY authenticated request (`requireAuth`), which is the point: a
 * JWT is a claim about the past, and authorization decisions must be about the
 * present. The cost is one primary-key lookup on the identity connection.
 */
export async function getSessionState(id: string): Promise<{
  id: string;
  role: Role;
  tenantId: string;
  active: boolean;
  sessionEpoch: number;
} | null> {
  try {
    return await client().user.findFirst({
      where: { id },
      select: { id: true, role: true, tenantId: true, active: true, sessionEpoch: true },
    });
  } catch {
    // A database failure must not become an authorization bypass. Returning
    // null makes the caller refuse the request (401), which is the fail-closed
    // direction; the alternative (trusting the token) is fail-open.
    return null;
  }
}

/**
 * Longest a request may rely on a session-state snapshot.
 *
 * The lookup is not cached at all: a revoked session must stop working on the
 * NEXT request, and a cache would create a window in which a deactivated
 * account still works. This constant documents that decision for reviewers, and
 * the value is deliberately not configurable.
 */
export const SESSION_STATE_CACHE_MS = 0;

/** Fields login is allowed to write. Nothing else is updatable through here. */
export interface AuthWritableFields {
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  /**
   * Session revocation counter. Bumped by password changes and MFA resets so
   * every token issued under the old credential stops working; never set from
   * request input.
   */
  sessionEpoch?: number;
}

/**
 * Update a user's own lockout / last-login state.
 *
 * Constrained to that single row by id. The caller must already have
 * authenticated (or attempted to authenticate) that user — this is not a
 * general-purpose user editor.
 */
export async function updateAuthUser(
  id: string,
  data: AuthWritableFields,
): Promise<void> {
  await client().user.update({ where: { id }, data });
}

/**
 * Invalidate every outstanding session for `id`.
 *
 * Increments the counter carried in each token; the next request from every
 * existing session fails the comparison in `requireAuth` and is refused with
 * 401 SESSION_REVOKED. Used on password change/reset and on MFA reset/disable —
 * the events after which an old token must not remain useful.
 *
 * Returns the new epoch, or null when the row could not be updated (the caller
 * then reports the credential change as failed rather than reporting success
 * while old sessions keep working).
 */
export async function revokeUserSessions(id: string): Promise<number | null> {
  try {
    const updated = await client().user.update({
      where: { id },
      data: { sessionEpoch: { increment: 1 } },
      select: { sessionEpoch: true },
    });
    return updated.sessionEpoch;
  } catch {
    return null;
  }
}

/** Close the auth connection on shutdown so the process can exit cleanly. */
export async function closeAuthClient(): Promise<void> {
  // The client is shared with the other privileged data-access helpers. Its
  // lifetime is process-wide, so only the centralized graceful-shutdown path
  // may disconnect it.
}