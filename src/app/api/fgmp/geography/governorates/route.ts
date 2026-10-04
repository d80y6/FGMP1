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
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

    const region = await db.region.findUnique({ where: { id: regionId }, select: { id: true, tenantId: true } });
    if (!region) {
      const res = NextResponse.json({ error: "Region not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // Tenant isolation: a tenant admin may only create governorates under
    // regions in their own tenant. Super-admins may cross tenants.
    if (region.tenantId !== user.tenantId && !isSuperAdminUser(user)) {
      const res = NextResponse.json(
        { error: "Region not found in your tenant", code: "CROSS_TENANT_FORBIDDEN" },
        { status: 403 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const clash = await db.governorate.findUnique({
      where: { regionId_name: { regionId, name } },
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

    const governorate = await db.governorate.create({
      data: { regionId, name },
      include: {
        districts: { orderBy: { name: "asc" }, include: { _count: { select: { sites: true } } } },
        _count: { select: { sites: true } },
      },
    });

    await audit({
      userId: user.id,
      tenantId: region.tenantId,
      action: "GOVERNORATE_CREATE",
      entity: "Governorate",
      entityId: governorate.id,
      details: { regionId, name },
    });

    const res = NextResponse.json(governorate, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
