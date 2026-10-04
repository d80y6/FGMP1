import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { requireRole, ROLES, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/api-keys/stats
 * Aggregate counts for the API Keys admin KPI strip. All counts are scoped to
 * the current tenant. ADMIN-only.
 *
 *   total         — every key row for this tenant
 *   active        — revokedAt is null AND (expiresAt is null OR > now)
 *   revoked       — revokedAt is not null
 *   expired       — revokedAt is null AND expiresAt <= now
 *   expiringSoon  — revokedAt is null AND expiresAt > now AND <= now+7d
 *
 * Wrapped in try/catch + rate-limited at READ_LIMIT.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ROLES.SUPER_OR_ADMIN);
  if ("error" in auth) return auth.error;
  try {
    await bootstrap();
    const me = auth.user;
    const rl = rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 86_400_000);

    // Tenant isolation: super-admin sees keys across all tenants; tenant
    // admins see only their own. (Local var renamed to avoid shadowing the
    // auth-helpers `tenantWhere` export.)
    const tenantFilter = tenantWhereOrAll(me);

    const [total, active, revoked, expired, expiringSoon] = await Promise.all([
      db.apiKey.count({ where: tenantFilter }),
      db.apiKey.count({
        where: {
          ...tenantFilter,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      }),
      db.apiKey.count({
        where: { ...tenantFilter, revokedAt: { not: null } },
      }),
      db.apiKey.count({
        where: {
          ...tenantFilter,
          revokedAt: null,
          expiresAt: { not: null, lte: now },
        },
      }),
      db.apiKey.count({
        where: {
          ...tenantFilter,
          revokedAt: null,
          expiresAt: { not: null, gt: now, lte: sevenDaysFromNow },
        },
      }),
    ]);

    const body = { total, active, revoked, expired, expiringSoon };
    const res = NextResponse.json(body);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
