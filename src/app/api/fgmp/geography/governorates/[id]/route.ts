import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertTenantOwned, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";

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

    // ── Tenant scoping ────────────────────────────────────────────────────
    // Governorate has no tenantId column of its own; it inherits the owning
    // tenant through its parent Region. Region is RLS-protected with FORCE, so
    // the lookup MUST run inside asTenant and filter on the parent's tenant —
    // unscoped it returns null and the assertTenantOwned check below never sees
    // a row, which is why that defence was inert.
    const outcome = await asTenant(user, async (tx) => {
      const existing = await tx.governorate.findFirst({
        where: {
          id,
          ...(isSuperAdminUser(auth.user) ? {} : { region: { tenantId: user.tenantId } }),
        },
        select: { id: true, regionId: true, name: true, region: { select: { tenantId: true } } },
      });
      if (!existing) return { kind: "not-found" as const };

      if (data.name) {
        const clash = await tx.governorate.findFirst({
          where: {
            AND: [{ id: { not: id } }, { regionId: existing.regionId }, { name: data.name }],
          },
          select: { id: true },
        });
        if (clash) return { kind: "clash" as const };
      }

      const updated = await tx.governorate.update({
      where: { id },
      data,
        include: {
          districts: { orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } },
          _count: { select: { sites: true } },
        },
      });
      return { kind: "updated" as const, existing, updated };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "Governorate not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "clash") {
      const res = NextResponse.json(
        { error: "Governorate name already exists in this region", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing.region, auth.user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await audit({
      userId: user.id,
      tenantId: outcome.existing.region.tenantId,
      action: "GOVERNORATE_UPDATE",
      entity: "Governorate",
      entityId: id,
      details: data as Record<string, unknown>,
    });

    const res = NextResponse.json(outcome.updated);
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

    // Tenant isolation — see the PATCH handler above. The site guardrail and
    // the delete share one transaction so they cannot be raced apart.
    const outcome = await asTenant(user, async (tx) => {
      const existing = await tx.governorate.findFirst({
        where: {
          id,
          ...(isSuperAdminUser(auth.user) ? {} : { region: { tenantId: user.tenantId } }),
        },
        select: { id: true, name: true, region: { select: { tenantId: true } }, _count: { select: { sites: true, districts: true } } },
      });
      if (!existing) return { kind: "not-found" as const };
      if (existing._count.sites > 0) return { kind: "has-sites" as const, existing };

      await tx.governorate.delete({ where: { id } });
      return { kind: "deleted" as const, existing };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "Governorate not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "has-sites") {
      const res = NextResponse.json(
        {
          error: "Cannot delete a governorate that still has sites. Reassign or remove them first.",
          counts: outcome.existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing.region, auth.user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await audit({
      userId: user.id,
      tenantId: outcome.existing.region.tenantId,
      action: "GOVERNORATE_DELETE",
      entity: "Governorate",
      entityId: id,
      details: { name: outcome.existing.name },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
