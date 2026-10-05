import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, ApiError } from "@/lib/fgmp/api-error";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";
import { withTenant } from "@/lib/fgmp/tenant-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/generators/[id]/control/[commandId] — poll a command's status.
 *
 * Returns the persisted ControlCommand row so the UI can observe the
 * PENDING → SENT → EXECUTED | FAILED | TIMEOUT lifecycle transition
 * without re-issuing the command. The path-param `id` is the generatorId
 * (used to scope the lookup and prevent cross-generator enumeration);
 * `commandId` is the ControlCommand row id returned in the POST response.
 *
 * Roles: ADMIN, NOC_OPERATOR (ROLES.CONTROL) — same as the POST endpoint.
 *
 * Rate-limited at READ_LIMIT. Unauthenticated requests get 401.
 *
 * This endpoint is ADDITIVE — the existing POST endpoint is untouched.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; commandId: string }> },
) {
  const auth = await requireRole(req, ROLES.CONTROL);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json(
        { error: "Too many requests" },
        { status: 429 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id: generatorId, commandId } = await params;

    // Tenant + cross-generator isolation: scope the lookup by both the
    // path-param generatorId AND the caller's tenant (via generator.site).
    // findFirst returns null when either guard fails — we surface a 404 to
    // avoid disclosing the existence of cross-tenant/cross-generator records.
    const cmd = await withTenant(user.tenantId, (tx) => tx.controlCommand.findFirst({
      where: {
        id: commandId,
        generatorId,
        generator: { site: { tenantId: user.tenantId } },
      },
      include: {
        issuedBy: { select: { id: true, name: true, email: true, role: true } },
      },
    }));
    if (!cmd) throw new ApiError(404, "command not found");

    const res = NextResponse.json(cmd);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
