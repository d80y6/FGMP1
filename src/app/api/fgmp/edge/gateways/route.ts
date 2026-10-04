import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, siteTenantWhereOrAll } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/edge/gateways
 * Returns all SiteGateway rows with their site relation joined. Live state
 * (uptime, cpuTemp, heap, wifiRssi, lastSeenAt, status) is merged from the
 * in-memory engine so the dashboard always shows the freshest values
 * without waiting for the periodic 5-tick persistence.
 *
 * DISP-FW-GW — Edge & Firmware view → Gateways tab.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const gateways = await db.siteGateway.findMany({
      where: siteTenantWhereOrAll(auth.user),
      orderBy: { hostname: "asc" },
      include: { site: { select: { id: true, name: true, code: true } } },
    });

    // Merge live state from the engine so the UI sees fresh CPU/heap/RSSI
    // without waiting for the periodic persistence.
    const live = engine.gateways;
    const merged = gateways.map((g) => {
      const l = live.find((x) => x.id === g.id);
      return {
        ...g,
        liveStatus: l?.status ?? g.status,
        uptimeSec: l?.uptimeSec ?? g.uptimeSec,
        cpuTempC: l?.cpuTempC ?? g.cpuTempC,
        heapKb: l?.heapKb ?? g.heapKb,
        wifiRssi: l?.wifiRssi ?? g.wifiRssi,
        lastSeenAt: l?.lastSeenAt ?? g.lastSeenAt?.getTime() ?? Date.now(),
      };
    });

    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
