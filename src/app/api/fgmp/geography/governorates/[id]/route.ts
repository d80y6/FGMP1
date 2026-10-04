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

const updateGovernorateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
});

/**
 * PATCH /api/fgmp/geography/governorates/[id]
 * Update a governorate's name. ADMIN-only.
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
    const parsed = updateGovernorateSchema.safeParse(body);
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

    const existing = await db.governorate.findUnique({ where: { id }, select: { id: true, regionId: true, name: true, region: { select: { tenantId: true } } } });
    if (!existing) {
      const res = NextResponse.json({ error: "Governorate not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (data.name) {
      const clash = await db.governorate.findFirst({
        where: {
          AND: [{ id: { not: id } }, { regionId: existing.regionId }, { name: data.name }],
        },
        select: { id: true },
      });
      if (clash) {
        const res = NextResponse.json(
          { error: "Governorate name already exists in this region", field: "name" },
          { status: 409 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    const updated = await db.governorate.update({
      where: { id },
      data,
      include: {
        districts: { orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } },
        _count: { select: { sites: true } },
      },
    });

    await audit({
      userId: user.id,
      tenantId: existing.region.tenantId,
      action: "GOVERNORATE_UPDATE",
      entity: "Governorate",
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
 * DELETE /api/fgmp/geography/governorates/[id]
 * Hard-delete a governorate. ADMIN-only. Cascades to District → Site.
 * Refuses to delete if sites still exist under the governorate.
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

    const existing = await db.governorate.findUnique({
      where: { id },
      select: { id: true, name: true, region: { select: { tenantId: true } }, _count: { select: { sites: true, districts: true } } },
    });
    if (!existing) {
      const res = NextResponse.json({ error: "Governorate not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (existing._count.sites > 0) {
      const res = NextResponse.json(
        {
          error: "Cannot delete a governorate that still has sites. Reassign or remove them first.",
          counts: existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await db.governorate.delete({ where: { id } });

    await audit({
      userId: user.id,
      tenantId: existing.region.tenantId,
      action: "GOVERNORATE_DELETE",
      entity: "Governorate",
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
