import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireAuth, requireRole, ROLES, tenantWhere } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const createSolarArraySchema = z.object({
  solarSiteId: z.string().cuid(),
  label: z.string().trim().min(1).max(120),
  ratedKwp: z.coerce.number().positive(),
  orientation: z.string().max(10).optional(),
  tiltDegrees: z.coerce.number().int().min(0).max(90).optional(),
  azimuthDegrees: z.coerce.number().int().min(0).max(359).optional(),
  inverterSerial: z.string().max(120).optional(),
  inverterModel: z.string().max(120).optional(),
});

/**
 * GET /api/fgmp/solar-arrays
 * List the tenant's solar arrays, optionally filtered by solarSiteId.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { searchParams } = new URL(req.url);
    const solarSiteId = searchParams.get("solarSiteId");
    const where: Record<string, unknown> = { ...tenantWhere(me) };
    if (solarSiteId) where.solarSiteId = solarSiteId;

    const arrays = await asTenant(me, (tx) =>
      tx.solarArray.findMany({
        where,
        orderBy: { installedAt: "desc" },
        include: { solarSite: { select: { id: true, siteId: true, capacityKwp: true } } },
      }),
    );

    const res = NextResponse.json(arrays);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/solar-arrays
 * Create a solar array under a solar site the tenant owns.
 * ADMIN role required.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
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
    const v = createSolarArraySchema.safeParse(body);
    if (!v.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: v.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Verify solarSite belongs to tenant
    const solarSite = await asTenant(me, (tx) =>
      tx.solarSite.findFirst({ where: { id: v.data.solarSiteId, tenantId: me.tenantId } }),
    );
    if (!solarSite) {
      const res = NextResponse.json({ error: "Solar site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const array = await asTenant(me, (tx) =>
      tx.solarArray.create({
        data: {
          tenantId: me.tenantId,
          solarSiteId: v.data.solarSiteId,
          label: v.data.label,
          ratedKwp: v.data.ratedKwp,
          orientation: v.data.orientation,
          tiltDegrees: v.data.tiltDegrees,
          azimuthDegrees: v.data.azimuthDegrees,
          inverterSerial: v.data.inverterSerial,
          inverterModel: v.data.inverterModel,
        },
        include: { solarSite: { select: { id: true, siteId: true } } },
      }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "SOLAR_ARRAY_CREATE",
      entity: "SolarArray",
      entityId: array.id,
      details: { solarSiteId: v.data.solarSiteId, label: v.data.label, ratedKwp: v.data.ratedKwp },
    });

    const res = NextResponse.json(array, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}