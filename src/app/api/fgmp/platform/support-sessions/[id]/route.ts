import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/fgmp/rate-limit";
import { getSupportSession } from "@/lib/fgmp/platform-store";
import { errorResponse } from "@/lib/fgmp/api-error";
import { SUPPORT_COOKIE, endSupportSession } from "@/lib/fgmp/support-session";
import {
  SUPPORT_COOKIE_OPTIONS,
  currentSupport,
  requireSuperAdmin,
  supportErrorResponse,
} from "@/lib/fgmp/support-request";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/fgmp/platform/support-sessions/[id]
 *
 * End a specific session, e.g. one left open in another browser. Scoped to the
 * caller's own sessions: `endSupportSession` refuses a row belonging to another
 * operator with a 404 (indistinguishable from "does not exist", so this cannot
 * be used to probe for other operators' session ids).
 *
 * The cookie is cleared only when the ended session is the one this browser
 * holds; ending an older session must not silently drop the operator out of the
 * session they are actually using.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const { id } = await ctx.params;

  try {
    const row = await endSupportSession(
      { id: me.id, email: me.email ?? null, role: me.role },
      id,
      { reason: "ENDED_BY_OPERATOR", ip: getClientIp(req) },
    );
    const active = await currentSupport(me);
    const res = NextResponse.json({
      ok: true,
      ended: { id: row.id, tenantId: row.tenantId, endedAt: row.endedAt, endReason: row.endReason },
    });
    if (!active) res.cookies.delete({ name: SUPPORT_COOKIE, path: SUPPORT_COOKIE_OPTIONS.path });
    return res;
  } catch (err) {
    const known = supportErrorResponse(err);
    if (known) return known;
    return errorResponse(err);
  }
}

/**
 * GET /api/fgmp/platform/support-sessions/[id]
 *
 * One session with its row, for the operator's own review screen. The
 * cross-tenant aggregate (how many reads happened under it) is deliberately not
 * here: it would need a per-request log this phase does not keep, and inventing
 * a number would be worse than omitting it.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSuperAdmin(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  const { id } = await ctx.params;

  try {
    const row = await getSupportSession(id);
    if (!row || row.actorUserId !== me.id) {
      return NextResponse.json(
        { error: "No such support session", code: "SUPPORT_SESSION_NOT_FOUND" },
        { status: 404 },
      );
    }
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}
