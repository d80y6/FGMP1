import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireAuth, requireRole, ROLES, tenantWhere } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const createThresholdSchema = z.object({
  thresholdKey: z.string().min(1).max(64),
  value: z.coerce.number().finite(),
  unit: z.string().min(1).max(32),
  source: z
    .enum(["OEM_DATASHEET", "SITE_POLICY", "MAINTENANCE_SCHEDULE", "DERIVED", "INFERRED"])
    .default("INFERRED"),
  sourceRef: z.string().max(500).optional(),
  siteId: z.string().cuid().optional(),
});

/**
 * GET /api/fgmp/interlocks/thresholds
 * List the tenant's interlock threshold overrides.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get("siteId");
    const where: Prisma.InterlockThresholdWhereInput = { ...tenantWhere(me) };
    if (siteId) where.siteId = siteId;

    const thresholds = await asTenant(me, (tx) =>
      tx.interlockThreshold.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          site: { select: { id: true, code: true, name: true } },
          confirmedBy: { select: { id: true, email: true } },
        },
      }),
    );

    const res = NextResponse.json(thresholds);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/interlocks/thresholds
 * Create or update a threshold override. ADMIN required.
 * Uses upsert semantics on the unique constraint (tenantId, thresholdKey, siteId).
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const v = createThresholdSchema.safeParse(body);
    if (!v.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: v.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // If siteId provided, verify it belongs to tenant
    if (v.data.siteId) {
      const site = await asTenant(me, (tx) =>
        tx.site.findFirst({ where: { id: v.data.siteId, tenantId: me.tenantId } }),
      );
      if (!site) {
        const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    // Use find-first + create/update instead of upsert to avoid compound
    // unique input type issue (siteId in compound unique is typed as string,
    // not string | null, even though the DB field is nullable).
    const threshold = await asTenant(me, async (tx) => {
      const existing = await tx.interlockThreshold.findFirst({
        where: {
          tenantId: me.tenantId,
          thresholdKey: v.data.thresholdKey,
          siteId: v.data.siteId ?? null,
        },
      });
      if (existing) {
        return tx.interlockThreshold.update({
          where: { id: existing.id },
          data: {
            value: v.data.value,
            unit: v.data.unit as import("@/lib/fgmp/interlock-thresholds").ThresholdUnit,
            source: v.data.source,
            sourceRef: v.data.sourceRef === undefined ? null : v.data.sourceRef,
            updatedAt: new Date(),
          },
        });
      }
      return tx.interlockThreshold.create({
        data: {
          tenantId: me.tenantId,
          thresholdKey: v.data.thresholdKey,
          value: v.data.value,
          unit: v.data.unit as import("@/lib/fgmp/interlock-thresholds").ThresholdUnit,
          source: v.data.source,
          sourceRef: v.data.sourceRef === undefined ? null : v.data.sourceRef,
          siteId: v.data.siteId ?? null,
        },
      });
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "INTERLOCK_THRESHOLD_UPSERT",
      entity: "InterlockThreshold",
      entityId: threshold.id,
      details: {
        thresholdKey: v.data.thresholdKey,
        value: v.data.value,
        unit: v.data.unit,
        source: v.data.source,
        siteId: v.data.siteId,
      },
    });

    const res = NextResponse.json(threshold, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}