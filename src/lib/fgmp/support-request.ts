/**
 * Request-side plumbing for the platform support surface.
 *
 * Kept separate from `support-session.ts` (which must stay importable with no
 * Prisma client and no Next request scope) and from the route handlers (which
 * should read as policy, not as cookie plumbing).
 *
 * ── THE ONE RULE THIS FILE EXISTS TO MAKE HARD TO BREAK ─────────────────────
 * Every route under /api/fgmp/platform/ starts with `requireSuperAdmin()`. Not
 * `requireAuth()`, not a capability check that SUPERADMIN happens to satisfy
 * today. The platform surface is the one place where "authenticated" and
 * "allowed" are genuinely different questions, and the answer to the second is
 * a single role.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireRole, ROLES, type AuthResult } from "@/lib/fgmp/auth-helpers";
import {
  SUPPORT_COOKIE,
  SupportSessionError,
  resolveActiveSupport,
  type ActiveSupportSession,
} from "@/lib/fgmp/support-session";

/** SUPERADMIN only. Returns the same shape as the other auth helpers so a
 *  route can `if ("error" in auth) return auth.error;`. */
export function requireSuperAdmin(req: NextRequest): Promise<AuthResult> {
  return requireRole(req, ROLES.SUPERADMIN_ONLY);
}

/**
 * The signed support token from the request cookies, if present.
 *
 * Returns undefined outside a request scope (unit tests, scripts) rather than
 * throwing: "no cookie" and "no request" both mean "no support session", which
 * is the safe answer.
 */
export async function readSupportToken(): Promise<string | undefined> {
  try {
    const store = await cookies();
    return store.get(SUPPORT_COOKIE)?.value;
  } catch {
    return undefined;
  }
}

/** The support session this request may act under, or null. */
export async function currentSupport(
  user: { id: string; role?: string },
  token?: string,
): Promise<ActiveSupportSession | null> {
  const value = token ?? (await readSupportToken());
  return resolveActiveSupport(user, value);
}

/** Translate a `SupportSessionError` into an HTTP response, or null when the
 *  error is not one of ours (the caller then rethrows to `errorResponse`). */
export function supportErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SupportSessionError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    );
  }
  return null;
}

/** Body of the "no support session" refusal, shared by the support routes. */
export function noSupportSession(): NextResponse {
  return NextResponse.json(
    {
      error:
        "No active support session. Open one at POST /api/fgmp/platform/support-sessions, naming a single tenant and a reason.",
      code: "NO_SUPPORT_SESSION",
    },
    { status: 403 },
  );
}

/** Cookie options for the support token. Path-limited to the platform API so
 *  the token is not sent to every tenant route in the application. */
export const SUPPORT_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // `strict` rather than `lax`: a support token must never travel on a
  // cross-site navigation. Nothing links into the support API directly.
  sameSite: "strict" as const,
  path: "/api/fgmp/platform",
};
