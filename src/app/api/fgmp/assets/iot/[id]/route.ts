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

const IOT_TYPES = [
  "FUEL_SENSOR",
  "GENERATOR_CONTROLLER",
  "BATTERY_SENSOR",
  "POWER_METER",
  "ENVIRONMENTAL",
] as const;
const IOT_PROTOCOLS = ["RS485", "MODBUS_RTU", "MODBUS_TCP", "MQTT", "HTTP", "SNMP"] as const;
const IOT_STATUSES = ["ONLINE", "OFFLINE", "DEGRADED", "PROVISIONING"] as const;
const OTA_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETE", "FAILED"] as const;

const updateIotSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  type: z.enum(IOT_TYPES).optional(),
  protocol: z.enum(IOT_PROTOCOLS).optional(),
  vendor: z.string().min(1).max(120).optional(),
  firmware: z.string().min(1).max(60).optional(),
  ipAddress: z.string().max(60).optional().nullable(),
  modbusUnit: z.number().int().min(0).max(255).optional().nullable(),
  status: z.enum(IOT_STATUSES).optional(),
  otaTargetFw: z.string().max(60).optional().nullable(),
  otaStatus: z.enum(OTA_STATUSES).optional().nullable(),
});

const iotInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * PUT /api/fgmp/assets/iot/[id]
 * Update editable IoT device fields. `serialNo` is intentionally NOT editable
 * here — it's the device's primary identity; reassigning it would break
 * SensorReading history. Use the OTA staging endpoint (/api/fgmp/iot) for
 * firmware deployments; this route only handles registry fields + manual
 * status overrides (e.g. marking a device OFFLINE after a hard fault).
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
    const parsed = updateIotSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await asTenant(me, (tx) =>
      tx.iotDevice.findFirst({
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
      const res = NextResponse.json({ error: "IoT device not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const data: Record<string, unknown> = {};
    const fields: Array<keyof typeof parsed.data> = [
      "name", "type", "protocol", "vendor", "firmware",
      "ipAddress", "modbusUnit", "status", "otaTargetFw", "otaStatus",
    ];
    for (const f of fields) {
      if (parsed.data[f] !== undefined) data[f] = parsed.data[f];
    }

    // `update` takes a unique selector, so tenantId cannot be part of the
// where clause; the `existing` guard above already asserted ownership and
// the nested include of site is itself RLS-protected, so it belongs here.
    const updated = await asTenant(me, (tx) =>
      tx.iotDevice.update({
        where: { id },
      data,
      include: iotInclude,
      }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "IOT_UPDATE",
      entity: "IotDevice",
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
 * DELETE /api/fgmp/assets/iot/[id]
 * Hard-delete an IoT device. SensorReadings reference devices by entityId
 * (plain string), so the delete always succeeds; we log a warning-level
 * audit entry noting any orphaned readings.
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

    const existing = await asTenant(me, (tx) =>
      tx.iotDevice.findFirst({
        where: { id },
      select: { id: true, name: true, siteId: true, serialNo: true, site: { select: { tenantId: true } } },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, me);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "IoT device not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) =>
      // deleteMany, not delete: `delete` THROWS when the row is absent, so a
      // cross-tenant id would 500 and distinguish itself from a missing one.
      tx.iotDevice.deleteMany({ where: { id } }),
    );

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
      action: "IOT_DELETE",
      entity: "IotDevice",
      entityId: id,
      details: { name: existing.name, serialNo: existing.serialNo, siteId: existing.siteId, warning: "orphan-sensor-readings-may-exist" },
      });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
