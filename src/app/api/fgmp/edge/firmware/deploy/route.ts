import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/edge/firmware/deploy
 * Queue an OTA firmware deployment for a single dispenser.
 *
 * Body: { dispenserId, releaseId }
 * RBAC: DISPENSER_CONTROL (ADMIN, NOC_OPERATOR, FIELD_ENGINEER).
 * Returns 202 with the new deployment id; the engine asynchronously
 * progresses the deployment through DOWNLOADING → FLASHING → SUCCESS.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.DISPENSER_CONTROL);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const dispenserId = typeof body.dispenserId === "string" ? body.dispenserId : "";
    const releaseId = typeof body.releaseId === "string" ? body.releaseId : "";
    if (!dispenserId || !releaseId) {
      const res = NextResponse.json(
        { error: "Missing required fields: dispenserId, releaseId" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant isolation: verify the target dispenser's site belongs to the
    // caller's tenant before queueing the OTA deployment.
    const dispenser = await db.fuelDispenser.findUnique({
      where: { id: dispenserId },
      select: { id: true, site: { select: { tenantId: true } } },
    });
    const denied = assertSiteTenantOwned(dispenser?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const result = await engine.applyFirmwareDeployment(dispenserId, releaseId, user.id);
    const res = NextResponse.json(
      result,
      { status: result.ok ? 202 : 409 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
