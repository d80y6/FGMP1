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

const iotInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * POST /api/fgmp/assets/iot
 * Register a new IoT device. Defaults: status="ONLINE", signalRssi=-70.
 * `serialNo` is unique across the platform — a duplicate returns 409 via the
 * Prisma P2002 path in `errorResponse()`.
 *
 * ADMIN-only.
 */
export async function POST(req: NextRequest) {
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

    let body: unknown;
    try {
      body = await req.json();
    } catch {
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

    // Verify the site exists and belongs to the caller's tenant.
    const site = await db.site.findUnique({ where: { id: siteId }, select: { tenantId: true } });
    const siteDenied = assertSiteTenantOwned(site, me);
    if (siteDenied) {
      applyRateLimitHeaders(siteDenied.headers, rl);
      return siteDenied;
    }

    // Friendly 409 for duplicate serial number (instead of relying on the
    // Prisma P2002 path which says "Resource already exists" — too generic).
    const dupSerial = await db.iotDevice.findUnique({ where: { serialNo }, select: { id: true } });
    if (dupSerial) {
      const res = NextResponse.json(
        { error: "Serial number already in use", code: "IOT_SERIAL_DUPLICATE" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const device = await db.iotDevice.create({
      data: {
        siteId,
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
      include: iotInclude,
    });

    await audit({
      userId: me.id,
      tenantId: me.tenantId,
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
