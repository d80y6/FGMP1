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
  const auth = await requireAuth();
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

    if (!auth.user.tenantId) {
      // See above: a pending session has no tenant to scope a challenge row.
      return errorResponse(
        forbidden(
          "A pending session cannot request a new challenge. It should already hold " +
            "a challenge token issued at login.",
        ),
      );
    }

    const result = await issueChallenge(auth.user.tenantId, auth.user.id);
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
      tenantId: auth.user.tenantId,
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
