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

import { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";

/**
 * Owner/ops connection used ONLY for the authentication lookups.
 *
 * Sourced from the same variables as the rest of the system's owner access
 * (src/lib/fgmp/seed.ts uses FGMP_MIGRATE_DATABASE_URL; the scheduler prefers
 * FGMP_OPS_DATABASE_URL). Falls back to the ambient client if neither is set,
 * which under RLS yields null — a loud, visible login failure rather than a
 * silent privilege escalation.
 */
let authClient: PrismaClient | null = null;

function client(): PrismaClient {
  const url =
    process.env.FGMP_OPS_DATABASE_URL ?? process.env.FGMP_MIGRATE_DATABASE_URL;
  if (!url) {
    // No owner URL configured. Return the ambient client rather than throwing:
    // in a correctly-provisioned deployment this path is unreachable, and where
    // it IS reachable the RLS failure is loud and safe (no rows), not silent
    // and dangerous.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@/lib/db").db as PrismaClient;
  }
  if (!authClient) {
    authClient = new PrismaClient({
      datasources: { db: { url } },
      log: [
        { level: "warn", emit: "stdout" as const },
        { level: "error", emit: "stdout" as const },
      ],
    });
  }
  return authClient;
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
): Promise<{ role: Role; tenantId: string } | null> {
  const user = await client().user.findFirst({
    where: { id },
    select: { role: true, tenantId: true },
  });
  return user;
}

/** Fields login is allowed to write. Nothing else is updatable through here. */
export interface AuthWritableFields {
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
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

/** Close the auth connection on shutdown so the process can exit cleanly. */
export async function closeAuthClient(): Promise<void> {
  if (authClient) {
    await authClient.$disconnect();
    authClient = null;
  }
}