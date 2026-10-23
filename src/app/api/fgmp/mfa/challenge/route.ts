import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, badRequest } from "@/lib/fgmp/api-error";
import {
  rateLimitByIp,
  applyRateLimitHeaders,
  AUTH_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { verifyChallenge } from "@/lib/fgmp/mfa/service";
import { auditMfa } from "@/lib/fgmp/mfa/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  challengeToken: z.string().min(10).max(200),
  code: z.string().min(6).max(20),
});

/**
 * POST /api/fgmp/mfa/challenge — exchange a code for a FULL session.
 *
 * ── WHY THE SESSION IS ISSUED HERE AND NOT IN authorize() ────────────────────
 * NextAuth's Credentials `authorize()` returns a user or null — there is no
 * multi-step return, so the second factor cannot live inside it. Instead the
 * credentials callback returns a session marked `mfaPending`, which the guard in
 * `src/lib/fgmp/mfa/guard.ts` refuses on every protected route. This endpoint is
 * the ONLY way to exchange that pending session for a real one.
 *
 * ── WHAT "COMPLETE" MEANS HERE ───────────────────────────────────────────────
 * This route returns the verdict and the user identity. Issuing the actual
 * NextAuth session cookie requires the credentials provider's `authorize()` to
 * return the full user, which happens on the re-authentication the client
 * performs immediately after this returns `{ verified: true }`. Both steps are
 * required: this endpoint proves the second factor; the re-auth proves the
 * password again under the same request that mints the cookie.
 *
 * ── WHY THE CHALLENGE IS SPENT BEFORE THE CODE IS CHECKED ────────────────────
 * Consumption happens first, so a wrong code leaves the challenge spent. An
 * attacker cannot keep guessing against a live token — they must authenticate
 * again, which re-runs the password check, the account lockout and the rate
 * limiter. See `verifyChallenge` in the service layer.
 */
export async function POST(req: NextRequest) {
  try {
    // Unauthenticated by design: the caller has a PENDING session, not a real
    // one, so `requireAuth` would reject a legitimate challenge completion.
    // Limited per-IP and FAILS CLOSED, because this endpoint is the gate on a
    // security control.
    const rl = await rateLimitByIp(req, AUTH_LIMIT.limit, AUTH_LIMIT.windowMs, "closed", "login");
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorResponse(badRequest("Invalid JSON body"));
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(badRequest("Validation failed", parsed.error.issues));
    }

    const { challengeToken, code } = parsed.data;

    // The tenant is bound INTO the challenge at issue time, so it cannot be
    // replayed against another tenant. It is read here from the stored row
    // rather than accepted from the request body — a body-supplied tenantId
    // would be a cross-tenant read primitive.
    const resolved = await resolveChallengeTenant(challengeToken);
    if (!resolved.ok) {
      const res = NextResponse.json(
        { error: "Challenge is invalid or expired", code: resolved.reason },
        { status: 401 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const result = await verifyChallenge(resolved.tenantId, challengeToken, code);
    if (!result.ok) {
      const res = NextResponse.json(
        { error: "Verification failed", code: result.reason },
        { status: 401 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant-scoped, not the ambient audit() helper: this route runs outside
    // any ambient context, so audit() would fall back to the OWNER connection.
    await auditMfa({
      userId: resolved.userId,
      tenantId: resolved.tenantId,
      action: "MFA_CHALLENGE_VERIFIED",
      entity: "MfaChallenge",
      entityId: resolved.userId,
      // The METHOD is recorded, not the code. Knowing a backup code was used is
      // operationally important (they are being burned down) and reveals nothing.
      details: { method: result.method },
    });

    const res = NextResponse.json({
      verified: true,
      method: result.method,
      // The client re-authenticates immediately to mint the full session cookie.
      nextStep: "reauthenticate",
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/** Resolve which tenant/user a challenge belongs to, without trusting the body. */
async function resolveChallengeTenant(
  challengeToken: string,
): Promise<
  | { ok: true; tenantId: string; userId: string }
  | { ok: false; reason: string }
> {
  const { hashChallengeToken } = await import("@/lib/fgmp/mfa/challenge");
  // ── WHY THIS LOOKUP NEEDS A TENANT ─────────────────────────────────────────
  // A challenge token is presented by an UNAUTHENTICATED caller (a pending
  // session has no usable authority), so the tenant cannot come from the
  // session — it has to be discovered FROM the token.
  //
  // The obvious implementation is a single unscoped `db.mfaChallenge.findUnique`
  // by tokenHash. That is WRONG: `MfaChallenge` is FORCE-RLS protected, so an
  // unscoped read returns null for EVERY token. The route then reports
  // CHALLENGE_INVALID for a token it just issued correctly — which is exactly
  // what the live server did before this fix, and it made MFA verification
  // impossible to complete.
  //
  // So the token hash is resolved through a SECURITY DEFINER-style escape that
  // is deliberately scoped: find the tenant, and return ONLY the columns needed
  // to decide whether the challenge is live. It reads a hash, never a secret.
  const { findChallengeTenantByToken } = await import("@/lib/fgmp/mfa/service");
  const tokenHash = hashChallengeToken(challengeToken);
  const row = await findChallengeTenantByToken(tokenHash);
  if (!row) return { ok: false, reason: "CHALLENGE_INVALID" };

  // No spent/expired checks here, and that is deliberate: the SQL function
  // returns ONLY live rows (not used, not failed, not expired, under the
  // attempt limit), so it cannot be used to probe whether a challenge once
  // existed. Doing the liveness filtering here instead would mean selecting
  // those columns across tenants, which is the wider surface this avoids.
  return { ok: true, tenantId: row.tenantId, userId: row.userId };
}