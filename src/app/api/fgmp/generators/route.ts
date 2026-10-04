import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, siteTenantWhereOrAll, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

// Inline Zod schemas.
const createGeneratorSchema = z.object({
  siteId: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(120),
  manufacturer: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(120),
  ratedPowerKw: z.coerce.number().positive().max(20_000),
  fuelType: z.enum(["DIESEL", "PETROL"]).default("DIESEL"),
  oilChangeIntervalHrs: z.coerce.number().min(1).max(10_000).optional(),
});

/**
 * GET /api/fgmp/generators
 * Returns all generators (optionally filtered by ?siteId=), sorted by label
 * ASC. Includes the related Site (name, code) and merges live telemetry from
 * the engine (status, mode, loadKw, temperatureC, runtimeHours, fuelRateLph,
 * lastReadingAt) so the registry table reflects the latest tick.
 *
 * Any authenticated session may list generators — ADMIN-only mutations are
 * enforced on POST/PATCH/DELETE.
 */
export async function GET(req: NextRequest) {
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
    const { searchParams } = new URL(req.url);
    const siteId = searchParams.get("siteId");
    const where: Record<string, unknown> = { ...siteTenantWhereOrAll(user) };
    if (siteId) where.siteId = siteId;
    const generators = await db.generator.findMany({
      where,
      orderBy: { label: "asc" },
      include: { site: { select: { id: true, name: true, code: true } } },
    });

    // Merge live telemetry from the engine.
    const live = engine.generators;
    const merged = generators.map((g) => {
      const l = live.find((x) => x.id === g.id);
      return {
        ...g,
        liveStatus: l?.status ?? g.status,
        liveMode: l?.mode ?? g.mode,
        liveLoadKw: l?.loadKw ?? g.loadKw,
        liveTemperatureC: l?.temperatureC ?? g.temperatureC,
        liveRuntimeHours: l?.runtimeHours ?? g.runtimeHours,
        liveFuelRateLph: l?.fuelRateLph ?? g.fuelRateLph,
        liveOilPressureKpa: l?.oilPressureKpa ?? g.oilPressureKpa,
        liveBatteryVoltage: l?.batteryVoltage ?? g.batteryVoltage,
        liveLastReadingAt: l?.lastReadingAt ?? g.lastReadingAt?.getTime(),
      };
    });

    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/generators
 * Create a new generator. ADMIN-only. Validates with createGeneratorSchema.
 * The new row is persisted to the DB AND pushed into the engine's in-memory
 * array so the next snapshot reflects it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = createGeneratorSchema.safeParse(body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Verify the site exists in the acting admin's tenant
    // (SUPERADMIN bypasses for cross-tenant asset creation).
    const site = await db.site.findUnique({
      where: { id: data.siteId },
      select: { id: true, tenantId: true, name: true },
    });
    const siteDenied = assertTenantOwned(site, user);
    if (siteDenied) {
      applyRateLimitHeaders(siteDenied.headers, rl);
      return siteDenied;
    }
    if (!site) {
      const res = NextResponse.json(
        { error: "Site not found in your tenant" },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const oilInterval = data.oilChangeIntervalHrs ?? 250;
    const row = await db.generator.create({
      data: {
        siteId: data.siteId,
        tenantId: site.tenantId,
        label: data.label,
        manufacturer: data.manufacturer,
        model: data.model,
        ratedPowerKw: data.ratedPowerKw,
        fuelType: data.fuelType,
        oilChangeIntervalHrs: oilInterval,
        nextMaintenanceHrs: oilInterval,
        status: "STOPPED",
        mode: "AUTO",
      },
      include: { site: { select: { id: true, name: true, code: true } } },
    });

    // Push into the engine so the next snapshot reflects the new generator.
    engine.generators.push({
      id: row.id,
      siteId: row.siteId,
      label: row.label,
      manufacturer: row.manufacturer,
      model: row.model,
      ratedPowerKw: row.ratedPowerKw,
      status: row.status as "RUNNING" | "STOPPED" | "FAULT" | "MAINTENANCE" | "OFFLINE",
      mode: row.mode as "AUTO" | "MANUAL" | "REMOTE",
      runtimeHours: row.runtimeHours,
      temperatureC: row.temperatureC,
      oilPressureKpa: row.oilPressureKpa,
      loadKw: row.loadKw,
      fuelRateLph: row.fuelRateLph,
      batteryVoltage: row.batteryVoltage,
      oilChangeIntervalHrs: row.oilChangeIntervalHrs,
      lastOilChangeHrs: row.lastOilChangeHrs,
      nextMaintenanceHrs: row.nextMaintenanceHrs,
      lastStartedAt: row.lastStartedAt?.getTime(),
      lastStoppedAt: row.lastStoppedAt?.getTime(),
      lastReadingAt: row.lastReadingAt?.getTime() ?? Date.now(),
      history: [],
    });

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "GENERATOR_CREATE",
      entity: "Generator",
      entityId: row.id,
      details: {
        siteId: data.siteId,
        label: data.label,
        manufacturer: data.manufacturer,
        model: data.model,
        ratedPowerKw: data.ratedPowerKw,
      },
    });

    const res = NextResponse.json(row, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
