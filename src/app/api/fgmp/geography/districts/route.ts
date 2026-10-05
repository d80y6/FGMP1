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

    // ── Tenant scoping ──────────────────────────────────────────────────────
    // District has NO tenantId column and no RLS policy; tenancy reaches it two
    // hops out, through Governorate -> Region. Region IS RLS-protected, so the
    // governorate lookup must run inside asTenant — unscoped it returns zero
    // rows and every create fails with a misleading 404.
    //
    // A governorate in another tenant is simply not found for a tenant admin:
    // the region filter carries their tenantId, so absent and foreign are
    // indistinguishable. Superadmins match on id alone and use the tenant the
    // region actually belongs to.
    const result = await asTenant(user.tenantId, async (tx) => {
      const gov = await tx.governorate.findFirst({
        where: {
          id: governorateId,
          // Two hops: filter through the parent region, which is the table that
          // actually carries tenantId.
          ...(isSuperAdminUser(user)
            ? {}
            : { region: { tenantId: user.tenantId } }),
        },
        select: { id: true, region: { select: { tenantId: true } } },
      });
      if (!gov) return { kind: "not-found" as const };

      const clash = await tx.district.findUnique({
        where: { governorateId_name: { governorateId, name } },
        select: { id: true },
      });
      if (clash) return { kind: "clash" as const };

      const district = await tx.district.create({
        data: { governorateId, name },
        include: { _count: { select: { sites: true } } },
      });
      return { kind: "created" as const, tenantId: gov.region.tenantId, district };
    });

    if (result.kind === "not-found") {
      const res = NextResponse.json({ error: "Governorate not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (result.kind === "clash") {
      const res = NextResponse.json(
        { error: "District name already exists in this governorate", field: "name" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await audit({
      userId: user.id,
      tenantId: result.tenantId,
      action: "DISTRICT_CREATE",
      entity: "District",
      entityId: result.district.id,
      details: { governorateId, name },
    });

    const res = NextResponse.json(result.district, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
