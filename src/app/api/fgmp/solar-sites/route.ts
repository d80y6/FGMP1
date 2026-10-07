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

const createSolarSiteSchema = z.object({
  siteId: z.string().cuid(),
  capacityKwp: z.coerce.number().positive(),
  notes: z.string().max(2000).optional(),
});

/**
 * GET /api/fgmp/solar-sites
 * List the tenant's solar sites with their arrays.
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

    const solarSites = await asTenant(me, async (tx) => {
      const rows = await tx.solarSite.findMany({
        where: tenantWhere(me),
        orderBy: { installedAt: "desc" },
        include: {
          arrays: {
            orderBy: { installedAt: "asc" },
          },
        },
      });
      return rows;
    });

    const res = NextResponse.json(solarSites);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/solar-sites
 * Create a solar site for a site the tenant owns.
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
    const v = createSolarSiteSchema.safeParse(body);
    if (!v.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: v.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Verify site belongs to tenant
    const site = await asTenant(me, (tx) =>
      tx.site.findFirst({ where: { id: v.data.siteId, tenantId: me.tenantId } }),
    );
    if (!site) {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Check if solar site already exists for this site
    const existing = await asTenant(me, (tx) =>
      tx.solarSite.findUnique({ where: { siteId: v.data.siteId } }),
    );
    if (existing) {
      const res = NextResponse.json(
        { error: "Solar site already exists for this site" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const solarSite = await asTenant(me, (tx) =>
      tx.solarSite.create({
        data: {
          tenantId: me.tenantId,
          siteId: v.data.siteId,
          capacityKwp: v.data.capacityKwp,
          notes: v.data.notes,
        },
        include: { arrays: true },
      }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "SOLAR_SITE_CREATE",
      entity: "SolarSite",
      entityId: solarSite.id,
      details: { siteId: v.data.siteId, capacityKwp: v.data.capacityKwp },
    });

    const res = NextResponse.json(solarSite, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}