import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { audit } from "@/lib/fgmp/audit";
import { updateDispenserSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

const dispenserInclude = {
  site: { select: { name: true, code: true } },
} as const;

/**
 * PUT /api/fgmp/assets/dispensers/[id]
 * ────────────────────────────────────────────────────────────────────────────
 * Update editable fields on a dispenser (label, mode, presetVolumeLitres, ESP
 * controller firmware/IP, RS485 baud/address, parity). ADMIN-only. Mirrors
 * the tanks/generators/batteries/iot PUT endpoint.
 *
 * Identity fields (site, pump #, nozzles, manufacturer, model, ESP controller
 * ID) are NOT editable after creation — they're part of the physical
 * commissioning record. The updateDispenserSchema enforces this.
 *
 * The PUT also pushes the new values into the in-memory engine state so
 * the next tick sees the updated mode/preset without a full reload. If the
 * mode is being set to LOCKED, status is forced to STOPPED; unlocking from
 * LOCKED resets status to IDLE.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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
    const r = validateBody(updateDispenserSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    const existing = await asTenant(me, (tx) =>
      tx.fuelDispenser.findFirst({
        where: { id },
      select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Dispenser not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const updateData: Record<string, unknown> = {};
    if (data.label !== undefined) updateData.label = data.label;
    if (data.mode !== undefined) updateData.mode = data.mode;
    if (data.presetVolumeLitres !== undefined) updateData.presetVolumeLitres = data.presetVolumeLitres;
    if (data.espFirmware !== undefined) updateData.espFirmware = data.espFirmware;
    if (data.ipAddress !== undefined) updateData.ipAddress = data.ipAddress || null;
    // rs485Address carries the Modbus unit address (prisma/schema.prisma).
    if (data.rs485Address !== undefined) updateData.rs485Address = data.rs485Address;
    if (data.rs485Baudrate !== undefined) updateData.rs485Baudrate = data.rs485Baudrate;
    if (data.rs485Parity !== undefined) updateData.rs485Parity = data.rs485Parity;
    if (data.status !== undefined) updateData.status = data.status;
    // If mode is being set to LOCKED, force status to STOPPED; if being
    // unlocked from LOCKED, reset status to IDLE.
    if (data.mode === "LOCKED") updateData.status = "STOPPED";
    if (data.mode === "AUTO" || data.mode === "MANUAL") updateData.status = "IDLE";

    // `update` takes a unique selector, so tenantId cannot be part of the
// where clause; the `existing` guard above already asserted ownership and
// the nested include of site is itself RLS-protected, so it belongs here.
    const updated = await asTenant(me, (tx) =>
      tx.fuelDispenser.update({
        where: { id },
      data: updateData,
      include: dispenserInclude,
      }),
    );

    // Mirror the changes into the in-memory engine state
    const live = engine.dispensers.find((x) => x.id === id);
    if (live) {
      if (data.label !== undefined) live.label = data.label;
      if (data.mode !== undefined) {
        live.mode = data.mode;
        if (data.mode === "LOCKED") {
          live.status = "STOPPED";
        } else if (live.status === "STOPPED") {
          live.status = "IDLE";
        }
      }
      if (data.presetVolumeLitres !== undefined) live.presetVolumeLitres = data.presetVolumeLitres;
      if (data.espFirmware !== undefined) live.espFirmware = data.espFirmware;
      if (data.ipAddress !== undefined) live.ipAddress = data.ipAddress || undefined;
      if (data.rs485Address !== undefined) live.rs485Address = data.rs485Address;
      if (data.rs485Baudrate !== undefined) live.rs485Baudrate = data.rs485Baudrate;
      if (data.rs485Parity !== undefined) live.rs485Parity = data.rs485Parity;
      if (data.status !== undefined) live.status = data.status;
    }

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "DISPENSER_UPDATE",
      entity: "FuelDispenser",
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
 * DELETE /api/fgmp/assets/dispensers/[id]
 * ────────────────────────────────────────────────────────────────────────────
 * Hard-delete a dispenser from the registry. ADMIN-only. Per the Prisma
 * schema, FuelTransaction rows cascade-delete with the dispenser, so all
 * historical fueling records for this pump are removed too. The in-memory
 * engine state is also pruned.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    const existing = await asTenant(me, (tx) =>
      tx.fuelDispenser.findFirst({
        where: { id },
      select: {
        id: true,
        label: true,
        siteId: true,
        pumpNumber: true,
        espDeviceId: true,
        totalizerLitres: true,
        // FuelDispenser has a single cascading child relation (`transactions`);
        // there is no dispenser-command table in the schema.
        _count: { select: { transactions: true } },
        site: { select: { tenantId: true } },
      },
      }),
    );
    const tenantDenied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Dispenser not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) =>
      // deleteMany, not delete: `delete` THROWS when the row is absent, so a
      // cross-tenant id would 500 and distinguish itself from a missing one.
      tx.fuelDispenser.deleteMany({ where: { id } }),
    );

    // Remove from the in-memory engine state
    const idx = engine.dispensers.findIndex((x) => x.id === id);
    if (idx >= 0) engine.dispensers.splice(idx, 1);

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "DISPENSER_DELETE",
      entity: "FuelDispenser",
      entityId: id,
      details: {
        label: existing.label,
        siteId: existing.siteId,
        pumpNumber: existing.pumpNumber,
        espDeviceId: existing.espDeviceId,
        totalizerLitres: existing.totalizerLitres,
        cascadeDeletedTransactions: existing._count.transactions,
      },
      });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
