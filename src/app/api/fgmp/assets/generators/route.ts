import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const FUEL_TYPES = ["DIESEL", "PETROL", "BIOFUEL"] as const;

const createGeneratorSchema = z.object({
  siteId: z.string().min(1),
  label: z.string().min(1).max(80),
  manufacturer: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  ratedPowerKw: z.number().positive(),
  fuelType: z.enum(FUEL_TYPES),
});

const generatorInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * POST /api/fgmp/assets/generators
 * Create a new generator. Defaults: status=STOPPED, mode=AUTO,
 * runtimeHours=0, oilChangeIntervalHrs=250, nextMaintenanceHrs=250, plus the
 * schema-level telemetry defaults (temperatureC=65, oilPressureKpa=320, …).
 * The engine overwrites telemetry on the next tick.
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

    const parsed = createGeneratorSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { siteId, label, manufacturer, model, ratedPowerKw, fuelType } = parsed.data;

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
    const generator = await asTenant(me, (tx) =>
      tx.generator.create({
      data: {
        siteId,
        tenantId: site.tenantId,
        label,
        manufacturer,
        model,
        ratedPowerKw,
        fuelType,
        status: "STOPPED",
        mode: "AUTO",
        runtimeHours: 0,
        oilChangeIntervalHrs: 250,
        lastOilChangeHrs: 0,
        nextMaintenanceHrs: 250,
      },
      include: generatorInclude,
    }));

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "GENERATOR_CREATE",
      entity: "Generator",
      entityId: generator.id,
      details: { siteId, label, manufacturer, model, ratedPowerKw, fuelType },
    });

    const res = NextResponse.json(generator, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
