import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const BATT_STATUSES = ["OK", "LOW", "FAILING", "REPLACEMENT_DUE", "OFFLINE"] as const;

const updateBatterySchema = z.object({
  label: z.string().min(1).max(80).optional(),
  chemistry: z.string().min(1).max(60).optional(),
  capacityAh: z.number().positive().optional(),
  nominalVoltage: z.number().positive().optional(),
  status: z.enum(BATT_STATUSES).optional(),
});

const batteryInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * PUT /api/fgmp/assets/batteries/[id]
 * Update editable battery-bank fields. Live telemetry (voltage, currentA,
 * stateOfCharge, stateOfHealth, temperatureC, charging) is owned by the
 * engine and not editable here.
 *
 * ADMIN-only.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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
    const parsed = updateBatterySchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await db.batteryBank.findUnique({
      where: { id },
      select: { id: true, site: { select: { tenantId: true } } },
    });
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Battery bank not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const data: Record<string, unknown> = {};
    const fields: Array<keyof typeof parsed.data> = [
      "label", "chemistry", "capacityAh", "nominalVoltage", "status",
    ];
    for (const f of fields) {
      if (parsed.data[f] !== undefined) data[f] = parsed.data[f];
    }

    const updated = await db.batteryBank.update({
      where: { id },
      data,
      include: batteryInclude,
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "BATTERY_UPDATE",
      entity: "BatteryBank",
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
 * DELETE /api/fgmp/assets/batteries/[id]
 * Hard-delete a battery bank. No FK history references it (SensorReading uses
 * a plain entityId string), so the delete always succeeds; the audit log
 * records the deletion so admins can trace it later.
 *
 * ADMIN-only.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    const existing = await db.batteryBank.findUnique({
      where: { id },
      select: { id: true, label: true, siteId: true, site: { select: { tenantId: true } } },
    });
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Battery bank not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await db.batteryBank.delete({ where: { id } });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "BATTERY_DELETE",
      entity: "BatteryBank",
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
