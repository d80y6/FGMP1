import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, bootstrap } from "@/lib/fgmp";
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
 * POST /api/fgmp/deliveries/[id]/cancel — explicit CANCELLED transition.
 *
 * Cancels a fuel delivery from any non-terminal status. Allowed source
 * statuses: SCHEDULED, IN_TRANSIT, DELIVERED. Terminal statuses
 * (VERIFIED, CANCELLED) are rejected with 409.
 *
 * The supplied `reason` is stored in the existing `discrepancyNote` column
 * (the column is reused as the canonical "free-text annotation" field —
 * adding a separate `cancelReason` column would have required a schema
 * migration, which is out of scope for this additive task).
 *
 * Roles: ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER (ROLES.DELIVERY — already
 * includes ADMIN, so the spec's "DELIVERY + ADMIN" requirement is met).
 *
 * Rate-limited at MUTATION_LIMIT. Audited as DELIVERY_CANCEL. Emits a
 * `delivery:update` realtime event so subscribed browsers refresh.
 *
 * ── CONCURRENCY (TOCTOU) ───────────────────────────────────────────────────
 * The terminal-status guard was a `findUnique` check followed by an
 * unconditional `update`, so a concurrent `/verify` landing in between would
 * be overwritten and a VERIFIED delivery re-cancelled. The allowed source
 * statuses are now the WHERE clause of a conditional `updateMany`;
 * `count === 0` → 409. Status write + audit row are one transaction.
 *
 * This endpoint is ADDITIVE — the existing POST /api/fgmp/deliveries
 * (action: "dispatch" | "verify" | "create") and the generic PUT on
 * /api/fgmp/deliveries/[id] are untouched.
 */
const cancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "reason must be at least 3 characters")
    .max(500, "reason must be at most 500 characters"),
});

/** Statuses a delivery may be cancelled FROM. */
const CANCEL_FROM = ["SCHEDULED", "IN_TRANSIT", "DELIVERED"];

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
    const r = validateBody(cancelSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    const existing = await db.fuelDelivery.findUnique({
      where: { id },
      select: { id: true, status: true, siteId: true, site: { select: { tenantId: true } } },
    });
    if (!existing) throw new ApiError(404, "delivery not found");
    const tenantDenied = assertSiteTenantOwned(existing.site, me);
    if (tenantDenied) return tenantDenied;
    if (!CANCEL_FROM.includes(existing.status)) {
      throw new ApiError(
        409,
        `Delivery cannot be cancelled from terminal status ${existing.status}`,
        { currentStatus: existing.status, allowedFrom: CANCEL_FROM },
      );
    }

    // Conditional write — atomic check-and-set. This endpoint OWNS the
    // `discrepancyNote` column (it stores the cancellation reason here).
    const updated = await db.$transaction(async (tx) => {
      const { count } = await tx.fuelDelivery.updateMany({
        where: { id, status: { in: CANCEL_FROM } },
        data: {
          status: "CANCELLED",
          // reuse discrepancyNote as the free-text annotation column.
          discrepancyNote: data.reason,
        },
      });
      if (count === 0) {
        throw new ApiError(
          409,
          "Delivery status changed concurrently — reload and retry",
          { allowedFrom: CANCEL_FROM },
        );
      }
      await tx.auditLog.create({
        data: {
          tenantId: existing.site.tenantId,
          userId: user.id,
          action: "DELIVERY_CANCEL",
          entity: "delivery",
          entityId: id,
          details: JSON.stringify({
            reason: data.reason,
            previousStatus: existing.status,
          }),
        },
      });
      return tx.fuelDelivery.findUnique({ where: { id } });
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
