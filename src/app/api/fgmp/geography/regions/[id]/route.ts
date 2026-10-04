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

const updateRegionSchema = z.object({
  name: z.string().min(2).max(120).optional(),
});

/**
 * PATCH /api/fgmp/geography/regions/[id]
 * Update a region's name. ADMIN-only. Enforces unique (tenantId, name) on
 * change.
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
    const parsed = updateRegionSchema.safeParse(body);
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

    const existing = await db.region.findUnique({ where: { id }, select: { id: true, tenantId: true, name: true } });
    if (!existing) {
      const res = NextResponse.json({ error: "Region not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (data.name) {
      const clash = await db.region.findFirst({
        where: {
          AND: [{ id: { not: id } }, { tenantId: existing.tenantId }, { name: data.name }],
        },
        select: { id: true },
      });
      if (clash) {
        const res = NextResponse.json(
          { error: "Region name already exists in this tenant", field: "name" },
          { status: 409 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    const updated = await db.region.update({
      where: { id },
      data,
      include: {
        governorates: {
          orderBy: { name: "asc" },
          include: {
            districts: { orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } },
            _count: { select: { sites: true } },
          },
        },
        _count: { select: { sites: true, governorates: true } },
      },
    });

    await audit({
      userId: user.id,
      tenantId: existing.tenantId,
      action: "REGION_UPDATE",
      entity: "Region",
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
 * DELETE /api/fgmp/geography/regions/[id]
 * Hard-delete a region. ADMIN-only. Schema cascades to Governorate →
 * District → Site and (transitively) all assets/alarms/deliveries under
 * each site. This is intentional — the admin has confirmed via the dialog.
 *
 * Guardrail: refuses to delete a region that still has sites — admin must
 * reassign/retire those sites first. Regions with empty governorates/
 * districts can be safely removed.
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

    const existing = await db.region.findUnique({
      where: { id },
      select: { id: true, name: true, tenantId: true, _count: { select: { sites: true, governorates: true } } },
    });
    if (!existing) {
      const res = NextResponse.json({ error: "Region not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (existing._count.sites > 0) {
      const res = NextResponse.json(
        {
          error: "Cannot delete a region that still has sites. Reassign or remove them first.",
          counts: existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Region.governorates has onDelete: Cascade at the schema level — the
    // database will remove all child governorates + their districts in one
    // transaction.
    await db.region.delete({ where: { id } });

    await audit({
      userId: user.id,
      tenantId: existing.tenantId,
      action: "REGION_DELETE",
      entity: "Region",
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
