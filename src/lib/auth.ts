import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

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
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    role?: string;
    tenantId?: string;
  }
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
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

        const user = await db.user.findUnique({ where: { email } });
        // Don't reveal whether the email exists — return null on all failure
        // paths so the client only sees a generic "invalid credentials".
        if (!user) return null;
        if (!user.passwordHash) return null;
        if (!user.active) return null;

        // Lock window still active?
        if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
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
          await db.user.update({
            where: { id: user.id },
            data: {
              failedLoginAttempts: attempts,
              lockedUntil: shouldLock
                ? new Date(Date.now() + LOCK_DURATION_MS)
                : lockLapsed
                  ? null
                  : user.lockedUntil,
            },
          });
          return null;
        }

        // Success — reset counters + stamp lastLoginAt.
        await db.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
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
        const fresh = await db.user.findUnique({
          where: { id: token.id },
          select: { role: true, tenantId: true },
        });
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
