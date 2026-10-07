import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, tenantWhere, siteTenantWhere } from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { decimalsToJson } from "@/lib/fgmp/decimal";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/assets
 * ────────────────────────────────────────────────────────────────────────────
 * Returns the full Asset Registry in one round-trip: all fuel tanks, generators,
 * battery banks, IoT devices, and fuel dispensers — each with its parent site
 * name/code (dispensers also carry their linked tank) — plus a flat `sites`
 * array and a `tanks` array so the UI can populate the "Site" and "Tank"
 * <Select> dropdowns in the create/edit dialogs without extra round-trips.
 *
 * Note: this is a *management* surface, so dispenser rows are the plain DB
 * state (no live engine merge). Live flow/totalizer/status for dispensers is
 * served by GET /api/fgmp/dispensers for the monitoring view.
 *
 * ADMIN-only (this is a management surface).
 *
 * Wrapped in try/catch + rate-limited at READ_LIMIT (Task 34-C pattern).
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const siteSelect = { select: { name: true, code: true } } as const;
    const tankSelect = {
      select: { id: true, label: true, fuelType: true, capacityLitres: true, siteId: true },
    } as const;

    // Run all five findMany in parallel for snappy load.
    const [tanks, generators, batteries, iot, dispensers, sites] = await asTenant(me, (tx) =>
      Promise.all([
      tx.fuelTank.findMany({
        where: siteTenantWhere(me),
        orderBy: { label: "asc" },
        include: { site: siteSelect },
      }),
      tx.generator.findMany({
        where: siteTenantWhere(me),
        orderBy: { label: "asc" },
        include: { site: siteSelect },
      }),
      tx.batteryBank.findMany({
        where: siteTenantWhere(me),
        orderBy: { label: "asc" },
        include: { site: siteSelect },
      }),
      tx.iotDevice.findMany({
        where: siteTenantWhere(me),
        orderBy: { name: "asc" },
        include: { site: siteSelect },
      }),
      tx.fuelDispenser.findMany({
        where: siteTenantWhere(me),
        orderBy: [{ siteId: "asc" }, { label: "asc" }],
        include: { site: siteSelect },
      }),
      tx.site.findMany({
        where: tenantWhere(me),
        orderBy: { name: "asc" },
        select: { id: true, name: true, code: true },
      }),
    ]),
    );

    // `decimalsToJson` is load-bearing, not defensive. The volume columns are
    // `numeric(12,3)` and Prisma.Decimal serialises to a STRING, so without this
    // the UI receives `{ capacityLitres: "5000" }` where nine components declare
    // `capacityLitres: number` — 55 type errors in asset-registry-view alone.
    //
    // Found by p2-telemetry, who traced 207 tree-wide errors to this single
    // unsanitised route rather than converting call sites in the components. The
    // diagnosis was right: one route, one fix. Converting in the components
    // would have left the frontend tolerating two shapes indefinitely, which is
    // how the three divergent site-health formulas happened in the first place.
    const res = NextResponse.json(
      decimalsToJson({ tanks, generators, batteries, iot, dispensers, sites }),
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
