import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import { updateDispenserSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { decimalsToJson } from "@/lib/fgmp/decimal";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/dispensers/[id]
 * Returns a single dispenser by id with its related Site + merged live telemetry.
 * Any authenticated session may fetch.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;
    const d = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.fuelDispenser.findUnique({
      where: { id },
      include: { site: { select: { id: true, name: true, code: true, tenantId: true } } },
    }));
    const tenantDenied = assertSiteTenantOwned(d?.site ?? null, user);
    if (tenantDenied) {
      applyRateLimitHeaders(tenantDenied.headers, rl);
      return tenantDenied;
    }
    if (!d) {
      const res = NextResponse.json({ error: "Dispenser not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const l = engine.dispensers.find((x) => x.id === id);
    const merged = {
      ...d,
      liveStatus: l?.status ?? d.status,
      liveMode: l?.mode ?? d.mode,
      liveFlowRateLpm: l?.flowRateLpm ?? d.flowRateLpm,
      liveCurrentVolumeLitres: l?.currentVolumeLitres ?? d.currentVolumeLitres,
      liveTotalizerLitres: l?.totalizerLitres ?? d.totalizerLitres,
      liveWifiRssi: l?.wifiRssi ?? d.wifiRssi,
      liveLastCommAt: l?.lastCommAt ?? d.lastCommAt?.getTime(),
      liveTempC: l?.tempC ?? d.tempC,
    };
    const res = NextResponse.json(decimalsToJson(merged));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/dispensers/[id]
 * Update a dispenser's mutable fields. ADMIN-only. Validates with
 * updateDispenserSchema. Persists to DB and updates the engine's in-memory
 * state in one step (engine.updateDispenser handles both).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    const body = await req.json().catch(() => ({}));
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

    // Verify existence + tenant scope
    const existing = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.fuelDispenser.findUnique({
      where: { id },
      include: { site: { select: { tenantId: true } } },
    }));
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const updated = await engine.updateDispenser(id, data);
    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "DISPENSER_UPDATE",
      entity: "FuelDispenser",
      entityId: id,
      details: data as Record<string, unknown>,
    });

    const res = NextResponse.json(updated ?? { ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/dispensers/[id]
 * Hard-delete a dispenser. ADMIN-only. Cascades to FuelTransaction rows
 * (Prisma onDelete: Cascade). The engine's in-memory state is also updated.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const { id } = await ctx.params;

    const existing = await withTenant(tenantIdOrThrow(user.tenantId), (tx) => tx.fuelDispenser.findUnique({
      where: { id },
      include: { site: { select: { tenantId: true, name: true } } },
    }));
    const denied = assertSiteTenantOwned(existing?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json({ error: "Dispenser not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await engine.deleteDispenser(id);
    await audit({
      userId: user.id,
      tenantId: tenantIdOrThrow(user.tenantId),
      action: "DISPENSER_DELETE",
      entity: "FuelDispenser",
      entityId: id,
      details: {
        label: existing.label,
        espDeviceId: existing.espDeviceId,
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
