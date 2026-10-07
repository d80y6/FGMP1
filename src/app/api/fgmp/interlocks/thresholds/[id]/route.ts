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

const updateThresholdSchema = z.object({
  value: z.coerce.number().finite().optional(),
  unit: z.string().min(1).max(32).optional(),
  source: z
    .enum(["OEM_DATASHEET", "SITE_POLICY", "MAINTENANCE_SCHEDULE", "DERIVED", "INFERRED"])
    .optional(),
  sourceRef: z.string().max(500).optional().nullable(),
  confirmedById: z.string().cuid().optional().nullable(),
  siteId: z.string().cuid().optional().nullable(),
});

/**
 * GET /api/fgmp/interlocks/thresholds/[id]
 * Get a single threshold override.
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

    const threshold = await asTenant(me, (tx) =>
      tx.interlockThreshold.findFirst({
        where: { id, tenantId: me.tenantId },
        include: {
          site: { select: { id: true, code: true, name: true } },
          confirmedBy: { select: { id: true, email: true } },
        },
      }),
    )

    const denied = assertTenantOwned(threshold, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!threshold) {
      const res = NextResponse.json({ error: "Threshold not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const res = NextResponse.json(threshold);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/interlocks/thresholds/[id]
 * Update a threshold override. ADMIN required.
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
    const v = updateThresholdSchema.safeParse(body);
    if (!v.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: v.error.flatten() },
        { status: 400 },
      )
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.interlockThreshold.findFirst({ where: { id, tenantId: me.tenantId } }),
    )
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Threshold not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // If siteId is being changed, verify it belongs to tenant
    const newSiteId = v.data.siteId === null ? undefined : v.data.siteId;
    if (newSiteId !== undefined && newSiteId !== existing.siteId) {
      if (v.data.siteId) {
        const site = await asTenant(me, (tx) =>
          tx.site.findFirst({ where: { id: newSiteId!, tenantId: me.tenantId } }),
        )
        if (!site) {
          const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
          applyRateLimitHeaders(res.headers, rl);
          return res;
        }
      }
    }

    const updated = await asTenant(me, (tx) =>
      tx.interlockThreshold.update({
        where: { id },
        data: {
          value: v.data.value,
          unit: v.data.unit as import("@/lib/fgmp/interlock-thresholds").ThresholdUnit,
          source: v.data.source,
          sourceRef: v.data.sourceRef ?? null,
          confirmedById: v.data.confirmedById ?? undefined,
          siteId: v.data.siteId ?? undefined,
        },
        include: {
          site: { select: { id: true, code: true, name: true } },
          confirmedBy: { select: { id: true, email: true } },
        },
      }),
    )

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "INTERLOCK_THRESHOLD_UPDATE",
      entity: "InterlockThreshold",
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
 * DELETE /api/fgmp/interlocks/thresholds/[id]
 * Delete a threshold override. ADMIN required.
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
      tx.interlockThreshold.findFirst({ where: { id, tenantId: me.tenantId } }),
    )
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Threshold not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) => tx.interlockThreshold.delete({ where: { id } }));

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "INTERLOCK_THRESHOLD_DELETE",
      entity: "InterlockThreshold",
      entityId: id,
      details: { thresholdKey: existing.thresholdKey },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}