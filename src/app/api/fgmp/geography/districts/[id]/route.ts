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

    // ── Tenant scoping ────────────────────────────────────────────────────
    // District carries no tenantId — it inherits the owning tenant TWO levels up,
    // Governorate -> Region. Region is RLS-protected with FORCE, so the lookup
    // must run inside asTenant and filter through both parents; unscoped it
    // returns null and the assertTenantOwned defence never sees a row.
    const outcome = await asTenant(user.tenantId, async (tx) => {
      const existing = await tx.district.findFirst({
        where: {
          id,
          ...(isSuperAdminUser(auth.user)
            ? {}
            : { governorate: { region: { tenantId: user.tenantId } } }),
        },
        select: { id: true, governorateId: true, name: true, governorate: { select: { region: { select: { tenantId: true } } } } },
      });
      if (!existing) return { kind: "not-found" as const };

      if (data.name) {
        const clash = await tx.district.findFirst({
          where: {
            AND: [{ id: { not: id } }, { governorateId: existing.governorateId }, { name: data.name }],
          },
          select: { id: true },
        });
        if (clash) return { kind: "clash" as const };
      }

      const updated = await tx.district.update({
        where: { id },
        data,
        include: { _count: { select: { sites: true } } },
      });
      return { kind: "updated" as const, existing, updated };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "District not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "clash") {
      const res = NextResponse.json(
        { error: "District name already exists in this governorate", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing.governorate.region, auth.user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await audit({
      userId: user.id,
      tenantId: outcome.existing.governorate.region.tenantId,
      action: "DISTRICT_UPDATE",
      entity: "District",
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

    // Tenant isolation — see the PATCH handler above. The site guardrail and the
    // delete share one transaction so they cannot be raced apart.
    const outcome = await asTenant(user.tenantId, async (tx) => {
      const existing = await tx.district.findFirst({
        where: {
          id,
          ...(isSuperAdminUser(auth.user)
            ? {}
            : { governorate: { region: { tenantId: user.tenantId } } }),
        },
        select: { id: true, name: true, governorate: { select: { region: { select: { tenantId: true } } } }, _count: { select: { sites: true } } },
      });
      if (!existing) return { kind: "not-found" as const };
      if (existing._count.sites > 0) return { kind: "has-sites" as const, existing };

      await tx.district.delete({ where: { id } });
      return { kind: "deleted" as const, existing };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "District not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "has-sites") {
      const res = NextResponse.json(
        {
          error: "Cannot delete a district that still has sites. Reassign or remove them first.",
          counts: outcome.existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing.governorate.region, auth.user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await audit({
      userId: user.id,
      tenantId: outcome.existing.governorate.region.tenantId,
      action: "DISTRICT_DELETE",
      entity: "District",
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
