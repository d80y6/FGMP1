import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, ApiError } from "@/lib/fgmp/api-error";
import { requireAuth, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { engine } from "@/lib/fgmp";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/iot/[id]/ota-status — poll an IoT device's OTA status.
 *
 * Returns the persisted IotDevice row plus the live in-memory OTA state
 * from the engine so the UI can observe the
 *   PENDING (null) → IN_PROGRESS → COMPLETE | FAILED
 * transition as the scheduled 8-second background worker resolves.
 *
 * Roles: any authenticated user (requireAuth) — the IoT view is visible
 * to operators of all roles.
 *
 * Rate-limited at READ_LIMIT. Unauthenticated requests get 401.
 *
 * This endpoint is ADDITIVE — the existing PATCH /api/fgmp/iot endpoint is
 * untouched.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
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

    const { id } = await params;

    const device = await db.iotDevice.findUnique({
      where: { id },
      include: { site: { select: { name: true, code: true, tenantId: true } } },
    });
    const tenantDenied = assertSiteTenantOwned(device?.site ?? null, user);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!device) throw new ApiError(404, "device not found");

    // Merge in the live in-memory OTA status from the engine — the
    // background worker updates the live copy immediately when it flips
    // the row to COMPLETE / FAILED, so this gives pollers a low-latency
    // view even when the DB write is briefly delayed.
    const live = engine.iotDevices.find((x) => x.id === id);

    const res = NextResponse.json({
      id: device.id,
      name: device.name,
      siteId: device.siteId,
      site: device.site,
      firmware: live?.firmware ?? device.firmware,
      otaTargetFw: live?.otaTargetFw ?? device.otaTargetFw,
      otaStatus: live?.otaStatus ?? device.otaStatus,
      status: live?.status ?? device.status,
      lastSeenAt: live?.lastSeenAt ?? device.lastSeenAt?.getTime() ?? null,
      // Convenience fields for the UI — elapsed seconds since the OTA was
      // kicked off isn't tracked on the row, but `updatedAt` reflects the
      // last DB write (the IN_PROGRESS flip), so the UI can render a
      // relative-time badge from it.
      updatedAt: device.updatedAt,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
