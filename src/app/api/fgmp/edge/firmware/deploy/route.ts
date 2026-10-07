import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { withTenant } from "@/lib/fgmp/tenant-context";
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
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

    // PHASE 3: scoped to the caller's tenant. Unscoped this returned null under
    // FORCE RLS for every id, making a firmware deploy impossible to launch.
    const dispenser = await withTenant(me.tenantId, (tx) =>
      tx.fuelDispenser.findUnique({
        where: { id: dispenserId },
        select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(dispenser?.site ?? null, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // PHASE 3: pass the authenticated tenant so the engine asserts the
    // dispenser's tenant matches before queueing anything.
    const result = await engine.applyFirmwareDeployment(
      dispenserId,
      releaseId,
      me.id,
      me.tenantId,
    );
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
