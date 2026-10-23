import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { withTenant } from "@/lib/fgmp/tenant-context";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, siteTenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

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
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // PHASE 3: RLS makes `where: { tenantId }` useless on its own — the policy
    // USING clause is ANDed with it and current_setting is NULL, so the row is
    // dropped regardless. The tenant context IS the filter; the explicit where
    // is kept only for the superadmin case where no single tenant applies.
    const gateways = await withTenant(tenantIdOrThrow(me.tenantId), (tx) =>
      tx.siteGateway.findMany({
        where: siteTenantWhereOrAll(auth.user),
        orderBy: { hostname: "asc" },
        include: { site: { select: { id: true, name: true, code: true } } },
      }),
    );

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
