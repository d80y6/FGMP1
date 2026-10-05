import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { withTenant } from "@/lib/fgmp/tenant-context";
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
  const me = auth.user;
  try {
    const rl = rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;

    // ── PHASE 3: scoped lookup ────────────────────────────────────────────
    // This ran on the bare `db` client with no tenant context. Under FORCE RLS
    // that returns null for EVERY id, so assertSiteTenantOwned(null) answered
    // 404 — the endpoint was unreachable for legitimate operators, and the 404
    // was indistinguishable from "no such dispenser".
    //
    // The tenant is the AUTHENTICATED caller's, so the policy's USING clause
    // matches and the row resolves. A cross-tenant id therefore still yields
    // null -> 404, which is the intended 404-not-403 behaviour.
    const dispenser = await withTenant(me.tenantId, (tx) =>
      tx.fuelDispenser.findUnique({
        where: { id },
        select: { id: true, site: { select: { tenantId: true } } },
      }),
    );
    const denied = assertSiteTenantOwned(dispenser?.site ?? null, me);
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

    // ── PHASE 3: the AUTHENTICATED tenant is passed down so the engine can assert
    // the dispenser's tenant matches. Without it the engine has only the asset's
    // own tenant to compare, which proves nothing.
    const result = await engine.controlDispenser(
      id,
      command,
      presetVolumeLitres,
      me.tenantId,
    );
    await audit({
      userId: me.id,
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
