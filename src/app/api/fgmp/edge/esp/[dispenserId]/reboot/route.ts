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
 * POST /api/fgmp/edge/esp/[dispenserId]/reboot
 * Reboot the ESP32 controller embedded in a fuel dispenser. This is distinct
 * from the dispenser-state RESET command — it triggers an actual
 * microcontroller reboot, modeled as a 30s comm-loss window so the RS485
 * link goes down and poll latency spikes (visible in the RS485 tab).
 *
 * RBAC: DISPENSER_CONTROL (ADMIN, NOC_OPERATOR, FIELD_ENGINEER).
 * Audited as DISPENSER_CONTROL with { espReboot: true }.
 */export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ dispenserId: string }> },
) {
  const auth = await requireRole(req, ROLES.DISPENSER_CONTROL);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { dispenserId } = await params;

    // PHASE 3: scoped to the caller's tenant. Unscoped this returned null under
    // FORCE RLS for every id, so the 404 was unreachable-but-safe; now the
    // row resolves and only a genuinely foreign id 404s.
    const dispenser = await withTenant(tenantIdOrThrow(me.tenantId), (tx) =>
      tx.fuelDispenser.findUnique({
        where: { id: dispenserId },
        select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(dispenser?.site ?? null, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    // PHASE 3: pass the authenticated tenant so the engine asserts the
    // dispenser's tenant matches before touching state or the database.
    const result = await engine.applyEspReboot(dispenserId, me.id, tenantIdOrThrow(me.tenantId));

    // Audit at the API layer too (in addition to the engine's own audit) so
    // the action is searchable by the audit-view's dispenser-control filter.
    if (result.ok) {
      await audit({
        userId: me.id,
        tenantId: tenantIdOrThrow(me.tenantId),
        action: "DISPENSER_CONTROL",
        entity: "FuelDispenser",
        entityId: dispenserId,
        details: { espReboot: true },
      });
    }

    const res = NextResponse.json(
      result,
      { status: result.ok ? 202 : 404 },
    );
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
