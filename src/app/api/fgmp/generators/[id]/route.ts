import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

// Inline Zod schema for generator updates.
//
// Task #8 (Per-asset threshold controls) added the alias key
// `maintenanceDueHours` so the per-asset threshold editor in the
// site-detail-sheet can speak in domain terms rather than the internal DB
// column name (`nextMaintenanceHrs`). The route handler below maps the alias
// to the canonical column before the Prisma update. Both shapes are accepted;
// callers may use either.
const updateGeneratorSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  manufacturer: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  ratedPowerKw: z.coerce.number().positive().max(20_000).optional(),
  fuelType: z.enum(["DIESEL", "PETROL"]).optional(),
  status: z
    .enum(["RUNNING", "STOPPED", "FAULT", "MAINTENANCE", "OFFLINE"])
    .optional(),
  mode: z.enum(["AUTO", "MANUAL", "REMOTE"]).optional(),
  runtimeHours: z.coerce.number().min(0).optional(),
  oilChangeIntervalHrs: z.coerce.number().min(1).max(10_000).optional(),
  lastOilChangeHrs: z.coerce.number().min(0).optional(),
  nextMaintenanceHrs: z.coerce.number().min(0).optional(),
  // Task #8 alias — domain-friendly name for the maintenance editor.
  maintenanceDueHours: z.coerce.number().positive().max(1_000_000).optional(),
});

/**
 * GET /api/fgmp/generators/[id]
 * Returns a single generator by id with its related Site + merged live telemetry.
 * Any authenticated session may fetch.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;
    const g = await withTenant(user.tenantId, (tx) => tx.generator.findUnique({
      where: { id },
      include: { site: { select: { id: true, name: true, code: true, tenantId: true } } },
    }));
    const denied = assertSiteTenantOwned(g?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!g) {
      const res = NextResponse.json({ error: "Generator not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const l = engine.generators.find((x) => x.id === id);
    const merged = {
      ...g,
      liveStatus: l?.status ?? g.status,
      liveMode: l?.mode ?? g.mode,
      liveLoadKw: l?.loadKw ?? g.loadKw,
      liveTemperatureC: l?.temperatureC ?? g.temperatureC,
      liveRuntimeHours: l?.runtimeHours ?? g.runtimeHours,
      liveFuelRateLph: l?.fuelRateLph ?? g.fuelRateLph,
      liveLastReadingAt: l?.lastReadingAt ?? g.lastReadingAt?.getTime(),
    };
    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/generators/[id]
 * Update a generator's mutable fields. ADMIN-only. Persists to DB and
 * updates the engine's in-memory state in one step.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
    const r = updateGeneratorSchema.safeParse(body);
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
    const existing = await withTenant(user.tenantId, (tx) => tx.generator.findUnique({
      where: { id },
      include: { site: { select: { tenantId: true } } },
    }));
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // Build Prisma update payload (only defined fields).
    // Task #8: map the alias key `maintenanceDueHours` to the canonical DB
    // column `nextMaintenanceHrs` so callers can use either shape.
    const updateData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === "maintenanceDueHours") updateData.nextMaintenanceHrs = v;
      else updateData[k] = v;
    }
    const row = await withTenant(user.tenantId, (tx) => tx.generator.update({
      where: { id },
      data: updateData,
      include: { site: { select: { id: true, name: true, code: true } } },
    }));

    // Update engine's in-memory state.
    const live = engine.generators.find((x) => x.id === id);
    if (live) {
      if (data.label !== undefined) live.label = data.label;
      if (data.manufacturer !== undefined) live.manufacturer = data.manufacturer;
      if (data.model !== undefined) live.model = data.model;
      if (data.ratedPowerKw !== undefined) live.ratedPowerKw = data.ratedPowerKw;
      // fuelType is persisted to DB; engine GenState doesn't track it in-memory.
      if (data.status !== undefined) live.status = data.status;
      if (data.mode !== undefined) live.mode = data.mode;
      if (data.runtimeHours !== undefined) live.runtimeHours = data.runtimeHours;
      if (data.oilChangeIntervalHrs !== undefined) live.oilChangeIntervalHrs = data.oilChangeIntervalHrs;
      if (data.lastOilChangeHrs !== undefined) live.lastOilChangeHrs = data.lastOilChangeHrs;
      if (data.nextMaintenanceHrs !== undefined) live.nextMaintenanceHrs = data.nextMaintenanceHrs;
      // Task #8 alias — keep the in-memory engine state in sync too.
      if (data.maintenanceDueHours !== undefined) live.nextMaintenanceHrs = data.maintenanceDueHours;
    }

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "GENERATOR_UPDATE",
      entity: "Generator",
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
 * DELETE /api/fgmp/generators/[id]
 * Hard-delete a generator. ADMIN-only. Cascades to ControlCommand rows.
 * The engine's in-memory state is also updated.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    const existing = await withTenant(user.tenantId, (tx) => tx.generator.findUnique({
      where: { id },
      include: { site: { select: { tenantId: true, name: true } } },
    }));
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Generator not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await withTenant(user.tenantId, (tx) => tx.generator.delete({ where: { id } }));

    // Remove from the engine's in-memory array.
    const idx = engine.generators.findIndex((g) => g.id === id);
    if (idx >= 0) engine.generators.splice(idx, 1);

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "GENERATOR_DELETE",
      entity: "Generator",
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
