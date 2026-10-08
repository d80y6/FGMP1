import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  findUserByEmail,
  findUserIdentity,
  updateAuthUser,
} from "@/lib/auth-identity";

/**
 * FGMP Production Auth (Task 31-A)
 * ────────────────────────────────────────────────────────────────────────────
 * NextAuth v4 configuration using the Credentials provider with bcrypt-hashed
 * passwords stored on the User table. JWT session strategy (no database
 * sessions) — keeps the SQLite footprint small and the auth path stateless.
 *
 * Brute-force protection:
 *   - On a failed login the user's failedLoginAttempts counter is incremented.
 *   - At 5 consecutive failures the account is locked for 15 minutes
 *     (lockedUntil timestamp). authorize() refuses to issue a token while the
 *     lock is active.
 *   - A successful login resets both failedLoginAttempts and lockedUntil and
 *     stamps lastLoginAt.
 *
 * The JWT carries id, role, tenantId (in addition to the standard name/email/
 * picture). The session callback exposes those on session.user so client code
 * can read the role/tenant without an extra round-trip.
 */

const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * A fixed bcrypt hash compared against when no user was found.
 *
 * bcrypt.compare is deliberately expensive; short-circuiting it for an unknown
 * email makes "no such user" measurably faster than "wrong password", which
 * turns the login form into an account-enumeration oracle. Comparing against a
 * real hash of a throwaway value keeps the work — and therefore the timing —
 * comparable. It is a hash of a value nobody can supply, so it can never
 * authenticate anyone.
 *
 * Cost factor matches the seeded hashes (10) so the comparison takes the same
 * time as a genuine one.
 */
const DUMMY_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

/**
 * JWT signing secret.
 *
 * There is deliberately NO committed fallback. This previously defaulted to a
 * literal string committed in the repo, and `.env` did not set it — so as
 * shipped, anyone who read the source could forge a token with an arbitrary
 * `role`/`tenantId` and be SUPERADMIN without holding any credentials at all.
 *
 * Generate one with:
 *   openssl rand -base64 32
 *
 * NOTE — why this does not throw at module scope: `next build` imports every
 * route module to collect page data, and at that point runtime secrets
 * legitimately do not exist yet. Throwing here broke the production build
 * (it failed collecting data for /api/auth/[...nextauth]). So the placeholder
 * below exists only to let the module graph load, and `assertAuthConfigured()`
 * is called on the request path — every real request fails closed with a clear
 * message if the secret is genuinely missing.
 */
const BUILD_PLACEHOLDER_SECRET = "__fgmp_build_placeholder_not_a_real_secret__";

export const JWT_SECRET_CONFIGURED = (() => {
  const v = process.env.NEXTAUTH_SECRET;
  return !!v && v.trim().length >= 32;
})();

export function assertAuthConfigured(): void {
  if (JWT_SECRET_CONFIGURED) return;
  throw new Error(
    "NEXTAUTH_SECRET is missing or too short (min 32 chars). " +
      "Generate one with `openssl rand -base64 32` and set it for the app.",
  );
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  tenantId: string;
}

// ── NextAuth type augmentation ──────────────────────────────────────────────
// Extends the default User/Session/JWT types with our role + tenantId fields
// so the rest of the codebase gets full type-safety without casting.
declare module "next-auth" {
  interface User {
    id: string;
    role?: string;
    tenantId?: string;
  }
  interface Session {
    user: SessionUser;
    /**
     * TRUE when the password verified but the second factor has not.
     *
     * A session in this state carries NO authority: the guard in
     * src/lib/fgmp/mfa/guard.ts refuses it on every protected route and
     * allowlists only the MFA completion path. It is deliberately on the session
     * rather than inferred per-request, so a half-authenticated caller cannot
     * present as fully authenticated by omitting a field.
     */
    mfaPending?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    tenantId?: string;
    /**
     * Carried on the token so the pending state survives a page reload and is
     * re-evaluated server-side on every request rather than trusted from client
     * storage.
     */
    mfaPending?: boolean;
  }
}

/**
 * Session lifetime.
 *
 * ── WHY THIS IS SET AT ALL ───────────────────────────────────────────────────
 * `session: { strategy: "jwt" }` with no `maxAge` means a token is valid until
 * the signing secret rotates — which may be never. On a platform that can
 * REMOTE-START a generator, an unbounded session is a real risk: a laptop left
 * on a desk, a shared terminal, or a token lifted from a compromised host stays
 * authorised indefinitely, with no server-side event that could revoke it.
 *
 * ── WHY THESE VALUES ─────────────────────────────────────────────────────────
 * maxAge 8h — one shift. Long enough that an operator is not re-authenticating
 * constantly during an incident, short enough that a stolen token expires while
 * the shift it was stolen on is still relevant. Deliberately NOT sliding:
 * a token with no absolute expiry is a permanent credential.
 *
 * updateAge 1h — how often a SESSION cookie is refreshed when the user is
 * active. This is what makes a shift-long session possible while still bounding
 * how long an INACTIVE token stays usable without any human present.
 *
 * Both are env-overridable because the right value is a deployment decision: a
 * site with a physical control room may want longer, a field tablet on a moving
 * vehicle may want shorter. The DEFAULTS are the safe ones — an operator who
 * forgets to configure this still gets bounded sessions.
 */
const SESSION_MAX_AGE_MS = Number(process.env.FGMP_SESSION_MAX_AGE_MS ?? 8 * 60 * 60 * 1000);
const SESSION_UPDATE_AGE_MS = Number(process.env.FGMP_SESSION_UPDATE_AGE_MS ?? 60 * 60 * 1000);

/**
 * Reject a session configuration that would silently remove the bound.
 *
 * `Number("")` is 0 and `Number("abc")` is NaN, so a typo like
 * FGMP_SESSION_MAX_AGE_MS= (empty) would produce a zero or NaN lifetime and
 * reintroduce exactly the unbounded-session defect this change exists to fix.
 * A loud failure at boot beats a silently-insecure default.
 */
function assertSaneSessionConfig(maxAge: number, updateAge: number): void {
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

assertSaneSessionConfig(SESSION_MAX_AGE_MS, SESSION_UPDATE_AGE_MS);

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    /** Absolute lifetime. A token stops being valid here regardless of use. */
    maxAge: SESSION_MAX_AGE_MS,
    /** How often an active session's cookie is refreshed. */
    updateAge: SESSION_UPDATE_AGE_MS,
  },
  secret: process.env.NEXTAUTH_SECRET ?? BUILD_PLACEHOLDER_SECRET,
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        // ── Cross-tenant by design ──────────────────────────────────────
        // The tenant is not known until the user is found, so this lookup
        // cannot run inside withTenant(). It goes through the narrow auth
        // module instead — see src/lib/auth-identity.ts for why that is a
        // deliberate, narrow exception rather than moving the whole app to the
        // owner role (which would disable RLS everywhere).
        const user = await findUserByEmail(email);

        // ── Enumeration resistance ──────────────────────────────────────
        // Every failure path below returns the same `null`, but returning null
        // IMMEDIATELY for an unknown email makes the response measurably
        // faster than a wrong password, which turns login into an oracle for
        // "does this account exist". When there is no user we still run a
        // bcrypt comparison against a fixed dummy hash so the timing is
        // comparable.
        if (!user) {
          await bcrypt.compare(password, DUMMY_HASH);
          return null;
        }
        if (!user.passwordHash) {
          await bcrypt.compare(password, DUMMY_HASH);
          return null;
        }
        if (!user.active) {
          await bcrypt.compare(password, DUMMY_HASH);
          return null;
        }

        // Lock window still active? Compare the password anyway so a locked
        // account is not distinguishable from a wrong password by timing.
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
          await bcrypt.compare(password, user.passwordHash);
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          // Phase 0.7: an EXPIRED lock must reset the counter. Previously
          // failedLoginAttempts was only cleared on a successful login, so
          // once an account reached the threshold its counter stayed >= 5
          // forever and the very first failure after the lock expired
          // re-locked it immediately — a permanent lockout with no way out
          // short of a successful login. Start the count fresh whenever the
          // previous lock has lapsed.
          const lockLapsed =
            user.lockedUntil !== null && user.lockedUntil.getTime() <= Date.now();
          const priorAttempts = lockLapsed ? 0 : user.failedLoginAttempts;
          const attempts = priorAttempts + 1;
          const shouldLock = attempts >= LOCK_THRESHOLD;
          await updateAuthUser(user.id, {
            failedLoginAttempts: attempts,
            lockedUntil: shouldLock
              ? new Date(Date.now() + LOCK_DURATION_MS)
              : lockLapsed
                ? null
                : user.lockedUntil,
          });
          return null;
        }

        // Success — reset counters + stamp lastLoginAt.
        await updateAuthUser(user.id, {
          lastLoginAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      // Initial sign-in: user object is populated by authorize().
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.tenantId = user.tenantId;
      }
      // Session update (`useSession().update()` in AppShell, after a role
      // switch via PATCH /api/fgmp/me): re-read role + tenant from the DB.
      //
      // The `session` argument this callback used to accept is NOT used. It is
      // the client-supplied POST body (next-auth's core/index.js passes
      // `req.body?.data`) — untrusted input. Copying role/tenantId out of it
      // let any session mint itself a SUPERADMIN via
      // POST /api/auth/session {"data":{"role":"SUPERADMIN"}}. Reading the DB
      // instead preserves the role-switcher UX while keeping the token
      // server-derived: PATCH /api/fgmp/me is what authorizes the change, and
      // it rejects self-promotion to SUPERADMIN.
      if (trigger === "update" && token.id) {
        // tenantId comes from the SIGNED token, never from client input, so
        // scoping by it is safe: a forged value would fail the token
        // signature before reaching this line.
        //
        // Note this deliberately does NOT trust the session callback's `session`
        // argument — see the comment above. Reading the role/tenant from the
        // database keeps the token server-derived.
        const fresh = await findUserIdentity(token.id);
        if (fresh) {
          token.role = fresh.role;
          token.tenantId = fresh.tenantId;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id ?? "";
        session.user.role = token.role ?? "READONLY";
        session.user.tenantId = token.tenantId ?? "";
      }
      return session;
    },
  },
  pages: {
    // We don't ship a dedicated /signin page — login is a modal dialog
    // (src/components/fgmp/auth/login-dialog.tsx). NextAuth's default page
    // is left as a fallback so the underlying endpoint still works.
  },
};
