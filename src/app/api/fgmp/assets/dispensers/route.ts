import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import { createDispenserSchema } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { decimalsToJson } from "@/lib/fgmp/decimal";

export const dynamic = "force-dynamic";

const dispenserInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * POST /api/fgmp/assets/dispensers
 * ────────────────────────────────────────────────────────────────────────────
 * Create a new fuel dispenser (ESP32 + RS485 controlled pump) in the Asset
 * Registry. ADMIN-only. Mirrors the tanks/generators/batteries/iot create
 * endpoints but with dispenser-specific validation (unique [siteId, pumpNumber],
 * ESP controller identity, RS485 baud/address, etc.).
 *
 * On success the in-memory telemetry engine is reloaded so the new dispenser
 * is picked up on the next tick and begins simulating fueling transactions.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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

    const parsed = createDispenserSchema.safeParse(body);
    if (!parsed.success) {
      const res = NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = parsed.data;

    // Verify the site exists and belongs to the caller's tenant.
    // Scoped in the query so the caller's tenant can find the site.
    // assertTenantOwned is KEPT as defence in depth.
    const site = await asTenant(me, (tx) =>
      tx.site.findFirst({
        where: { id: data.siteId, tenantId: me.tenantId },
        select: { tenantId: true },
      }),
    );
    const siteDenied = assertSiteTenantOwned(site, user);
    if (siteDenied) {
      applyRateLimitHeaders(siteDenied.headers, rl);
      return siteDenied;
    }
    // `site` is null when it does not exist; assertSiteTenantOwned returns
    // null (allowed) for a same-tenant site, so the null case needs its own
    // check before `site.tenantId` is read.
    if (!site) {
      const res = NextResponse.json({ error: "Site not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Enforce the unique [siteId, pumpNumber] constraint up front (Prisma will
    // also enforce it, but a friendlier 409 is nicer than a P2002 error).
    // findUnique accepts the compound [siteId, pumpNumber] key but NOT an
    // extra tenantId field, so tenant scoping here comes from asTenant's
    // context rather than from the where clause.
    const existing = await asTenant(me, (tx) =>
      tx.fuelDispenser.findUnique({
        where: { siteId_pumpNumber: { siteId: data.siteId, pumpNumber: data.pumpNumber } },
        select: { id: true },
      }),
    );
    if (existing) {
      const res = NextResponse.json(
        { error: `Pump number ${data.pumpNumber} already exists at this site`, code: "PUMP_EXISTS" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const dispenser = await asTenant(me, (tx) =>
      tx.fuelDispenser.create({
      data: {
        siteId: data.siteId,
        tenantId: site.tenantId,
        label: data.label,
        pumpNumber: data.pumpNumber,
        nozzleCount: data.nozzleCount,
        fuelType: data.fuelType,
        maxFlowLpm: data.maxFlowLpm,
        manufacturer: data.manufacturer,
        model: data.model,
        espDeviceId: data.espDeviceId,
        espFirmware: data.espFirmware,
        ipAddress: data.ipAddress || null,
        // rs485Address carries the Modbus unit address (prisma/schema.prisma).
        rs485Address: data.rs485Address,
        rs485Baudrate: data.rs485Baudrate,
        rs485Parity: data.rs485Parity,
        presetVolumeLitres: data.presetVolumeLitres ?? null,
        mode: data.mode,
        status: data.mode === "LOCKED" ? "STOPPED" : "IDLE",
        totalizerLitres: 0,
        flowRateLpm: 0,
      },
      include: dispenserInclude,
    }));

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "DISPENSER_CREATE",
      entity: "FuelDispenser",
      entityId: dispenser.id,
      details: {
        siteId: data.siteId,
        label: data.label,
        pumpNumber: data.pumpNumber,
        espDeviceId: data.espDeviceId,
      },
    });

    // Reload the engine so the new dispenser appears in the live state.
    try {
      await engine.reload();
    } catch {
      /* best-effort */
    }

        // Phase 5: raw Prisma row — the volume columns are Decimal(12,3), so
    // decimalsToJson keeps them numbers on the wire instead of JSON strings.
    const res = NextResponse.json(decimalsToJson(dispenser), { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
