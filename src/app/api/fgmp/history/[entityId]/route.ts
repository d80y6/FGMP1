import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

/**
 * Per-entity history.
 * ────────────────────────────────────────────────────────────────────────────
 * UNBOUNDED-SCAN AUDIT: this endpoint makes NO database query at all — it
 * serves the engine's in-memory `history`, which `backfillHistory()` fills
 * with 288 points and which `tick()` appends to with a
 * `if (history.length > HISTORY_POINTS) shift()` cap. There is therefore no
 * table scan here to bound. The endpoints that DO read the unbounded
 * SensorReading table (patterns, analytics `dailyCost`, runout-eta) now apply
 * an explicit `ts` window plus `take`.
 *
 * What the response does NOT do is lie about the cadence: the returned series
 * mixes the 288-point 5-minute backfill with live `tick()` points written at
 * the polling interval (5 s by default). A chart that assumes 5-minute spacing
 * therefore mis-times the axis, so `meta` reports the ACTUAL first/last
 * timestamps, the effective cadence and the sample count.
 */
function historyMeta(history: readonly { t: number }[]) {
  const first = history[0]?.t ?? null;
  const last = history[history.length - 1]?.t ?? null;
  const spanMs = first !== null && last !== null ? last - first : 0;
  const intervals = Math.max(0, history.length - 1);
  return {
    count: history.length,
    from: first === null ? null : new Date(first).toISOString(),
    to: last === null ? null : new Date(last).toISOString(),
    spanHours: Math.round((spanMs / 3_600_000) * 1000) / 1000,
    // Mean spacing between consecutive samples, seconds. Null for < 2 points.
    cadenceSeconds:
      intervals > 0 ? Math.round((spanMs / intervals / 1000) * 100) / 100 : null,
    note:
      "Cadence is not uniform: the series mixes a 5-minute backfill with live tick points. " +
      "Integrate over actual Δt rather than multiplying a point count by a fixed interval.",
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ entityId: string }> }) {
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
    const { entityId } = await params;

    // Platform roles are scoped to their own platform tenant here too. Engine
    // memory is multi-tenant; ordinary entity history must not bypass RLS or
    // support-session authorization merely because it is in memory.
    const tenantId = tenantIdOrThrow(user.tenantId);
    const tenantSiteIds = new Set(engine.sites.filter((s) => s.tenantId === tenantId).map((s) => s.id));
    const owns = (siteId: string) => tenantSiteIds.has(siteId);
    const notFound = () => {
      const res = NextResponse.json({ error: "not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    };

    const tank = engine.tanks.find((t) => t.id === entityId);
    if (tank) {
      if (!owns(tank.siteId)) return notFound();
      const res = NextResponse.json({
        kind: "TANK",
        history: tank.history,
        meta: historyMeta(tank.history),
      });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const gen = engine.generators.find((g) => g.id === entityId);
    if (gen) {
      if (!owns(gen.siteId)) return notFound();
      const res = NextResponse.json({
        kind: "GENERATOR",
        history: gen.history,
        meta: historyMeta(gen.history),
      });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const batt = engine.batteries.find((b) => b.id === entityId);
    if (batt) {
      if (!owns(batt.siteId)) return notFound();
      const res = NextResponse.json({
        kind: "BATTERY",
        history: batt.history,
        meta: historyMeta(batt.history),
      });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    return notFound();
  } catch (err) {
    return errorResponse(err);
  }
}
