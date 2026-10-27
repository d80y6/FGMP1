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
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

const createRegionSchema = z.object({
  name: z.string().min(2).max(120),
  tenantId: z.string().optional(),
});

/**
 * POST /api/fgmp/geography/regions
 * Create a new region. ADMIN-only. Body: { name, tenantId? }.
 * A supplied tenantId must match the authenticated tenant; platform operators
 * cannot write customer geography through this ordinary tenant endpoint.
 * Enforces unique (tenantId, name).
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const parsed = createRegionSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const tenantId = tenantIdOrThrow(user.tenantId);
    if (parsed.data.tenantId && parsed.data.tenantId !== tenantId) {
      const res = NextResponse.json(
        { error: "You can only create regions in your own tenant", code: "CROSS_TENANT_FORBIDDEN" },
        { status: 403 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const name = parsed.data.name;

    // The tenant is pinned to the authenticated session; explicit request
    // values cannot open a cross-tenant database context.
    const { tenant, clash, region } = await asTenant(user, async (tx) => {
      // Verify the target tenant exists (defensive — admin's tenant always does).
      // Tenant itself carries no tenantId column, so it is outside RLS; the read
      // is scoped to the one id the caller is already authorised for.
      const t = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      });
      if (!t) return { tenant: null, clash: null, region: null };

      // Enforce unique (tenantId, name)
      const existing = await tx.region.findUnique({
        where: { tenantId_name: { tenantId, name } },
        select: { id: true },
      });
      if (existing) return { tenant: t, clash: existing, region: null };

      const created = await tx.region.create({
      data: { tenantId, name },
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
      return { tenant: t, clash: null, region: created };
      },
    );

    if (!tenant) {
      const res = NextResponse.json({ error: "Tenant not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (clash) {
      const res = NextResponse.json(
        { error: "Region name already exists in this tenant", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (!region) {
      const res = NextResponse.json({ error: "Region not created" }, { status: 500 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: user.id,
      tenantId,
      action: "REGION_CREATE",
      entity: "Region",
      entityId: region.id,
      details: { name, tenantId },
    });

    const res = NextResponse.json(region, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
