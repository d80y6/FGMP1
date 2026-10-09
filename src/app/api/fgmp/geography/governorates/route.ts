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
import { requireRole, ROLES, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

const createGovernorateSchema = z.object({
  regionId: z.string().min(1),
  name: z.string().min(2).max(120),
});

/**
 * POST /api/fgmp/geography/governorates
 * Create a new governorate under a region. ADMIN-only. Body: { regionId,
 * name }. Enforces unique (regionId, name).
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
    const parsed = createGovernorateSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { regionId, name } = parsed.data;

    // ── Tenant scoping ──────────────────────────────────────────────────────
    // Governorate has NO tenantId column and carries no RLS policy; it reaches
    // tenancy through Region.regionId. So isolation has to be established on the
    // REGION lookup, which is RLS-protected and must therefore run inside
    // asTenant — an unscoped `db.region.findUnique` returns zero rows under FORCE
    // RLS and every create would fail with a misleading 404.
    //
    // The scoping tenant is always the AUTHENTICATED user's tenant. A superadmin
    // still has one (tenantIdOrThrow(user.tenantId)) and branches its `where` clause to search
    // all tenants; it never takes a tenant from the request body.
    const result = await asTenant(user, async (tx) => {
      // A region in another tenant is simply not found for a tenant admin: the
      // where clause includes their tenantId, so the two cases are
      // indistinguishable and both 404. Superadmins match on id alone.
      const region = await tx.region.findFirst({
        where: isSuperAdminUser(user) ? { id: regionId } : { id: regionId, tenantId: user.tenantId },
        select: { id: true, tenantId: true },
      });
      if (!region) return { kind: "not-found" as const };

      // Unique (regionId, name). Governorate is not RLS-protected, so the
      // scope comes from the parent region that was just resolved above.
      const clash = await tx.governorate.findUnique({
        where: { regionId_name: { regionId, name } },
        select: { id: true },
      });
      if (clash) return { kind: "clash" as const };

      const governorate = await tx.governorate.create({
        data: { regionId, name },
        include: {
          districts: { orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } },
          _count: { select: { sites: true } },
        },
      });
      return { kind: "created" as const, tenantId: region.tenantId, governorate };
    });

    if (result.kind === "not-found") {
      // Identical response whether the region is absent or belongs to another
      // tenant — a distinguishable error would turn this into an id oracle.
      const res = NextResponse.json({ error: "Region not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (result.kind === "clash") {
      const res = NextResponse.json(
        { error: "Governorate name already exists in this region", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: user.id,
      tenantId: result.tenantId,
      action: "GOVERNORATE_CREATE",
      entity: "Governorate",
      entityId: result.governorate.id,
      details: { regionId, name },
    });

    const res = NextResponse.json(result.governorate, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}