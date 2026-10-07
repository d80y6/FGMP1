import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenantForAnotherTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

const createRegionSchema = z.object({
  name: z.string().min(2).max(120),
  tenantId: z.string().optional(),
});

/**
 * POST /api/fgmp/geography/regions
 * Create a new region. ADMIN-only. Body: { name, tenantId? }.
 * The tenantId defaults to the acting admin's tenant — passing an explicit
 * tenantId lets a platform admin provision regions under another tenant.
 * Enforces unique (tenantId, name).
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
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
    // Super-admins may pass any tenantId to provision a region under another
    // tenant. Tenant admins may NOT — they're restricted to their own tenant.
    // (If they try, return 403 to make the boundary explicit.)
    if (
      parsed.data.tenantId &&
      parsed.data.tenantId !== user.tenantId &&
      !isSuperAdminUser(user)
    ) {
      const res = NextResponse.json(
        { error: "You can only create regions in your own tenant", code: "CROSS_TENANT_FORBIDDEN" },
        { status: 403 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const tenantId = parsed.data.tenantId || user.tenantId;
    const name = parsed.data.name;

    // ── Tenant scoping ──────────────────────────────────────────────────────
    // Region is RLS-protected with FORCE, so these reads on the ambient `db`
    // returned zero rows and the create was rejected by WITH CHECK. All three
    // now run inside asTenant(tenantId, …) on the transaction client.
    //
    // `tenantId` was resolved above from the acting user's session (or an
    // explicitly-authorised superadmin), never from the body alone — a tenant
    // admin passing someone else's tenantId is rejected with 403 before here.
    // `tenantId` is `parsed.data.tenantId || user.tenantId`, so for a SUPERADMIN
    // it can name another tenant. That is why this uses the privileged helper
    // rather than asTenant(me, …): converting it to the caller's own tenant
    // would type-check and SILENTLY write into the super-admin's tenant instead
    // of the requested one — a passing build doing the wrong thing.
    //
    // For the common case (`parsed.data.tenantId` absent) this is the caller's
    // own tenant and the assertion below is satisfied by their own role.
    const { tenant, clash, region } = await asTenantForAnotherTenant(
      user,
      tenantId,
      async (tx) => {
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
