import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, bootstrap } from "@/lib/fgmp";
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

const createTankSchema = z.object({
  siteId: z.string().min(1),
  label: z.string().min(1).max(80),
  fuelType: z.enum(FUEL_TYPES),
  capacityLitres: z.number().positive(),
  lowThreshold: z.number().min(0),
  criticalThreshold: z.number().min(0),
});

const tankInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * POST /api/fgmp/assets/tanks
 * Create a new fuel tank.
 *
 * Sensible defaults for telemetry fields (currentLitres = 70% of capacity,
 * status = OPERATIONAL, calibration = "[]"). The telemetry engine will
 * overwrite currentLitres/status on its next tick once it picks the new tank
 * up.
 *
 * ADMIN-only.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

    const parsed = createTankSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { siteId, label, fuelType, capacityLitres, lowThreshold, criticalThreshold } = parsed.data;

    // Verify the site exists and belongs to the caller's tenant (Prisma will
    // throw P2003 if the site doesn't exist, but assertSiteTenantOwned gives a
    // friendlier cross-tenant 404).
    const site = await db.site.findUnique({ where: { id: siteId }, select: { tenantId: true } });
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

    const tank = await db.fuelTank.create({
      data: {
        siteId,
        tenantId: site.tenantId,
        label,
        fuelType,
        capacityLitres,
        // Sensible defaults — engine overwrites these on the next tick.
        currentLitres: Math.round(capacityLitres * 0.7 * 100) / 100,
        lowThreshold,
        criticalThreshold,
        calibration: "[]",
        status: "OPERATIONAL",
      },
      include: tankInclude,
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "TANK_CREATE",
      entity: "FuelTank",
      entityId: tank.id,
      details: { siteId, label, fuelType, capacityLitres, lowThreshold, criticalThreshold },
    });

    const res = NextResponse.json(tank, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
