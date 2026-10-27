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
import { decimalsToJson } from "@/lib/fgmp/decimal";

export const dynamic = "force-dynamic";

// Inline Zod schema for tank updates.
//
// Two alias keys — `lowFuelLitres` and `criticalFuelLitres` — were added in
// Task #8 (Per-asset threshold controls) so the per-asset threshold editor in
// the site-detail-sheet can speak in domain terms (litres of fuel) rather than
// the internal DB column names (`lowThreshold` / `criticalThreshold`). The
// route handler below maps the alias keys to the canonical DB columns before
// the Prisma update. Both shapes are accepted; callers may use either.
//
// Cross-field rule: when BOTH `lowFuelLitres` (or `lowThreshold`) and
// `criticalFuelLitres` (or `criticalThreshold`) are present, the critical
// value must be strictly less than the low value.
const updateTankSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    fuelType: z.enum(["DIESEL", "PETROL"]).optional(),
    capacityLitres: z.coerce.number().positive().max(5_000_000).optional(),
    currentLitres: z.coerce.number().min(0).max(5_000_000).optional(),
    lowThreshold: z.coerce.number().min(0).max(5_000_000).optional(),
    criticalThreshold: z.coerce.number().min(0).max(5_000_000).optional(),
    // Task #8 aliases — domain-friendly names for the threshold editor.
    lowFuelLitres: z.coerce.number().positive().max(5_000_000).optional(),
    criticalFuelLitres: z.coerce.number().positive().max(5_000_000).optional(),
    status: z
      .enum(["OPERATIONAL", "MAINTENANCE", "OFFLINE", "EMPTY"])
      .optional(),
  })
  .refine(
    (d) => {
      // Resolve the effective low / critical values from either alias.
      const low = d.lowFuelLitres ?? d.lowThreshold;
      const crit = d.criticalFuelLitres ?? d.criticalThreshold;
      if (low === undefined || crit === undefined) return true;
      return crit < low;
    },
    {
      message: "criticalFuelLitres must be less than lowFuelLitres",
      path: ["criticalFuelLitres"],
    },
  );

/**
 * GET /api/fgmp/tanks/[id]
 * Returns a single fuel tank by id with its related Site + merged live telemetry.
 * Any authenticated session may fetch.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;
    const t = await asTenant(me, (tx) =>
      tx.fuelTank.findFirst({
        where: { id },
      include: { site: { select: { id: true, name: true, code: true, tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(t?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!t) {
      const res = NextResponse.json({ error: "Tank not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const l = engine.tanks.find((x) => x.id === id);
    const merged = {
      ...t,
      liveCurrentLitres: l?.current ?? t.currentLitres,
      liveStatus: l?.status ?? t.status,
      liveLastReadingAt: l?.lastReadingAt ?? t.lastReadingAt?.getTime(),
    };
    const res = NextResponse.json(decimalsToJson(merged));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/tanks/[id]
 * Update a tank's mutable fields. ADMIN-only. Persists to DB and updates the
 * engine's in-memory state in one step.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const r = updateTankSchema.safeParse(body);
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
    const existing = await asTenant(me, (tx) =>
      tx.fuelTank.findFirst({
        where: { id },
      include: { site: { select: { tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // Build Prisma update payload (only defined fields).
    // Task #8: map the domain-friendly alias keys (`lowFuelLitres` /
    // `criticalFuelLitres`) to the canonical DB columns (`lowThreshold` /
    // `criticalThreshold`) so callers can use either shape.
    const updateData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === "lowFuelLitres") updateData.lowThreshold = v;
      else if (k === "criticalFuelLitres") updateData.criticalThreshold = v;
      else updateData[k] = v;
    }
    // `update` takes a unique selector, so tenantId cannot be part of the
// where clause; the `existing` guard above already asserted ownership and
// the nested include of site is itself RLS-protected, so it belongs here.
    const row = await asTenant(me, (tx) =>
      tx.fuelTank.update({
        where: { id },
      data: updateData,
      include: { site: { select: { id: true, name: true, code: true } } },
      }),
    );

    // Update engine's in-memory state.
    const live = engine.tanks.find((x) => x.id === id);
    if (live) {
      if (data.label !== undefined) live.label = data.label;
      if (data.fuelType !== undefined) live.fuelType = data.fuelType;
      if (data.capacityLitres !== undefined) live.capacity = data.capacityLitres;
      if (data.currentLitres !== undefined) {
        live.prevLevel = live.current;
        live.current = data.currentLitres;
      }
      if (data.lowThreshold !== undefined) live.low = data.lowThreshold;
      if (data.criticalThreshold !== undefined) live.critical = data.criticalThreshold;
      // Task #8 alias keys — keep the in-memory engine state in sync too.
      if (data.lowFuelLitres !== undefined) live.low = data.lowFuelLitres;
      if (data.criticalFuelLitres !== undefined) live.critical = data.criticalFuelLitres;
      if (data.status !== undefined) live.status = data.status;
    }

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "TANK_UPDATE",
      entity: "FuelTank",
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
 * DELETE /api/fgmp/tanks/[id]
 * Hard-delete a fuel tank. ADMIN-only. Cascades to FuelDelivery rows
 * (Prisma onDelete: Cascade). The engine's in-memory state is also updated.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;

    const existing = await asTenant(me, (tx) =>
      tx.fuelTank.findFirst({
        where: { id },
      include: { site: { select: { tenantId: true, name: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Tank not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await asTenant(me, (tx) =>
      // deleteMany, not delete: `delete` THROWS when the row is absent, so a
      // cross-tenant id would 500 and distinguish itself from a missing one.
      tx.fuelTank.deleteMany({ where: { id } }),
    );

    // Remove from the engine's in-memory array.
    const idx = engine.tanks.findIndex((t) => t.id === id);
    if (idx >= 0) engine.tanks.splice(idx, 1);

    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "TANK_DELETE",
      entity: "FuelTank",
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
