import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import { iotActionSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, siteTenantWhereOrAll, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

// IoT device types / protocols accepted at registration. Kept here (rather than
// in the shared schemas module) because only this route registers devices; the
// asset registry previously had a second copy under /api/fgmp/assets/iot.
const IOT_TYPES = [
  "FUEL_SENSOR",
  "GENERATOR_CONTROLLER",
  "BATTERY_SENSOR",
  "POWER_METER",
  "ENVIRONMENTAL",
] as const;
const IOT_PROTOCOLS = ["RS485", "MODBUS_RTU", "MODBUS_TCP", "MQTT", "HTTP", "SNMP"] as const;

const createIotSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().min(1).max(120),
  type: z.enum(IOT_TYPES),
  protocol: z.enum(IOT_PROTOCOLS),
  vendor: z.string().min(1).max(120),
  serialNo: z.string().min(1).max(120),
  firmware: z.string().min(1).max(60),
  ipAddress: z.string().max(60).optional().nullable(),
  modbusUnit: z.number().int().min(0).max(255).optional().nullable(),
});

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get("siteId");
    const where: Record<string, unknown> = { ...siteTenantWhereOrAll(user) };
    if (siteId) where.siteId = siteId;
    // NESTED READ: the `include: { site }` traversal is RLS-protected too, so
    // it sits inside the same context as the top-level query. Scoping only the
    // outer findMany would return devices with a null site.
    const devices = await asTenant(user, (tx) =>
      tx.iotDevice.findMany({
        where,
        orderBy: { name: "asc" },
        include: { site: { select: { name: true, code: true } } },
      }),
    );
    // merge live status from engine
    const live = engine.iotDevices;
    const merged = devices.map((d) => {
      const l = live.find((x) => x.id === d.id);
      return { ...d, liveStatus: l?.status ?? d.status, signalRssi: l?.signalRssi ?? d.signalRssi, lastSeenAt: l?.lastSeenAt ?? d.lastSeenAt?.getTime() };
    });
    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(iotActionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    if (data.action === "ota") {
      // Verify the device's site belongs to the caller's tenant before
      // mutating OTA state.
      // NESTED READ: `select: { site: { … } }` resolves on the same client and
      // Site is RLS-protected, so the relation filter belongs in the query.
      // assertSiteTenantOwned is KEPT as defence in depth.
      const updated = await asTenant(user, async (tx) => {
        const existing = await tx.iotDevice.findFirst({
          where: { id: data.deviceId, site: { tenantId: user.tenantId } },
          select: { site: { select: { tenantId: true } } },
        });
        const denied = assertSiteTenantOwned(existing?.site ?? null, user);
        if (denied) {
          applyRateLimitHeaders(denied.headers, rl);
          return denied;
        }
        return tx.iotDevice.update({
          where: { id: data.deviceId },
          data: { otaTargetFw: data.firmware, otaStatus: "IN_PROGRESS" },
        });
      });
      if (updated instanceof NextResponse) return updated;
      const live = engine.iotDevices.find((x) => x.id === data.deviceId);
      if (live) { live.otaStatus = "IN_PROGRESS"; live.otaTargetFw = data.firmware; }
      await audit({ userId: user.id, action: "OTA", entity: "iot", entityId: data.deviceId, details: { firmware: data.firmware } });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // reboot — verify tenant first.
    {
      // Same nested-relation treatment as the OTA branch above.
      const existing = await asTenant(user, (tx) =>
        tx.iotDevice.findFirst({
          where: { id: data.deviceId, site: { tenantId: user.tenantId } },
          select: { site: { select: { tenantId: true } } },
        }),
      );
      const denied = assertSiteTenantOwned(existing?.site ?? null, user);
      if (denied) {
        applyRateLimitHeaders(denied.headers, rl);
        return denied;
      }
    }
    const live = engine.iotDevices.find((x) => x.id === data.deviceId);
    if (live) { live.status = "OFFLINE"; live.lastSeenAt = Date.now(); }
    await audit({ userId: user.id, action: "REBOOT", entity: "iot", entityId: data.deviceId });
    const res = NextResponse.json({ ok: true });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/iot
 * Register a new IoT device. ADMIN-only.
 *
 * Consolidated from the retired `/api/fgmp/assets/iot` duplicate: that route
 * was the ONLY create path (the monitoring route only supported GET/PATCH), so
 * its behaviour is preserved verbatim here while the asset-registry subtree is
 * removed. Defaults: status="ONLINE", signalRssi=-70. `serialNo` is unique per
 * tenant — a duplicate returns 409 with a stable code.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap(auth.user);
    const me = auth.user;
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => null);
    if (body === null) {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const parsed = createIotSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { siteId, name, type, protocol, vendor, serialNo, firmware, ipAddress, modbusUnit } = parsed.data;

    const site = await asTenant(me, (tx) =>
      tx.site.findFirst({
        where: { id: siteId, tenantId: me.tenantId },
        select: { tenantId: true },
      }),
    );
    const siteDenied = assertSiteTenantOwned(site, me);
    if (siteDenied) {
      applyRateLimitHeaders(siteDenied.headers, rl);
      return siteDenied;
    }
    if (!site) {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant-scoped duplicate check: serialNo is unique per tenant, so an
    // unscoped lookup would miss other tenants' serials and would itself be
    // filtered to nothing under RLS.
    const dupSerial = await asTenant(me, (tx) =>
      tx.iotDevice.findFirst({ where: { serialNo, tenantId: me.tenantId }, select: { id: true } }),
    );
    if (dupSerial) {
      const res = NextResponse.json(
        { error: "Serial number already in use", code: "IOT_SERIAL_DUPLICATE" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const device = await asTenant(me, (tx) =>
      tx.iotDevice.create({
        data: {
          siteId,
          tenantId: site.tenantId,
          name,
          type,
          protocol,
          vendor,
          serialNo,
          firmware,
          ipAddress: ipAddress ?? null,
          modbusUnit: modbusUnit ?? null,
          status: "ONLINE",
          signalRssi: -70,
        },
        include: { site: { select: { name: true, code: true } } },
      }),
    );

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "IOT_CREATE",
      entity: "IotDevice",
      entityId: device.id,
      details: { siteId, name, type, protocol, vendor, serialNo, firmware },
    });

    const res = NextResponse.json(device, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
