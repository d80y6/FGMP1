import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
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

const updateSolarArraySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  ratedKwp: z.coerce.number().positive().optional(),
  orientation: z.string().max(10).optional(),
  tiltDegrees: z.coerce.number().int().min(0).max(90).optional(),
  azimuthDegrees: z.coerce.number().int().min(0).max(359).optional(),
  inverterSerial: z.string().max(120).optional(),
  inverterModel: z.string().max(120).optional(),
});

/**
 * GET /api/fgmp/solar-arrays/[id]
 * Get a single solar array.
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
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const array = await asTenant(me, (tx) =>
      tx.solarArray.findFirst({
        where: { id, tenantId: me.tenantId },
        include: {
          solarSite: { select: { id: true, siteId: true, capacityKwp: true } },
        },
      }),
    );

    const denied = assertTenantOwned(array, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!array) {
      const res = NextResponse.json({ error: "Solar array not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const res = NextResponse.json(array);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/solar-arrays/[id]
 * Update a solar array. ADMIN required.
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
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const v = updateSolarArraySchema.safeParse(body);
    if (!v.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: v.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.solarArray.findFirst({ where: { id, tenantId: me.tenantId } }),
    );
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Solar array not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const updated = await asTenant(me, (tx) =>
      tx.solarArray.update({
        where: { id },
        data: v.data,
        include: { solarSite: { select: { id: true, siteId: true } } },
      }),
    );

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "SOLAR_ARRAY_UPDATE",
      entity: "SolarArray",
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
 * DELETE /api/fgmp/solar-arrays/[id]
 * Delete a solar array. ADMIN required.
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
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.solarArray.findFirst({ where: { id, tenantId: me.tenantId } }),
    );
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Solar array not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) => tx.solarArray.delete({ where: { id } }));

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "SOLAR_ARRAY_DELETE",
      entity: "SolarArray",
      entityId: id,
      details: { label: existing.label },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}