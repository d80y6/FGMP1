import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import { createDispenserSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, siteTenantWhereOrAll, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/dispensers
 * Returns all dispensers (optionally filtered by ?siteId=), sorted by label
 * ASC. Includes the related Site (name, code) and merges live telemetry from
 * the engine (status, flowRateLpm, currentVolumeLitres, totalizerLitres,
 * lastCommAt, wifiRssi) so the registry table reflects the latest tick.
 *
 * Any authenticated session may list dispensers — ADMIN-only mutations are
 * enforced on POST/PATCH/DELETE.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
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
    const dispensers = await withTenant(user.tenantId, (tx) => tx.fuelDispenser.findMany({
      where,
      orderBy: { label: "asc" },
      include: { site: { select: { id: true, name: true, code: true } } },
    }));

    // Merge live telemetry from the engine
    const live = engine.dispensers;
    const merged = dispensers.map((d) => {
      const l = live.find((x) => x.id === d.id);
      return {
        ...d,
        liveStatus: l?.status ?? d.status,
        liveMode: l?.mode ?? d.mode,
        liveFlowRateLpm: l?.flowRateLpm ?? d.flowRateLpm,
        liveCurrentVolumeLitres: l?.currentVolumeLitres ?? d.currentVolumeLitres,
        liveTotalizerLitres: l?.totalizerLitres ?? d.totalizerLitres,
        liveWifiRssi: l?.wifiRssi ?? d.wifiRssi,
        liveLastCommAt: l?.lastCommAt ?? d.lastCommAt?.getTime(),
        liveLastTransactionAt: l?.lastTransactionAt ?? d.lastTransactionAt?.getTime(),
        liveCurrentTransactionId: l?.currentTransactionId ?? d.currentTransactionId ?? null,
        liveTempC: l?.tempC ?? d.tempC,
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
 * POST /api/fgmp/dispensers
 * Create a new dispenser. ADMIN-only. Validates with createDispenserSchema
 * (siteId, label, manufacturer, model, nozzleCount 1-4, fuelType, maxFlowLpm,
 * espDeviceId, espFirmware, rs485Baudrate, rs485Address 1-247, rs485Parity,
 * optional ipAddress). The new row is persisted to the DB AND pushed into
 * the engine's in-memory array.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(createDispenserSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Verify the site exists in the acting admin's tenant
    // (SUPERADMIN bypasses for cross-tenant asset creation).
    const site = await withTenant(user.tenantId, (tx) => tx.site.findUnique({
      where: { id: data.siteId },
      select: { id: true, tenantId: true, name: true },
    }));
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

    // Enforce unique espDeviceId
    const existingEsp = await withTenant(user.tenantId, (tx) => tx.fuelDispenser.findUnique({
      where: { espDeviceId: data.espDeviceId },
      select: { id: true },
    }));
    if (existingEsp) {
      const res = NextResponse.json(
        { error: "espDeviceId already in use" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const created = await engine.createDispenser({
      siteId: data.siteId,
      label: data.label,
      manufacturer: data.manufacturer,
      model: data.model,
      nozzleCount: data.nozzleCount,
      fuelType: data.fuelType,
      maxFlowLpm: data.maxFlowLpm,
      espDeviceId: data.espDeviceId,
      espFirmware: data.espFirmware,
      rs485Baudrate: data.rs485Baudrate,
      rs485Address: data.rs485Address,
      rs485Parity: data.rs485Parity,
      ipAddress: data.ipAddress || undefined,
    });

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "DISPENSER_CREATE",
      entity: "FuelDispenser",
      entityId: created.id,
      details: {
        siteId: data.siteId,
        label: data.label,
        espDeviceId: data.espDeviceId,
        fuelType: data.fuelType,
        nozzleCount: data.nozzleCount,
      },
    });

    const res = NextResponse.json(created, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
