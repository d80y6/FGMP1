import type { Prisma, OtaStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  parseIntParam,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/edge/firmware/deployments
 * Paginated list of EspFirmwareDeployment rows (newest first), joined with
 * dispenser + release + initiatedBy. DISP-FW-GW — Edge & Firmware view →
 * Firmware tab → Deployments section.
 *
 * Query params:
 *   - limit   : page size (default 50, max 200)
 *   - offset  : page offset (default 0)
 *   - status  : filter to a single status (QUEUED, DOWNLOADING, FLASHING,
 *               SUCCESS, FAILED, ROLLED_BACK)
 *   - dispenserId : filter to a single dispenser
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { searchParams } = new URL(req.url);
    // parseIntParam: the previous `Math.min/max` + `Number()` yielded NaN for
    // junk input ("abc"), which Prisma rejects with a 500 instead of falling
    // back to the default.
    const limit = parseIntParam(searchParams.get("limit"), {
      min: 1,
      max: 200,
      fallback: 50,
    });
    const offset = parseIntParam(searchParams.get("offset"), {
      min: 0,
      max: 1_000_000,
      fallback: 0,
    });
    const status = searchParams.get("status") ?? undefined;
    const dispenserId = searchParams.get("dispenserId") ?? undefined;

    // Typed with Prisma's own generated type so the query keeps tracking the
    // schema; the hand-written shape widened `status` to `string`, which the
    // strict OtaStatus enum column rejects.
    const where: Prisma.EspFirmwareDeploymentWhereInput = {};
    if (status) where.status = status as OtaStatus;
    if (dispenserId) where.dispenserId = dispenserId;
    // Device firmware deployment rows are operational customer data. Scope
    // every role (including platform users) to the session tenant; cross-tenant
    // access belongs on an explicit audited support surface.
    where.dispenser = { site: { tenantId: tenantIdOrThrow(auth.user.tenantId) } };

    const [deployments, total] = await Promise.all([
            withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.espFirmwareDeployment.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          dispenser: {
            select: {
              id: true,
              label: true,
              pumpNumber: true,
              site: { select: { id: true, name: true, code: true } },
            },
          },
          release: {
            select: { id: true, version: true, channel: true },
          },
          initiatedBy: {
            select: { id: true, name: true, email: true },
          },
        },
      })),
            withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.espFirmwareDeployment.count({ where })),
    ]);

    const res = NextResponse.json({ deployments, total, limit, offset });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
