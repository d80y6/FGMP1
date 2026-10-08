import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { errorResponse, badRequest, forbidden } from "@/lib/fgmp/api-error";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { disableMfa, backupCodesRemaining } from "@/lib/fgmp/mfa/service";
import { audit } from "@/lib/fgmp/audit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // A valid code is REQUIRED. Disabling your own second factor must not be a
  // single authenticated request away — otherwise a stolen live session can
  // strip the factor and then log in with the password alone.
  code: z.string().min(6).max(20),
  reason: z.string().min(5).max(500),
});

/**
 * POST /api/fgmp/mfa/disable — turn off MFA for your own account.
 *
 * Requires a valid authenticator code or backup code, so possession is proven
 * BEFORE the factor is removed. A backup code is NOT consumed here: consuming it
 * would let a user burn through their recovery codes by toggling the setting.
 *
 * If the operator has genuinely lost the authenticator AND their backup codes,
 * this endpoint is deliberately not the path. The two-person break-glass reset is.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const rl = await rateLimitByUser(req, auth.user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (!auth.user.tenantId) {
      return errorResponse(forbidden("MFA requires a tenant-scoped account"));
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

    const result = await disableMfa(
      auth.user.tenantId,
      auth.user.id,
      parsed.data.code,
      parsed.data.reason,
    );
    if (!result.ok) {
      const res = NextResponse.json({ error: "Could not disable MFA", code: result.reason }, { status: 401 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: auth.user.id,
      tenantId: auth.user.tenantId,
      action: "MFA_DISABLED",
      entity: "MfaEnrollment",
      entityId: auth.user.id,
      details: { reason: parsed.data.reason, selfService: true },
    });

    const remaining = await backupCodesRemaining(auth.user.tenantId, auth.user.id);
    const res = NextResponse.json({
      disabled: true,
      backupCodesRemaining: remaining,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}