import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { errorResponse, badRequest, forbidden } from "@/lib/fgmp/api-error";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { requestMfaReset, approveMfaReset } from "@/lib/fgmp/mfa/service";
import { audit } from "@/lib/fgmp/audit";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  userId: z.string().min(1),
  justification: z.string().min(10).max(1000),
});

const approveSchema = z.object({
  resetId: z.string().min(1),
});

/**
 * POST /api/fgmp/mfa/reset — request OR approve a break-glass MFA reset.
 *
 * ── WHY TWO PEOPLE ───────────────────────────────────────────────────────────
 * A single-operator reset is exactly the social-engineering attack this control
 * exists to stop: "I'm locked out, it's urgent, I'm the superadmin". Requiring a
 * second countersignature converts a convincing conversation into a logged,
 * attributable request — and the platform already accepts this shape, because
 * `InterlockOverride` requires requestedById + approvedById + a justification
 * before a safety bypass may proceed. This reuses that pattern rather than
 * inventing a second one.
 *
 * Self-approval is refused in the service layer AND again by the claim query, so
 * a race between two requests still produces one winner.
 *
 * A reset DISABLES the factor and forces re-enrolment. It does not clear the
 * flag and leave the account quietly less protected.
 *
 * SUPERADMIN only, matching the decision in docs/mfa-assessment.md.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  try {
    const rl = await rateLimitByUser(req, auth.user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (!auth.user.tenantId) {
      return errorResponse(forbidden("MFA reset requires a tenant-scoped account"));
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorResponse(badRequest("Invalid JSON body"));
    }
    const body = raw as Record<string, unknown>;
    const isApproval = "resetId" in body;

    if (isApproval) {
      const parsed = approveSchema.safeParse(raw);
      if (!parsed.success) return errorResponse(badRequest("Validation failed", parsed.error.issues));

      const result = await approveMfaReset(auth.user.tenantId, parsed.data.resetId, auth.user.id);
      if (!result.ok) {
        const res = NextResponse.json(
          { error: "Reset could not be approved", code: result.reason },
          { status: result.reason === "SELF_APPROVAL_FORBIDDEN" ? 403 : 400 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }

      // Both identities are recorded permanently, with the reason.
      await audit({
        userId: auth.user.id,
        tenantId: auth.user.tenantId,
        action: "MFA_RESET_APPROVED",
        entity: "MfaResetRequest",
        entityId: parsed.data.resetId,
        details: { twoPerson: true, note: "MFA disabled pending re-enrolment" },
      });

      const res = NextResponse.json({ approved: true, resetId: parsed.data.resetId });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return errorResponse(badRequest("Validation failed", parsed.error.issues));

    if (parsed.data.userId === auth.user.id) {
      // A SUPERADMIN who locks themselves out still needs a second person. That
      // is the cost of the control and it is the point.
      return errorResponse(
        forbidden("You cannot request a reset of your own MFA. A second authorised operator must approve it."),
      );
    }

    const result = await requestMfaReset(
      auth.user.tenantId,
      parsed.data.userId,
      auth.user.id,
      parsed.data.justification,
    );
    if (!result.ok) {
      const res = NextResponse.json({ error: "Reset could not be requested", code: result.reason }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: auth.user.id,
      tenantId: auth.user.tenantId,
      action: "MFA_RESET_REQUESTED",
      entity: "MfaResetRequest",
      entityId: result.id,
      details: { targetUserId: parsed.data.userId, justification: parsed.data.justification },
    });

    const res = NextResponse.json(
      { requested: true, resetId: result.id, requiresSecondApprover: true },
      { status: 201 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}