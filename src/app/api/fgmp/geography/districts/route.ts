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

const createDistrictSchema = z.object({
  governorateId: z.string().min(1),
  name: z.string().min(2).max(120),
});

/**
 * POST /api/fgmp/geography/districts
 * Create a new district under a governorate. ADMIN-only. Body:
 * { governorateId, name }. Enforces unique (governorateId, name).
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
    const parsed = createDistrictSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { governorateId, name } = parsed.data;

    const gov = await db.governorate.findUnique({
      where: { id: governorateId },
      select: { id: true, region: { select: { tenantId: true } } },
    });
    if (!gov) {
      const res = NextResponse.json({ error: "Governorate not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // Tenant isolation: a tenant admin may only create districts under
    // governorates whose region belongs to their own tenant. Super-admins
    // may cross tenants.
    if (gov.region.tenantId !== user.tenantId && !isSuperAdminUser(user)) {
      const res = NextResponse.json(
        { error: "Governorate not found in your tenant", code: "CROSS_TENANT_FORBIDDEN" },
        { status: 403 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const clash = await db.district.findUnique({
      where: { governorateId_name: { governorateId, name } },
      select: { id: true },
    });
    if (clash) {
      const res = NextResponse.json(
        { error: "District name already exists in this governorate", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const district = await db.district.create({
      data: { governorateId, name },
      include: { _count: { select: { sites: true } } },
    });

    await audit({
      userId: user.id,
      tenantId: gov.region.tenantId,
      action: "DISTRICT_CREATE",
      entity: "District",
      entityId: district.id,
      details: { governorateId, name },
    });

    const res = NextResponse.json(district, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
