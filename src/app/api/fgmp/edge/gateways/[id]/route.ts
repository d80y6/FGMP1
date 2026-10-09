import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/fgmp/edge/gateways/[id]
 * Update a gateway's editable fields (hostname, model, ipAddress). ADMIN-only
 * (EDGE_MANAGE capability). On success, the engine's in-memory gateway state
 * is mirrored + the change is audited.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.EDGE_MANAGE);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const data: { hostname?: string; model?: string; ipAddress?: string | null } = {};
    if (typeof body.hostname === "string" && body.hostname.trim()) data.hostname = body.hostname.trim().slice(0, 60);
    if (typeof body.model === "string" && body.model.trim()) data.model = body.model.trim().slice(0, 60);
    if (typeof body.ipAddress === "string") data.ipAddress = body.ipAddress.trim().slice(0, 60) || null;

    const existing = await withTenant(tenantIdOrThrow(me.tenantId), (tx) =>
      tx.siteGateway.findUnique({
        where: { id },
        select: { id: true, hostname: true, site: { select: { tenantId: true } } },
      }),
    );
    if (!existing) {
      const res = NextResponse.json({ error: "Gateway not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const denied = assertSiteTenantOwned(existing.site, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const updated = await withTenant(tenantIdOrThrow(me.tenantId), (tx) =>
      tx.siteGateway.update({
        where: { id },
        data,
        include: { site: { select: { id: true, name: true, code: true } } },
      }),
    );

    // Mirror the changes into the engine's in-memory state so the next
    // snapshot reflects the new hostname/model/IP without waiting for reload().
    const live = engine.gateways.find((g) => g.id === id);
    if (live) {
      if (data.hostname) live.hostname = data.hostname;
      if (data.model) live.model = data.model;
      if (data.ipAddress !== undefined) live.ipAddress = data.ipAddress ?? undefined;
    }

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "DISPENSER_CONTROL",
      entity: "SiteGateway",
      entityId: id,
      details: { gatewayUpdate: data, hostname: existing.hostname },
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/edge/gateways/[id]
 * Remove a gateway row. ADMIN-only (EDGE_MANAGE). The site is left intact
 * (the gateway relation is optional). On success, the engine reloads so the
 * gateway disappears from the live snapshot.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.EDGE_MANAGE);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await params;
    const existing = await withTenant(tenantIdOrThrow(me.tenantId), (tx) =>
      tx.siteGateway.findUnique({
        where: { id },
        select: { id: true, hostname: true, site: { select: { tenantId: true } } },
      }),
    );
    if (!existing) {
      const res = NextResponse.json({ error: "Gateway not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const denied = assertSiteTenantOwned(existing.site, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.siteGateway.delete({ where: { id } }));

    await audit({
      userId: me.id,
      tenantId: tenantIdOrThrow(me.tenantId),
      action: "DISPENSER_CONTROL",
      entity: "SiteGateway",
      entityId: id,
      details: { gatewayDelete: existing.hostname },
    });

    try { await engine.reload(); } catch { /* best-effort */ }

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/edge/gateways/[id]
 * Action dispatcher for gateway operations. Currently supports:
 *   { action: "reboot" } — simulate a 20s gateway reboot (DEGRADED then ONLINE).
 *
 * RBAC: ADMIN-only (EDGE_MANAGE). Audited as DISPENSER_CONTROL with
 * { gatewayReboot: hostname }.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.EDGE_MANAGE);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (body?.action !== "reboot") {
      const res = NextResponse.json({ error: "Unknown action" }, { status: 400 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Tenant guard: verify the gateway belongs to the caller's tenant before
    // dispatching the reboot through the engine.
    const existing = await withTenant(tenantIdOrThrow(me.tenantId), (tx) =>
      tx.siteGateway.findUnique({
        where: { id },
        select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    if (!existing) {
      const res = NextResponse.json({ error: "Gateway not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const denied = assertSiteTenantOwned(existing.site, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // Phase 3: the authenticated tenant is required. Without it the engine's
    // scope assertion refuses every reboot (fail-closed, but the feature is
    // then broken rather than protected).
    const result = await engine.applyGatewayReboot(id, me.id, tenantIdOrThrow(me.tenantId));
    const res = NextResponse.json(result, { status: result.ok ? 202 : 404 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
