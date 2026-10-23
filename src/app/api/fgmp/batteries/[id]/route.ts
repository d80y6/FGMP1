import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

// Inline Zod schema for battery updates.
const updateBatterySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  chemistry: z.enum(["VRLA", "AGM", "LITHIUM", "GEL", "LIPO"]).optional(),
  capacityAh: z.coerce.number().positive().max(100_000).optional(),
  nominalVoltage: z.coerce.number().positive().max(1_000).optional(),
  voltage: z.coerce.number().optional(),
  stateOfCharge: z.coerce.number().min(0).max(100).optional(),
  stateOfHealth: z.coerce.number().min(0).max(100).optional(),
  status: z
    .enum(["OK", "LOW", "FAILING", "REPLACEMENT_DUE", "OFFLINE"])
    .optional(),
});

/**
 * GET /api/fgmp/batteries/[id]
 * Returns a single battery bank by id with its related Site + merged live
 * telemetry. Any authenticated session may fetch.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;
    // Scoped in the query, INCLUDING the nested relation: the `include: { site }`
    // below is RLS-protected, so scoping only the outer findUnique returns a
    // battery with a null site behind a 200 — a false success, not an obvious
    // empty list.
    const b = await asTenant(user, (tx) =>
      tx.batteryBank.findFirst({
        where: { id, site: { tenantId: user.tenantId } },
        include: { site: { select: { id: true, name: true, code: true, tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(b?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!b) {
      const res = NextResponse.json({ error: "Battery not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const l = engine.batteries.find((x) => x.id === id);
    const merged = {
      ...b,
      liveVoltage: l?.voltage ?? b.voltage,
      liveStateOfCharge: l?.stateOfCharge ?? b.stateOfCharge,
      liveStateOfHealth: l?.stateOfHealth ?? b.stateOfHealth,
      liveStatus: l?.status ?? b.status,
      liveCharging: l?.charging ?? b.charging,
      liveLastReadingAt: l?.lastReadingAt ?? b.lastReadingAt?.getTime(),
    };
    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/batteries/[id]
 * Update a battery bank's mutable fields. ADMIN-only. Persists to DB and
 * updates the engine's in-memory state in one step.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const r = updateBatterySchema.safeParse(body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error.flatten() },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Verify existence + tenant scope.
    const existing = await asTenant(user, (tx) =>
      tx.batteryBank.findFirst({
        where: { id, site: { tenantId: user.tenantId } },
        include: { site: { select: { tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // Build Prisma update payload (only defined fields).
    const updateData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) updateData[k] = v;
    }
    const row = await asTenant(user, (tx) =>
      tx.batteryBank.update({
        where: { id },
        data: updateData,
        include: { site: { select: { id: true, name: true, code: true } } },
      }),
    );

    // Update engine's in-memory state.
    const live = engine.batteries.find((x) => x.id === id);
    if (live) {
      if (data.label !== undefined) live.label = data.label;
      if (data.chemistry !== undefined) live.chemistry = data.chemistry;
      if (data.capacityAh !== undefined) live.capacityAh = data.capacityAh;
      if (data.nominalVoltage !== undefined) live.nominalVoltage = data.nominalVoltage;
      if (data.voltage !== undefined) live.voltage = data.voltage;
      if (data.stateOfCharge !== undefined) live.stateOfCharge = data.stateOfCharge;
      if (data.stateOfHealth !== undefined) live.stateOfHealth = data.stateOfHealth;
      if (data.status !== undefined) live.status = data.status;
    }

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "BATTERY_UPDATE",
      entity: "BatteryBank",
      entityId: id,
      details: data as Record<string, unknown>,
    });

    const res = NextResponse.json(row);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/batteries/[id]
 * Hard-delete a battery bank. ADMIN-only. The engine's in-memory state is
 * also updated.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    const existing = await asTenant(user, (tx) =>
      tx.batteryBank.findFirst({
        where: { id, site: { tenantId: user.tenantId } },
        include: { site: { select: { tenantId: true, name: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Battery not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // deleteMany, not delete: `delete` THROWS when the row is not found, so a
    // cross-tenant id would produce a 500 that distinguishes it from a 404.
    // deleteMany matches zero rows instead, which the existing 404 path
    // already handles.
    await asTenant(user, (tx) =>
      tx.batteryBank.deleteMany({ where: { id, site: { tenantId: user.tenantId } } }),
    );

    // Remove from the engine's in-memory array.
    const idx = engine.batteries.findIndex((b) => b.id === id);
    if (idx >= 0) engine.batteries.splice(idx, 1);

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "BATTERY_DELETE",
      entity: "BatteryBank",
      entityId: id,
      details: {
        label: existing.label,
        siteId: existing.siteId,
        siteName: existing.site.name,
      },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
