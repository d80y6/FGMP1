/**
 * Enforcement guard for a PENDING (half-authenticated) session.
 *
 * ── THE PROPERTY THIS EXISTS TO GUARANTEE ────────────────────────────────────
 * A session that has passed the password but NOT the second factor must not
 * reach a single protected route.
 *
 * A guard that protects the dashboard but not `/api/fgmp/generators/[id]/control`
 * is worse than no guard at all, because it looks like it works. So the rule is
 * expressed as an ALLOWLIST of what a pending session may reach — everything else
 * is refused — rather than a denylist of routes to protect. A new protected route
 * is therefore refused by default, and forgetting to add it to the denylist
 * cannot open a hole.
 */

import type { NextRequest } from "next/server";

/**
 * What a pending session may reach.
 *
 * Deliberately tiny. `/api/fgmp/mfa/*` completes the challenge; `/api/auth/*`
 * is the NextAuth surface that owns the session cookie; logout must remain
 * reachable or a user who entered a wrong code cannot escape.
 */
const PENDING_ALLOWED_PREFIXES = [
  "/api/fgmp/mfa/",
  "/api/auth/",
] as const;

const PENDING_ALLOWED_EXACT = new Set(["/api/auth/logout"]);

/** Paths that are reachable without any MFA state at all. */
const PUBLIC_PREFIXES = ["/login", "/api/auth/"] as const;

export type MfaSessionState = {
  /** True when the password verified but the second factor has not. */
  mfaPending: boolean;
  userId?: string;
  email?: string;
};

/** Is this path reachable by a session that has not completed MFA? */
export function pendingSessionMayAccess(pathname: string): boolean {
  if (PENDING_ALLOWED_EXACT.has(pathname)) return true;
  return PENDING_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Is this path public — reachable with no session at all? */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * The decision for one request.
 *
 * `null` means "not a pending session, carry on as before" — callers that have
 * no MFA state should ignore this entirely, so MFA costs nothing when it is not
 * configured.
 */
export type MfaDecision =
  | { blocked: false }
  | {
      blocked: true
      status: 403
      body: {
        error: string;
        code: string;
        mfaPending: true;
        /** Endpoint the client should call to complete the challenge. */
        completeAt: string;
      };
    };

export function evaluatePendingSession(
  pathname: string,
  state: MfaSessionState | null | undefined,
): MfaDecision {
  if (!state?.mfaPending) return { blocked: false };
  if (pendingSessionMayAccess(pathname)) return { blocked: false };
  return {
    blocked: true,
    status: 403,
    body: {
      error:
        "Multi-factor authentication is required before this resource can be used.",
      code: "MFA_PENDING",
      mfaPending: true,
      completeAt: "/api/fgmp/mfa/challenge",
    },
  };
}

/**
 * Test seam: the allowlist, so a test can enumerate protected routes and assert
 * every one of them refuses a pending session rather than trusting this list.
 */
export function pendingAllowlistForTest(): { prefixes: readonly string[]; exact: string[] } {
  return { prefixes: [...PENDING_ALLOWED_PREFIXES], exact: [...PENDING_ALLOWED_EXACT] };
}

/** Convenience for handlers that receive a NextRequest. */
export function pendingDecisionFor(
  req: NextRequest,
  state: MfaSessionState | null | undefined,
): MfaDecision {
  return evaluatePendingSession(req.nextUrl?.pathname ?? "/", state);
}