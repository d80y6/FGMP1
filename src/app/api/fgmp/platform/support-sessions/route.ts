import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientIp, rateLimitByUser, applyRateLimitHeaders, MUTATION_LIMIT, READ_LIMIT } from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { listSupportSessionsFor } from "@/lib/fgmp/platform-store";
import {
  SUPPORT_COOKIE,
  SUPPORT_MAX_TTL_SEC,
  SUPPORT_REASON_MIN,
  endSupportSession,
  startSupportSession,
} from "@/lib/fgmp/support-session";
import {
  SUPPORT_COOKIE_OPTIONS,
  currentSupport,
  requireSuperAdmin,
  supportErrorResponse,
} from "@/lib/fgmp/support-request";

export const dynamic = "force-dynamic";

/**
 * Platform support sessions — the single entry point for a super-admin to look
 * at a customer's data.
 *
 * ── WHY THIS IS NOT "SUPERADMIN BYPASSES RLS" ───────────────────────────────
 * The session is a row that grants ONE tenant, for a stated reason, until a
 * stated time. Every read it enables goes through `withTenant(session.tenantId,
 * …)`, so the request still runs as `fgmp_app` with RLS applied — the session
 * chooses WHICH tenant context is set, it does not remove the filter. There is
 * no bypass role anywhere on this path.
 *
 * ── WHY STARTING A SESSION IS NOT ENOUGH ON ITS OWN ─────────────────────────
 * Three things make the capability real rather than nominal:
 *   * the reason is mandatory and is shown to the tenant, so "why" is not
 *     reconstructable only from memory;
 *   * exactly one session may be open per operator (database-enforced — see
 *     the partial unique index in the migration);
 *   * the token is a signed cookie bound to the operator, so possession of a
 *     session id from the audit log is not access.
 */

const startSchema = z.object({
  tenantId: z.string().min(1).max(128),
  reason: z.string().min(SUPPORT_REASON_MIN).max(500),
  ticketRef: z.string().max(120).optional(),
  mode: z.enum(["READ", "WRITE"]).optional(),
  // Optional, and clamped server-side to SUPPORT_MAX_TTL_SEC. A client cannot
  // ask for a session longer than the ceiling.
  ttlSec: z.number().int().positive().max(SUPPORT_MAX_TTL_SEC).optional(),
});

/**
 * GET /api/fgmp/platform/support-sessions
 *
 * The operator's own recent sessions plus the one that is active, if any. This
 * is what the UI banner reads: it answers "am I currently acting as somebody
 * else?" from the database rather than from client state.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  try {
    const active = await currentSupport(me);
    const rows = await listSupportSessionsFor(me.id);
    const res = NextResponse.json({
      active: active
        ? {
            id: active.id,
            tenantId: active.tenantId,
            mode: active.mode,
            reason: active.reason,
            ticketRef: active.ticketRef,
            createdAt: active.createdAt,
            expiresAt: active.expiresAt,
          }
        : null,
      sessions: rows,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/platform/support-sessions
 *
 * Body: { tenantId, reason, ticketRef?, mode?, ttlSec? }
 *
 * Sets the signed `fgmp_support_session` cookie on success. Read-only unless
 * `mode: "WRITE"` is requested, which additionally requires a ticket reference.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;

  const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
  if (!rl.success) {
    const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const { session, token } = await startSupportSession({
      actor: { id: me.id, email: me.email ?? null, role: me.role },
      tenantId: parsed.data.tenantId,
      reason: parsed.data.reason,
      ticketRef: parsed.data.ticketRef ?? null,
      mode: parsed.data.mode,
      ttlSec: parsed.data.ttlSec,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });

    const res = NextResponse.json(
      {
        id: session.id,
        tenantId: session.tenantId,
        mode: session.mode,
        reason: session.reason,
        ticketRef: session.ticketRef,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      },
      { status: 201 },
    );
    res.cookies.set({
      ...SUPPORT_COOKIE_OPTIONS,
      name: SUPPORT_COOKIE,
      value: token,
      maxAge: Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    const known = supportErrorResponse(err);
    if (known) {
      applyRateLimitHeaders(known.headers, rl);
      return known;
    }
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/platform/support-sessions
 *
 * Ends whichever session is currently active for this operator and clears the
 * cookie. Same code path as DELETE /[id] — this is the convenience form the
 * banner uses, because the banner knows it has a session but not necessarily
 * its id.
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
    // Nothing to end is not an error; the cookie may simply be stale. Clear it
    // so the client stops asking.
    const res = NextResponse.json({ ok: true, ended: null });
    res.cookies.delete({ name: SUPPORT_COOKIE, path: SUPPORT_COOKIE_OPTIONS.path });
    return res;
  }

  try {
    const row = await endSupportSession(
      { id: me.id, email: me.email ?? null, role: me.role },
      active.id,
      { reason: "ENDED_BY_OPERATOR", ip: getClientIp(req) },
    );
    const res = NextResponse.json({
      ok: true,
      ended: { id: row.id, tenantId: row.tenantId, endedAt: row.endedAt ?? new Date(), endReason: row.endReason },
    });
    res.cookies.delete({ name: SUPPORT_COOKIE, path: SUPPORT_COOKIE_OPTIONS.path });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    const known = supportErrorResponse(err);
    if (known) return known;
    return errorResponse(err);
  }
}
