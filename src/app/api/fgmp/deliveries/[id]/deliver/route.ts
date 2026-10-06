import type { FuelDeliveryStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, ApiError } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { realtime } from "@/lib/fgmp/realtime-emitter";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/deliveries/[id]/deliver — explicit DELIVERED transition.
 *
 * Marks a fuel delivery as delivered by the supplier. Allowed transitions:
 *   SCHEDULED → DELIVERED
 *   IN_TRANSIT → DELIVERED
 *
 * Sets `deliveredAt = now()`, records `volumeDeliveredLitres`, and optionally
 * updates `driverName` / `vehiclePlate` if provided (the create-time values
 * are not overwritten when the body omits the field).
 *
 * Roles: ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER (ROLES.DELIVERY — already
 * includes ADMIN, so the spec's "DELIVERY + ADMIN" requirement is met).
 *
 * Rate-limited at MUTATION_LIMIT. Audited as DELIVERY_DELIVER. Emits a
 * `delivery:update` realtime event so subscribed browsers refresh.
 *
 * ── CONCURRENCY (TOCTOU) ───────────────────────────────────────────────────
 * The status guard was a `findUnique` check followed by an unconditional
 * `update`, so a concurrent `/cancel` landing between the two statements
 * would be overwritten and a CANCELLED delivery resurrected as DELIVERED.
 * The allowed source statuses are now the WHERE clause of a conditional
 * `updateMany`; `count === 0` → 409. The status write and its audit row are
 * committed in one `db.$transaction` so a delivery can never end up advanced
 * without the corresponding TICKET-equivalent audit entry.
 *
 * This endpoint is ADDITIVE — the existing POST /api/fgmp/deliveries
 * (action: "dispatch" | "verify" | "create") and the generic PUT on
 * /api/fgmp/deliveries/[id] are untouched.
 */
const deliverSchema = z.object({
  volumeDeliveredLitres: z.coerce
    .number()
    .positive("volumeDeliveredLitres must be > 0")
    .max(1_000_000, "volumeDeliveredLitres unrealistically large"),
  driverName: z.string().trim().max(200).optional(),
  vehiclePlate: z.string().trim().max(60).optional(),
});

/** Statuses a delivery may be marked DELIVERED from. */
const DELIVER_FROM: FuelDeliveryStatus[] = ["SCHEDULED", "IN_TRANSIT"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.DELIVERY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(
      req,
      user.id,
      MUTATION_LIMIT.limit,
      MUTATION_LIMIT.windowMs,
    );
    if (!rl.success) {
      const res = NextResponse.json(
        { error: "Too many requests" },
        { status: 429 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const r = validateBody(deliverSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Same fix as /cancel: `db.$transaction` below was a transaction WITHOUT a
    // tenant context, so this guard read returned null and the auditLog.create
    // inside it was rejected by WITH CHECK. The guard, the conditional write
    // and the audit insert now share ONE asTenant transaction.
    //
    // The nested `site: { tenantId }` select is itself RLS-protected, so the
    // relation filter is expressed in the query too.
    const existing = await asTenant(me, (tx) =>
      tx.fuelDelivery.findFirst({
        where: { id, site: { tenantId: me.tenantId } },
        select: { id: true, status: true, siteId: true, site: { select: { tenantId: true } } },
      }),
    );
    if (!existing) throw new ApiError(404, "delivery not found");
    const tenantDenied = assertSiteTenantOwned(existing.site, me);
    if (tenantDenied) return tenantDenied;
    if (!DELIVER_FROM.includes(existing.status)) {
      throw new ApiError(
        409,
        `Delivery cannot be marked delivered from status ${existing.status}`,
        { currentStatus: existing.status, allowedFrom: DELIVER_FROM },
      );
    }

    // Build the update payload — only set driverName / vehiclePlate if the
    // request supplied them, so the create-time values are preserved when
    // the operator only records the delivered volume.
    const update: Record<string, unknown> = {
      status: "DELIVERED",
      volumeDeliveredLitres: data.volumeDeliveredLitres,
      deliveredAt: new Date(),
    };
    if (data.driverName !== undefined) update.driverName = data.driverName;
    if (data.vehiclePlate !== undefined) update.vehiclePlate = data.vehiclePlate;

    // Conditional write — atomic check-and-set. `discrepancyNote` is NOT
    // touched here: it holds the cancellation reason written by
    // `/deliveries/[id]/cancel` and must survive this transition.
    const updated = await asTenant(me, async (tx) => {
      const { count } = await tx.fuelDelivery.updateMany({
        // tenant-scoped so a cross-tenant id matches zero rows rather than
        // throwing — converts an error into a refusal.
        where: { id, site: { tenantId: me.tenantId }, status: { in: DELIVER_FROM } },
        data: update,
      });
      if (count === 0) {
        throw new ApiError(
          409,
          "Delivery status changed concurrently — reload and retry",
          { allowedFrom: DELIVER_FROM },
        );
      }
      await tx.auditLog.create({
        data: {
          tenantId: existing.site.tenantId,
          userId: user.id,
          action: "DELIVERY_DELIVER",
          entity: "delivery",
          entityId: id,
          details: JSON.stringify({
            volumeDeliveredLitres: data.volumeDeliveredLitres,
            driverName: data.driverName ?? null,
            vehiclePlate: data.vehiclePlate ?? null,
            previousStatus: existing.status,
          }),
        },
      });
      return tx.fuelDelivery.findFirst({ where: { id, site: { tenantId: me.tenantId } } });
    });
    if (!updated) throw new ApiError(404, "delivery not found");

    try {
      realtime.deliveryUpdate({
        id: updated.id,
        siteId: updated.siteId,
        status: updated.status,
      });
    } catch {
      /* best-effort — polling fallback covers freshness */
    }

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
