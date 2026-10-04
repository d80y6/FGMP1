import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import { dispenserControlSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/dispensers/[id]/control
 * Send a remote control command to a fuel dispenser.
 *
 * Commands:
 *   - AUTHORIZE  → set status AUTHORIZED, optionally with a preset volume
 *   - STOP       → halt in-progress dispensing (cancels + records partial txn)
 *   - RESET      → clear FAULT state and return to IDLE
 *   - LOCK       → mode LOCKED, status STOPPED (no new txns possible)
 *   - UNLOCK     → mode AUTO, status IDLE
 *
 * Roles: ADMIN, NOC_OPERATOR (ROLES.CONTROL — same as generator control).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.CONTROL);
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

    // Tenant isolation: verify the dispenser's site belongs to the caller's
    // tenant before dispatching the control command through the engine.
    const dispenser = await db.fuelDispenser.findUnique({
      where: { id },
      select: { id: true, site: { select: { tenantId: true } } },
    });
    const denied = assertSiteTenantOwned(dispenser?.site ?? null, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(dispenserControlSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { command, presetVolumeLitres } = r.data;

    const result = await engine.controlDispenser(id, command, presetVolumeLitres);
    await audit({
      userId: user.id,
      action: "CONTROL",
      entity: "dispenser",
      entityId: id,
      details: { command, presetVolumeLitres, result },
    });
    const res = NextResponse.json(result, { status: result.ok ? 200 : 409 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
