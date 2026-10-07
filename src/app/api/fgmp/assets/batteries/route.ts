import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const createBatterySchema = z.object({
  siteId: z.string().min(1),
  label: z.string().min(1).max(80),
  chemistry: z.string().min(1).max(60),
  capacityAh: z.number().positive(),
  nominalVoltage: z.number().positive(),
});

const batteryInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * POST /api/fgmp/assets/batteries
 * Create a new battery bank. Defaults: voltage=nominalVoltage,
 * stateOfCharge=80, stateOfHealth=95, status="OK", charging=false.
 * The engine overwrites live telemetry on the next tick.
 *
 * ADMIN-only.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = createBatterySchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { siteId, label, chemistry, capacityAh, nominalVoltage } = parsed.data;

    // Verify the site exists and belongs to the caller's tenant.
    // Scoped in the query so the caller's tenant can actually find the site.
    // assertTenantOwned is KEPT as defence in depth.
    const site = await asTenant(me, (tx) =>
      tx.site.findFirst({ where: { id: siteId, tenantId: me.tenantId }, select: { tenantId: true } }),
    );
    const siteDenied = assertSiteTenantOwned(site, me);
    if (siteDenied) {
      applyRateLimitHeaders(siteDenied.headers, rl);
      return siteDenied;
    }
    // `site` is null when it does not exist; assertSiteTenantOwned returns
    // null (allowed) for a same-tenant site, so the null case needs its own
    // check before `site.tenantId` is read.
    if (!site) {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Scoped write: an unscoped create is rejected by WITH CHECK outright, and
    // the nested include of `site` below is itself RLS-protected.
    const battery = await asTenant(me, (tx) =>
      tx.batteryBank.create({
      data: {
        siteId,
        tenantId: site.tenantId,
        label,
        chemistry,
        capacityAh,
        nominalVoltage,
        voltage: nominalVoltage,
        stateOfCharge: 80,
        stateOfHealth: 95,
        status: "OK",
      },
      include: batteryInclude,
    }));

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "BATTERY_CREATE",
      entity: "BatteryBank",
      entityId: battery.id,
      details: { siteId, label, chemistry, capacityAh, nominalVoltage },
    });

    const res = NextResponse.json(battery, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
