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
 * Returns the persisted ControlCommand row. The path-param `id` is the
 * generatorId (used to scope the lookup and prevent cross-generator
 * enumeration); `commandId` is the ControlCommand row id returned in the POST
 * response.
 *
 * ── WHAT THE STATUS ACTUALLY MEANS (corrected, Phase 5) ──────────────────
 * This comment previously claimed a
 *     PENDING → SENT → EXECUTED | FAILED | TIMEOUT
 * lifecycle. IT DOES NOT EXIST. `grep -rn '"EXECUTED"' src/` returns zero hits
 * and TIMEOUT is likewise never written. A comment asserting a safety
 * lifecycle that does not exist is worse than no comment, because it tells an
 * auditor the control is verified when nothing observes an outcome.
 *
 * What is actually written today:
 *   SENT   accepted by the application, and its SIMULATED dispatch applied to
 *          in-process state. No hardware was signalled.
 *   FAILED refused by a safety interlock, or the write itself failed.
 *
 * There is no transition out of SENT: no row becomes EXECUTED or TIMEOUT,
 * because nothing reports an outcome back. See the ControlCommand model doc in
 * prisma/schema.prisma for the same correction.
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
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
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
