import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { errorResponse, forbidden } from "@/lib/fgmp/api-error";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  AUTH_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { issueChallenge } from "@/lib/fgmp/mfa/service";
import { auditMfa } from "@/lib/fgmp/mfa/service";
import { getSessionState } from "@/lib/auth-identity";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/mfa/challenge-request — issue a challenge for a PENDING session.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `POST /api/fgmp/mfa/challenge` VERIFIES a code; it never issued one. With no
 * endpoint that returns a `challengeToken`, the second factor could not be
 * completed at all: an enrolled user signed in, was refused everywhere by the
 * guard, and had no way to present a code. `issueChallenge()` was written and
 * imported into the verify route but never called from anywhere.
 *
 * So this is the other half of the loop, and it has to sit inside the
 * `/api/fgmp/mfa/` allowlist or a pending session could not reach it.
 *
 * ── WHO MAY CALL IT ─────────────────────────────────────────────────────────
 * Deliberately NOT restricted to `mfaPending` sessions. A user who has enrolled
 * but is carrying a full session can also request a challenge — that is how the
 * UI re-verifies before a sensitive action, and how a second factor is proven
 * without ending the current session first.
 *
 * A PENDING session has no tenantId, and `issueChallenge` needs one to scope the
 * challenge row, so a pending caller is refused here rather than being issued a
 * challenge it could never verify. That is the one case this endpoint does NOT
 * serve, and it is worth being explicit about: the pending session is expected
 * to already HOLD a challenge token from the login response, which
 * `authorize()` issued when it created the pending session.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const rl = await rateLimitByUser(
      req,
      auth.user.id,
      AUTH_LIMIT.limit,
      AUTH_LIMIT.windowMs,
    );
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── A PENDING session may ASK for its challenge (fix, 2026-10) ──────────
    // A pending session carries no tenant BY DESIGN, so this used to answer 403
    // and point at "the challenge token issued at login" — which `authorize()`
    // never issued. The result was a closed loop: no token at login, no way to
    // request one afterwards, and (once the enforcement bug in
    // `hasMfaEnabled` was fixed) no way for an enrolled operator to sign in at
    // all.
    //
    // The caller is already password-authenticated — that is what a pending
    // session means — so its tenant is resolved from the user row through the
    // same narrow privileged read the login path uses. It is never taken from
    // the request body, and the identity is re-checked (active, not deleted)
    // before a challenge is issued.
    let tenantId = auth.user.tenantId;
    if (!tenantId) {
      const state = await getSessionState(auth.user.id);
      if (!state || !state.active) {
        return errorResponse(forbidden("This account is not active."));
      }
      tenantId = state.tenantId;
    }

    const result = await issueChallenge(tenantId, auth.user.id);
    if (!result.ok) {
      const res = NextResponse.json(
        { error: "No MFA enrolment", code: result.reason },
        { status: result.reason === "MFA_NOT_CONFIGURED" ? 503 : 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await auditMfa({
      userId: auth.user.id,
      tenantId,
      action: "MFA_CHALLENGE_ISSUED",
      entity: "MfaChallenge",
      entityId: auth.user.id,
      details: { expiresInSeconds: result.expiresInSeconds },
    });

    const res = NextResponse.json({
      challengeToken: result.token,
      expiresInSeconds: result.expiresInSeconds,
      // The UI needs to know whether to offer "use a backup code" as an option.
      backupCodesAvailable: result.backupCodesAvailable,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
