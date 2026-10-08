import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { errorResponse, badRequest, forbidden } from "@/lib/fgmp/api-error";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { confirmEnrol } from "@/lib/fgmp/mfa/service";
import { audit } from "@/lib/fgmp/audit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code: z.string().min(6).max(10),
});

/**
 * POST /api/fgmp/mfa/verify-enrol — confirm enrolment with a code.
 *
 * This is where MFA actually starts being REQUIRED. A wrong code leaves the
 * account exactly as it was: enrolment is not enabled and no backup codes are
 * issued, so a failed attempt cannot half-configure anything.
 *
 * The response contains the backup codes ONCE. Only bcrypt hashes are stored,
 * so they cannot be re-displayed later and cannot be recovered by anyone who
 * reads the database — which is also why they cannot be emailed "just in case".
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
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

    if (!auth.user.tenantId) {
      return errorResponse(forbidden("MFA enrolment requires a tenant-scoped account"));
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

    const result = await confirmEnrol(auth.user.tenantId, auth.user.id, parsed.data.code);
    if (!result.ok) {
      const res = NextResponse.json(
        { error: "Verification failed", code: result.reason },
        { status: result.reason === "INVALID_CODE" ? 401 : 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: auth.user.id,
      tenantId: auth.user.tenantId,
      action: "MFA_ENROL_COMPLETE",
      entity: "MfaEnrollment",
      entityId: auth.user.id,
      details: { backupCodesIssued: result.backupCodes.length },
    });

    const res = NextResponse.json({
      enrolled: true,
      backupCodes: result.backupCodes,
      warning:
        "These codes are shown ONCE and cannot be recovered. Store them in the site safe now. " +
          "Without them a lost authenticator requires a two-person break-glass reset.",
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

