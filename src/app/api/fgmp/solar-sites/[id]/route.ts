import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireAuth, requireRole, ROLES, assertTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const updateSolarSiteSchema = z.object({
  capacityKwp: z.coerce.number().positive().optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * GET /api/fgmp/solar-sites/[id]
 * Get a single solar site with its arrays.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const { id } = await ctx.params;
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const solarSite = await asTenant(me, (tx) =>
      tx.solarSite.findFirst({
        where: { id, tenantId: me.tenantId },
        include: {
          arrays: { orderBy: { installedAt: "asc" } },
          site: { select: { id: true, code: true, name: true } },
        },
      }),
    );

    const denied = assertTenantOwned(solarSite, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!solarSite) {
      const res = NextResponse.json({ error: "Solar site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const res = NextResponse.json(solarSite);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/solar-sites/[id]
 * Update a solar site. ADMIN required.
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const { id } = await ctx.params;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const v = updateSolarSiteSchema.safeParse(body);
    if (!v.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: v.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.solarSite.findFirst({ where: { id, tenantId: me.tenantId } }),
    );
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Solar site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const updated = await asTenant(me, (tx) =>
      tx.solarSite.update({
        where: { id },
        data: v.data,
        include: { arrays: { orderBy: { installedAt: "asc" } } },
      }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "SOLAR_SITE_UPDATE",
      entity: "SolarSite",
      entityId: id,
      details: v.data,
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/solar-sites/[id]
 * Delete a solar site and its arrays. ADMIN required.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const { id } = await ctx.params;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.solarSite.findFirst({ where: { id, tenantId: me.tenantId } }),
    );
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Solar site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) => tx.solarSite.delete({ where: { id } }));

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "SOLAR_SITE_DELETE",
      entity: "SolarSite",
      entityId: id,
      details: { siteId: existing.siteId },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}