import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
  parseIntParam,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireAuth,
  can,
  tenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/audit
 * Tenant-scoped audit log, newest first, optionally filtered by `action`.
 *
 * ── SECURITY (capability enforcement) ───────────────────────────────────────
 * The handler used a bare `requireAuth()`, which let ANY role read the audit
 * log. In the rbac matrix `view:audit` is a *deliberate* capability, not an
 * accident: `READONLY` and `NOC_OPERATOR` hold it, but `EXECUTIVE` does
 * **not** — the executive persona is scoped to KPIs, analytics and reports,
 * and the audit trail (who changed what, IP-level action history, before/
 * after payloads for settings and user changes) is deliberately withheld.
 * A bare `requireAuth()` silently granted EXECUTIVE a capability the matrix
 * says it must not have.
 *
 * We now enforce the capability itself (`can(me, "view:audit")`) rather than
 * re-stating a role list, so the matrix in rbac.ts stays the single source of
 * truth. `SUPERADMIN` holds `*` and therefore bypasses via `hasCapability`,
 * and `isSuperAdminUser` still widens the tenant scope via `tenantWhereOrAll`.
 *
 * ── CORRECTNESS (limit/offset parsing) ──────────────────────────────────────
 * `Math.min(500, Number(x))` returns NaN for `?limit=abc`, and NaN passed to
 * Prisma's `take` throws → a 500 on malformed client input instead of a
 * clean fallback. It also had no lower bound. Both now go through
 * `parseIntParam`, which always yields an integer inside `[min, max]`.
 *
 * Query params:
 *   - action : exact-match filter on the audit action
 *   - limit  : default 200, max 500
 *   - offset : default 0, max 1_000_000
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;

  // Capability gate — mirrors rbac.ts ROLE_PERMISSIONS.
  if (!can(me, "view:audit")) {
    return NextResponse.json(
      {
        error: "Forbidden",
        code: "INSUFFICIENT_CAPABILITY",
        required: "view:audit",
      },
      { status: 403 },
    );
  }

  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action");
    const limit = parseIntParam(searchParams.get("limit"), {
      min: 1,
      max: 500,
      fallback: 200,
    });
    const offset = parseIntParam(searchParams.get("offset"), {
      min: 0,
      max: 1_000_000,
      fallback: 0,
    });
    const where: Record<string, unknown> = { ...tenantWhereOrAll(me) };
    if (action) where.action = action;
    // AuditLog is one of the 24 FORCE-RLS-protected tables, so this read must
    // carry the caller's tenant context. Previously it ran unscoped and
    // returned [] for every request.
    const logs = await asTenant(me, (tx) =>
      tx.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: { user: { select: { name: true, role: true } } },
      }),
    );
    const res = NextResponse.json(logs.map((l) => ({ ...l, details: tryParse(l.details) })));
    res.headers.set("X-Limit", String(limit));
    res.headers.set("X-Offset", String(offset));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

function tryParse(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}
