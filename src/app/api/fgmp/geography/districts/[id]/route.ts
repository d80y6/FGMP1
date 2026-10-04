import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

const updateDistrictSchema = z.object({
  name: z.string().min(2).max(120).optional(),
});

/**
 * PATCH /api/fgmp/geography/districts/[id]
 * Update a district's name. ADMIN-only.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const parsed = updateDistrictSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = parsed.data;
    if (Object.keys(data).length === 0) {
      const res = NextResponse.json({ error: "No fields to update" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await db.district.findUnique({
      where: { id },
      select: { id: true, governorateId: true, name: true, governorate: { select: { region: { select: { tenantId: true } } } } },
    });
    if (!existing) {
      const res = NextResponse.json({ error: "District not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (data.name) {
      const clash = await db.district.findFirst({
        where: {
          AND: [{ id: { not: id } }, { governorateId: existing.governorateId }, { name: data.name }],
        },
        select: { id: true },
      });
      if (clash) {
        const res = NextResponse.json(
          { error: "District name already exists in this governorate", field: "name" },
          { status: 409 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    const updated = await db.district.update({
      where: { id },
      data,
      include: { _count: { select: { sites: true } } },
    });

    await audit({
      userId: user.id,
      tenantId: existing.governorate.region.tenantId,
      action: "DISTRICT_UPDATE",
      entity: "District",
      entityId: id,
      details: data as Record<string, unknown>,
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/geography/districts/[id]
 * Hard-delete a district. ADMIN-only. Cascades to Site and (transitively)
 * all assets under each site. Refuses to delete if sites still exist.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    const existing = await db.district.findUnique({
      where: { id },
      select: { id: true, name: true, governorate: { select: { region: { select: { tenantId: true } } } }, _count: { select: { sites: true } } },
    });
    if (!existing) {
      const res = NextResponse.json({ error: "District not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (existing._count.sites > 0) {
      const res = NextResponse.json(
        {
          error: "Cannot delete a district that still has sites. Reassign or remove them first.",
          counts: existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await db.district.delete({ where: { id } });

    await audit({
      userId: user.id,
      tenantId: existing.governorate.region.tenantId,
      action: "DISTRICT_DELETE",
      entity: "District",
      entityId: id,
      details: { name: existing.name },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
