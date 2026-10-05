import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/fgmp/edge/firmware/[id]
 * Remove a firmware release. SUPERADMIN-only.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * `EspFirmwareRelease` has NO `tenantId` column — firmware releases are
 * platform-shared resources (every tenant flashes the same signed binary).
 * This handler was gated on `ROLES.EDGE_MANAGE` (= ADMIN) and then did a bare
 * `findUnique({ where: { id } })` with no tenant scoping, which is
 * unavoidable for a table with no tenant column but means TENANT A's admin
 * could delete the release that TENANT B's dispensers are pinned to. Because
 * there is no per-tenant row to check, the only correct guard is to keep
 * mutation of global platform tables SUPERADMIN-only.
 *
 * (Tenant-scoped operations remain available: `edge/firmware/deploy` and
 * `edge/firmware/deployments` scope through `dispenser.site.tenantId`, and
 * `edge/esp/[dispenserId]/reboot` checks the dispenser's site. Those keep
 * `ROLES.DISPENSER_CONTROL`.)
 *
 * Refuses to delete a release that has any deployment rows — the deployment
 * history must be preserved for audit.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.SUPERADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await params;
    const existing = await withTenant(user.tenantId, (tx) => tx.espFirmwareRelease.findUnique({
      where: { id },
      select: { id: true, version: true, _count: { select: { deployments: true } } },
    }));
    if (!existing) {
      const res = NextResponse.json({ error: "Release not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (existing._count.deployments > 0) {
      const res = NextResponse.json(
        { error: "Cannot delete a release with existing deployments", code: "HAS_DEPLOYMENTS" },
        { status: 409 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await withTenant(user.tenantId, (tx) => tx.espFirmwareRelease.delete({ where: { id } }));

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "DISPENSER_CONTROL",
      entity: "EspFirmwareRelease",
      entityId: id,
      details: { releaseDelete: existing.version },
    });

    // Refresh the engine's cached firmware list.
    try { await engine.reload(); } catch { /* best-effort */ }

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
