import type { FuelDeliveryStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  deliveryActionSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, ApiError } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertSiteTenantOwned, siteTenantWhereOrAll } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * Delivery state machine (Task: fix invalid transitions).
 * ────────────────────────────────────────────────────────────────────────────
 *   SCHEDULED ──dispatch──▶ IN_TRANSIT ──deliver──▶ DELIVERED ──verify──▶ VERIFIED
 *       │                       │                        │
 *       └───────── cancel ──────┴──────── cancel ────────┘
 *
 *   Terminal: VERIFIED, CANCELLED.  SCHEDULED and IN_TRANSIT and DELIVERED
 *   may all be cancelled — that mirrors `/deliveries/[id]/cancel`, which
 *   rejects only the terminal pair. `/deliveries/[id]/deliver` additionally
 *   rejects CANCELLED and VERIFIED.
 *
 * The `verify` / `dispatch` branches of this route previously performed NO
 * status check at all: any ROLE.DELIVERY member could re-dispatch a VERIFIED
 * delivery back to IN_TRANSIT (wiping the verification by overwriting the
 * status), or verify a CANCELLED one. They now use the same allowed-source
 * sets and the same 409 shape as the `[id]/deliver` and `[id]/cancel`
 * endpoints, and `dispatch` is applied as a conditional `updateMany` so the
 * guard and the write are a single atomic statement.
 */
const VERIFY_FROM: FuelDeliveryStatus[] = ["SCHEDULED", "IN_TRANSIT", "DELIVERED"];
const DISPATCH_FROM: FuelDeliveryStatus[] = ["SCHEDULED"];

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const siteId = searchParams.get("siteId");
    const where: Record<string, unknown> = { ...siteTenantWhereOrAll(me) };
    if (status) where.status = { in: status.split(",") };
    if (siteId) where.siteId = siteId;
    const deliveries = await db.fuelDelivery.findMany({
      where,
      orderBy: { scheduledAt: "desc" },
      take: 200,
      include: { site: { select: { name: true, code: true } }, tank: { select: { label: true } } },
    });
    const res = NextResponse.json(deliveries);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.DELIVERY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(deliveryActionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    if (data.action === "verify") {
      const existing = await db.fuelDelivery.findUnique({
        where: { id: data.deliveryId },
        select: { id: true, status: true, siteId: true, site: { select: { tenantId: true } } },
      });
      if (!existing) throw new ApiError(404, "delivery not found");
      const denied = assertSiteTenantOwned(existing.site, me);
      if (denied) return denied;
      if (!VERIFY_FROM.includes(existing.status)) {
        throw new ApiError(
          409,
          `Delivery cannot be verified from status ${existing.status}`,
          { currentStatus: existing.status, allowedFrom: VERIFY_FROM },
        );
      }
      // NOTE: `discrepancyNote` is only written when the client actually sent
      // one. It was previously `data.discrepancyNote ?? null`, which SILENTLY
      // WIPED the cancellation reason that `/deliveries/[id]/cancel` stores in
      // this same column (that endpoint reuses it as the free-text annotation
      // field). Omitting the key leaves the stored value untouched.
      const verifyData: Record<string, unknown> = {
        status: "VERIFIED",
        volumeDeliveredLitres: data.volumeDelivered,
        verifiedAt: new Date(),
      };
      if (data.discrepancyNote !== undefined) {
        verifyData.discrepancyNote = data.discrepancyNote;
      }
      // Conditional write — atomic check-and-set, matching `dispatch` below.
      const { count } = await db.fuelDelivery.updateMany({
        where: { id: data.deliveryId, status: { in: VERIFY_FROM } },
        data: verifyData,
      });
      if (count === 0) {
        throw new ApiError(
          409,
          "Delivery status changed concurrently — reload and retry",
          { allowedFrom: VERIFY_FROM },
        );
      }
      const updated = await db.fuelDelivery.findUnique({ where: { id: data.deliveryId } });
      await audit({ userId: user.id, action: "DELIVERY_VERIFY", entity: "delivery", entityId: data.deliveryId, details: { volumeDelivered: data.volumeDelivered, previousStatus: existing.status } });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (data.action === "dispatch") {
      const existing = await db.fuelDelivery.findUnique({
        where: { id: data.deliveryId },
        select: { id: true, status: true, siteId: true, site: { select: { tenantId: true } } },
      });
      if (!existing) throw new ApiError(404, "delivery not found");
      const denied = assertSiteTenantOwned(existing.site, me);
      if (denied) return denied;
      if (!DISPATCH_FROM.includes(existing.status)) {
        throw new ApiError(
          409,
          `Delivery cannot be dispatched from status ${existing.status}`,
          { currentStatus: existing.status, allowedFrom: DISPATCH_FROM },
        );
      }
      // Conditional write — the source status is part of the WHERE clause so
      // the guard cannot interleave with a concurrent cancel/verify.
      const { count } = await db.fuelDelivery.updateMany({
        where: { id: data.deliveryId, status: { in: DISPATCH_FROM } },
        data: { status: "IN_TRANSIT", dispatchedAt: new Date() },
      });
      if (count === 0) {
        throw new ApiError(
          409,
          "Delivery status changed concurrently — reload and retry",
          { allowedFrom: DISPATCH_FROM },
        );
      }
      const updated = await db.fuelDelivery.findUnique({ where: { id: data.deliveryId } });
      await audit({ userId: user.id, action: "DELIVERY_DISPATCH", entity: "delivery", entityId: data.deliveryId, details: { previousStatus: existing.status } });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // create — verify the referenced site belongs to the caller's tenant
    const site = await db.site.findUnique({
      where: { id: data.siteId },
      select: { tenantId: true },
    });
    const siteDenied = assertSiteTenantOwned(site, me);
    if (siteDenied) return siteDenied;
    // `site` is null when it does not exist; assertSiteTenantOwned returns
    // null (allowed) for a same-tenant site, so the null case needs its own
    // check before `site.tenantId` is read.
    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }
    const created = await db.fuelDelivery.create({
      data: {
        siteId: data.siteId,
        tenantId: site.tenantId,
        tankId: data.tankId,
        supplier: data.supplier,
        volumeOrderedLitres: data.volumeOrderedLitres,
        scheduledAt: new Date(data.scheduledAt),
        driverName: data.driverName,
        vehiclePlate: data.vehiclePlate,
        doNumber: data.doNumber,
        unitPrice: data.unitPrice ?? 0,
        status: "SCHEDULED",
      },
    });
    await audit({ userId: user.id, action: "DELIVERY_CREATE", entity: "delivery", entityId: created.id, details: { siteId: data.siteId, tankId: data.tankId, volumeOrderedLitres: data.volumeOrderedLitres } });
    const res = NextResponse.json(created);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    // Re-throw explicit ApiError; for everything else the helper maps to 5xx/4xx.
    if (err instanceof ApiError) return errorResponse(err);
    return errorResponse(err);
  }
}
