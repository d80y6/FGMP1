import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { audit } from "@/lib/fgmp/audit";
import { requireAuth, requireRole, assertTenantOwned, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

// ── Yemen territorial bounds ────────────────────────────────────────────────
// Mirrors /api/fgmp/sites/route.ts. Used to validate manual lat/lng entries on
// site update. Generous bounds so legit in-country entries never trip the check.
const YEMEN_LAT_MIN = 12.0;
const YEMEN_LAT_MAX = 19.0;
const YEMEN_LNG_MIN = 42.0;
const YEMEN_LNG_MAX = 53.0;

const CRITICALITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const POWER_SOURCE_VALUES = ["GRID", "GENERATOR", "HYBRID"] as const;
const STATUS_VALUES = ["ONLINE", "DEGRADED", "OFFLINE", "MAINTENANCE"] as const;

const siteInclude = {
  region: true,
  governorate: true,
  district: true,
} as const;

const updateSiteSchema = z
  .object({
    code: z.string().min(3).max(40).optional(),
    name: z.string().min(2).max(200).optional(),
    regionId: z.string().cuid().optional(),
    governorateId: z.string().cuid().optional(),
    districtId: z.string().cuid().optional(),
    latitude: z.number().min(YEMEN_LAT_MIN).max(YEMEN_LAT_MAX).optional(),
    longitude: z.number().min(YEMEN_LNG_MIN).max(YEMEN_LNG_MAX).optional(),
    address: z.string().max(500).optional(),
    criticality: z.enum(CRITICALITY_VALUES).optional(),
    loadKw: z.number().min(0).optional(),
    powerSource: z.enum(POWER_SOURCE_VALUES).optional(),
    gridAvailable: z.boolean().optional(),
    status: z.enum(STATUS_VALUES).optional(),
  })
  .refine(
    (d) => {
      // If any of the hierarchy ids is supplied, ALL three must be supplied —
      // the hierarchy is only ever moved as a unit (region → gov → district).
      const ids = [d.regionId, d.governorateId, d.districtId].filter(Boolean).length;
      return ids === 0 || ids === 3;
    },
    { message: "regionId, governorateId and districtId must be supplied together", path: ["regionId"] },
  );

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;
    const site = engine.sites.find((s) => s.id === id);
    const denied = assertTenantOwned(site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    const tanks = engine.tanks.filter((t) => t.siteId === id);
    const generators = engine.generators.filter((g) => g.siteId === id);
    const batteries = engine.batteries.filter((b) => b.siteId === id);
    const iot = engine.iotDevices.filter((d) => d.siteId === id);
    const [alarms, deliveries, tickets] = await Promise.all([
      db.alarm.findMany({ where: { siteId: id }, orderBy: { createdAt: "desc" }, take: 50 }),
      db.fuelDelivery.findMany({ where: { siteId: id }, orderBy: { scheduledAt: "desc" }, take: 20 }),
      db.maintenanceTicket.findMany({ where: { siteId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
    ]);
    const res = NextResponse.json({ site, tanks, generators, batteries, iot, alarms, deliveries, tickets });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/sites/[id]
 * Update an existing site. ADMIN-only. Zod-validated, audited, rate-limited at
 * MUTATION_LIMIT. Supports partial updates — only the supplied fields are
 * written. If the geographic hierarchy is moved (region/gov/district), all
 * three ids must be supplied together and the hierarchy must be consistent
 * (governorate.regionId === regionId AND district.governorateId === governorateId).
 *
 * lat/lng are bounded to Yemen territory. code changes are uniqueness-checked
 * (excluding self). After the row is updated the engine is force-reloaded so
 * the next snapshot read reflects the change immediately.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const me = user;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      const res = NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const parsed = updateSiteSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = parsed.data;

    if (Object.keys(data).length === 0) {
      const res = NextResponse.json({ error: "No fields to update" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Fetch existing + tenant-own it.
    const existing = await db.site.findUnique({
      where: { id },
      include: siteInclude,
    });
    if (!existing) {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // Unique code check on change (exclude self).
    if (data.code && data.code !== existing.code) {
      const clash = await db.site.findUnique({ where: { code: data.code } });
      if (clash) {
        const res = NextResponse.json(
          { error: "Site code already exists", code: "CODE_EXISTS" },
          { status: 409 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    // Hierarchy consistency check — only when moving the whole trio.
    if (data.regionId && data.governorateId && data.districtId) {
      const [region, governorate, district] = await Promise.all([
        db.region.findUnique({ where: { id: data.regionId } }),
        db.governorate.findUnique({ where: { id: data.governorateId } }),
        db.district.findUnique({ where: { id: data.districtId } }),
      ]);
      if (!region || !governorate || !district) {
        const res = NextResponse.json(
          { error: "Region/Governorate/District hierarchy is invalid", code: "INVALID_HIERARCHY" },
          { status: 400 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
      if (governorate.regionId !== region.id || district.governorateId !== governorate.id) {
        const res = NextResponse.json(
          { error: "Region/Governorate/District hierarchy is invalid", code: "INVALID_HIERARCHY" },
          { status: 400 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
      // Tenant boundary: the destination region/gov/district must belong to
      // the caller's tenant (super-admin bypasses).
      const regionDenied = assertTenantOwned(region, me);
      if (regionDenied) {
        applyRateLimitHeaders(regionDenied.headers, rl);
        return regionDenied;
      }
    }

    const updated = await db.site.update({
      where: { id },
      data,
      include: siteInclude,
    });

    // Force the engine to pick up the change on the next snapshot read.
    await engine.reload();

    await audit({
      userId: me.id,
      tenantId: existing.tenantId,
      action: "SITE_UPDATE",
      entity: "site",
      entityId: id,
      details: {
        before: {
          code: existing.code,
          name: existing.name,
          criticality: existing.criticality,
          status: existing.status,
          loadKw: existing.loadKw,
        },
        changes: data as Record<string, unknown>,
      },
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/sites/[id]
 * Hard-delete a site. ADMIN-only. The schema cascades the delete to every
 * child row (FuelTank, Generator, BatteryBank, IotDevice, FuelDispenser,
 * FuelTransaction, FuelDelivery, MaintenanceTicket, SensorReading, SiteEvent,
 * Alarm, …) — all of them carry `onDelete: Cascade` on their siteId FK.
 *
 * This is intentionally destructive: the admin has confirmed via the dialog
 * (which surfaces the asset counts BEFORE the delete). The counts are also
 * recorded in the audit log for traceability.
 *
 * After the row is deleted the engine is force-reloaded so the site disappears
 * from the live snapshot immediately.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const me = user;
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    // Fetch existing + tenant-own it + count children for the audit trail.
    const existing = await db.site.findUnique({
      where: { id },
      include: siteInclude,
    });
    if (!existing) {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const denied = assertTenantOwned(existing, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // Count the child assets that will be cascade-deleted, for the audit log.
    // (The DB cascade handles the actual deletion; these counts are purely
    // informational and recorded so the audit trail shows the blast radius.)
    const [
      tanks, generators, batteries, iotDevices,
      alarms, deliveries, tickets, sensorReadings, siteEvents,
    ] = await Promise.all([
      db.fuelTank.count({ where: { siteId: id } }),
      db.generator.count({ where: { siteId: id } }),
      db.batteryBank.count({ where: { siteId: id } }),
      db.iotDevice.count({ where: { siteId: id } }),
      db.alarm.count({ where: { siteId: id } }),
      db.fuelDelivery.count({ where: { siteId: id } }),
      db.maintenanceTicket.count({ where: { siteId: id } }),
      db.sensorReading.count({ where: { siteId: id } }),
      db.siteEvent.count({ where: { siteId: id } }),
    ]);

    await db.site.delete({ where: { id } });

    // Force the engine to drop the site on the next snapshot read.
    await engine.reload();

    await audit({
      userId: me.id,
      tenantId: existing.tenantId,
      action: "SITE_DELETE",
      entity: "site",
      entityId: id,
      details: {
        code: existing.code,
        name: existing.name,
        region: existing.region?.name,
        governorate: existing.governorate?.name,
        district: existing.district?.name,
        cascadeDeleted: {
          tanks, generators, batteries, iotDevices,
          alarms, deliveries, tickets, sensorReadings, siteEvents,
        },
      },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
