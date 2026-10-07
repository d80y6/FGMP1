import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const FUEL_TYPES = ["DIESEL", "PETROL", "BIOFUEL"] as const;
const TANK_STATUSES = ["OPERATIONAL", "EMPTY", "MAINTENANCE", "CALIBRATING"] as const;

const updateTankSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  fuelType: z.enum(FUEL_TYPES).optional(),
  capacityLitres: z.number().positive().optional(),
  currentLitres: z.number().min(0).optional(),
  lowThreshold: z.number().min(0).optional(),
  criticalThreshold: z.number().min(0).optional(),
  calibration: z.string().max(8000).optional(),
  status: z.enum(TANK_STATUSES).optional(),
});

const tankInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * PUT /api/fgmp/assets/tanks/[id]
 * Update editable fuel-tank fields. Telemetry fields (currentLitres, status)
 * can be set manually here but the engine will overwrite them on the next
 * tick — useful for commissioning a tank or marking it MAINTENANCE.
 *
 * ADMIN-only.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const parsed = updateTankSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.fuelTank.findFirst({
        where: { id },
      select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Tank not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const data: Record<string, unknown> = {};
    const fields: Array<keyof typeof parsed.data> = [
      "label", "fuelType", "capacityLitres", "currentLitres",
      "lowThreshold", "criticalThreshold", "calibration", "status",
    ];
    for (const f of fields) {
      if (parsed.data[f] !== undefined) data[f] = parsed.data[f];
    }

    // `update` takes a unique selector, so tenantId cannot be part of the
// where clause; the `existing` guard above already asserted ownership and
// the nested include of site is itself RLS-protected, so it belongs here.
    const updated = await asTenant(me, (tx) =>
      tx.fuelTank.update({
        where: { id },
      data,
      include: tankInclude,
      }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "TANK_UPDATE",
      entity: "FuelTank",
      entityId: id,
      details: data,
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/assets/tanks/[id]
 * Hard-delete a fuel tank. SensorReadings reference tanks by entityId (a
 * plain string, not an FK) and FuelDelivery has a non-cascading FK, so we
 * allow the delete and log a warning-level audit entry noting any orphans.
 *
 * ADMIN-only.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    const existing = await asTenant(me, (tx) =>
      tx.fuelTank.findFirst({
        where: { id },
      select: { id: true, label: true, siteId: true, _count: { select: { deliveries: true } }, site: { select: { tenantId: true } } },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Tank not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Block delete if the tank still has deliveries referencing it
    // (FuelDelivery.tankId is a non-cascading FK, so a hard delete would throw
    // P2003 — return a friendly 409 instead).
    if (existing._count.deliveries > 0) {
      const res = NextResponse.json(
        {
          error:
            "Cannot delete a tank that still has fuel deliveries. Reassign or remove the deliveries first.",
          code: "TANK_HAS_DELIVERIES",
          deliveryCount: existing._count.deliveries,
        },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) =>
      // deleteMany, not delete: `delete` THROWS when the row is absent, so a
      // cross-tenant id would 500 and distinguish itself from a missing one.
      tx.fuelTank.deleteMany({ where: { id } }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "TANK_DELETE",
      entity: "FuelTank",
      entityId: id,
      details: { label: existing.label, siteId: existing.siteId, warning: "orphan-sensor-readings-may-exist" },
      });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
