import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

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
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

    // ── Tenant scoping ──────────────────────────────────────────────────────
    // Region is RLS-protected with FORCE, so an unscoped lookup returns zero rows
    // and every update would 404 — which is why the Phase 0 assertTenantOwned
    // check below was inert: it compares record.tenantId AFTER the read, and the
    // read never returned a row. The tenant is therefore resolved IN THE QUERY
    // with findFirst({ where: { id, tenantId } }), making a cross-tenant id
    // indistinguishable from a non-existent one.
    //
    // assertTenantOwned is KEPT as defence in depth; the where clause is what
    // makes it function.
    const outcome = await asTenant(user, async (tx) => {
      const existing = await tx.region.findFirst({
        where: { id, tenantId: tenantIdOrThrow(user.tenantId) },
        select: { id: true, tenantId: true, name: true },
      });
      if (!existing) return { kind: "not-found" as const };

      if (data.name) {
        const clash = await tx.region.findFirst({
          where: {
            AND: [{ id: { not: id } }, { tenantId: existing.tenantId }, { name: data.name }],
          },
          select: { id: true },
        });
        if (clash) return { kind: "clash" as const };
      }

      const updated = await tx.region.update({
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
      return { kind: "updated" as const, existing, updated };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "Region not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "clash") {
      const res = NextResponse.json(
        { error: "Region name already exists in this tenant", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth: the where clause above already enforced this. Kept so a
    // future change to the scoping cannot silently become a cross-tenant write.
    const denied = assertTenantOwned(outcome.existing, auth.user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await audit({
      userId: user.id,
      tenantId: outcome.existing.tenantId,
      action: "REGION_UPDATE",
      entity: "Region",
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
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    // Tenant isolation — see the PATCH handler above. Scoped in the query
    // because Region is FORCE-RLS protected, so an unscoped read returns null
    // and assertTenantOwned would never see a row. The guardrail below and the
    // cascade to governorates/districts make a wrong tenant here far worse than
    // a wrong read.
    const outcome = await asTenant(user, async (tx) => {
      const existing = await tx.region.findFirst({
        where: { id, tenantId: tenantIdOrThrow(user.tenantId) },
        select: { id: true, name: true, tenantId: true, _count: { select: { sites: true, governorates: true } } },
      });
      if (!existing) return { kind: "not-found" as const };

      if (existing._count.sites > 0) return { kind: "has-sites" as const, existing };

      // Region.governorates has onDelete: Cascade at the schema level — the
      // database removes all child governorates + their districts in this same
      // transaction, so the guardrail check and the delete cannot be raced apart.
      await tx.region.delete({ where: { id } });
      return { kind: "deleted" as const, existing };
    });

    if (outcome.kind === "not-found") {
      const res = NextResponse.json({ error: "Region not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (outcome.kind === "has-sites") {
      const res = NextResponse.json(
        {
          error: "Cannot delete a region that still has sites. Reassign or remove them first.",
          counts: outcome.existing._count,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Defence in depth — the where clause above already enforced ownership.
    const denied = assertTenantOwned(outcome.existing, auth.user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await audit({
      userId: user.id,
      tenantId: outcome.existing.tenantId,
      action: "REGION_DELETE",
      entity: "Region",
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
