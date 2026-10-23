import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { errorResponse, badRequest, forbidden } from "@/lib/fgmp/api-error";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { beginEnrol } from "@/lib/fgmp/mfa/service";
import { auditMfa } from "@/lib/fgmp/mfa/service";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/mfa/enrol — begin MFA enrolment.
 *
 * Returns the secret and an otpauth:// URI for an authenticator app. The factor
 * is NOT enabled by this call: the user must prove they can generate a code
 * (POST /verify-enrol) before MFA starts being required. Enrolling straight into
 * "enabled" would let anyone who briefly controlled a session enrol their own
 * factor.
 *
 * REFUSES when the encryption key is absent. An enrolment that cannot encrypt
 * its secret must not happen — the alternative is a stored secret nobody can
 * protect, which is MFA with the second factor removed.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const rl = await rateLimitByUser(
      req,
      auth.user.id,
      MUTATION_LIMIT.limit,
      MUTATION_LIMIT.windowMs,
    );
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (!tenantIdOrThrow(auth.user.tenantId)) {
      return errorResponse(forbidden("MFA enrolment requires a tenant-scoped account"));
    }

    const result = await beginEnrol(tenantIdOrThrow(auth.user.tenantId), auth.user.id, auth.user.email ?? auth.user.id);
    if (!result.ok) {
      // 400 rather than 503: the cause is an environment misconfiguration the
      // OPERATOR must fix, and the message says exactly what is missing.
      return errorResponse(badRequest(result.problem ?? result.reason));
    }

    await auditMfa({
      userId: auth.user.id,
      tenantId: tenantIdOrThrow(auth.user.tenantId),
      action: "MFA_ENROL_BEGIN",
      entity: "MfaEnrollment",
      entityId: auth.user.id,
      details: { stage: "begin" },
    });

    const res = NextResponse.json({
      secret: result.secret,
      otpauthUri: result.otpauthUri,
      issuer: "FGMP",
      account: auth.user.email ?? auth.user.id,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}