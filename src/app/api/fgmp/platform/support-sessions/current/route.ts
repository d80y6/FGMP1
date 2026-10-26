import { NextRequest, NextResponse } from "next/server";
import {
  applyRateLimitHeaders,
  getClientIp,
  rateLimitByUser,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { SUPPORT_COOKIE, endSupportSession } from "@/lib/fgmp/support-session";
import { getTenantMeta } from "@/lib/fgmp/platform-store";
import {
  SUPPORT_COOKIE_OPTIONS,
  currentSupport,
  requireSuperAdmin,
  supportErrorResponse,
} from "@/lib/fgmp/support-request";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/platform/support-sessions/current
 *
 * What the persistent banner renders. Deliberately cheap (one indexed lookup
 * plus the signed-cookie check) because it runs on every authenticated page
 * load for a super-admin.
 *
 * Returns `{ active: null }` with 200 when there is no session — the absence of
 * a support session is a normal state, not an error. The banner then renders
 * nothing.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
  if (!rl.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const active = await currentSupport(me);
    if (!active) return NextResponse.json({ active: null });
    // The tenant NAME is included so the banner shows "Aden Fuel Co", not
    // "t-default": an operator must be able to recognise the customer at a
    // glance, because the banner's job is to prevent "I forgot whose data this
    // was". The name is platform metadata (Tenant has no RLS).
    const tenant = await getTenantMeta(active.tenantId);
    return NextResponse.json({
      active: { ...active, tenantName: tenant?.name ?? null, tenantCode: tenant?.code ?? null },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/platform/support-sessions/current
 *
 * End the active session. This is the button on the banner, so it must always
 * succeed at clearing the client's cookie even when the row is already gone —
 * otherwise an operator is stuck with a banner they cannot dismiss.
 */
/**
 * DELETE /api/fgmp/platform/support-sessions/current
 *
 * Ends the session this browser holds. Rate-limited for the same reason as
 * `DELETE /platform/support-sessions/[id]`: closing the cross-tenant window must
 * stay an action the operator can complete, and each call writes an audit row.
 * The limiter runs before the session lookup so repeated calls cannot be used to
 * churn the store, and the reply shape stays `{ ok, ended }` in both branches.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  const active = await currentSupport(me);
  if (!active) {
    // Same shape as the success case so the client has one branch, not two.
    const res = NextResponse.json({ ok: true, ended: null });
    res.cookies.delete({ name: SUPPORT_COOKIE, path: SUPPORT_COOKIE_OPTIONS.path });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  try {
    const row = await endSupportSession(
      { id: me.id, email: me.email ?? null, role: me.role },
      active.id,
      { reason: "ENDED_FROM_BANNER", ip: getClientIp(req) },
    );
    const res = NextResponse.json({ ok: true, ended: { id: row.id, endedAt: row.endedAt ?? new Date() } });
    res.cookies.delete({ name: SUPPORT_COOKIE, path: SUPPORT_COOKIE_OPTIONS.path });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    const known = supportErrorResponse(err);
    if (known) return known;
    return errorResponse(err);
  }
}
