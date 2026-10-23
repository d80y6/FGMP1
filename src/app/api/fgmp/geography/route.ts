import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/geography
 * Returns the full region → governorate → district hierarchy with site counts
 * at each level. Sorted by name ASC at every level for stable rendering.
 *
 * Response shape:
 *   [
 *     {
 *       id, name, tenantId, createdAt,
 *       governorates: [
 *         {
 *           id, name, createdAt,
 *           districts: [
 *             { id, name, createdAt, _count: { sites: N } }
 *           ],
 *           _count: { sites: N }
 *         }
 *       ],
 *       _count: { sites: N, governorates: N }
 *     }
 *   ]
 *
 * Any authenticated session may read the hierarchy — ADMIN-only mutations
 * are enforced on the sub-resource POST/PATCH/DELETE routes.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // ── Tenant scoping ────────────────────────────────────────────────────
    // `tenantWhereOrAll` builds a WHERE object, but a WHERE alone does NOT
    // satisfy RLS: the policy's USING clause is ANDed with it and
    // current_setting('app.tenant_id') is NULL, so this returned zero rows for
    // every caller. The filter is kept — it still denies an unfiltered
    // non-superadmin view — but the transaction context is what makes the rows
    // exist at all.
    //
    // The nested `governorates.districts._count.sites` also resolve on this
    // client, so they were reporting 0 sites for a fully populated region.
    const regions = await asTenant(user, (tx) =>
      tx.region.findMany({
        where: tenantWhereOrAll(user),
        orderBy: { name: "asc" },
        include: {
          governorates: {
            orderBy: { name: "asc" },
            include: {
              districts: {
                orderBy: { name: "asc" },
                include: { _count: { select: { sites: true } } },
              },
              _count: { select: { sites: true } },
            },
          },
          _count: { select: { sites: true, governorates: true } },
        },
      }),
    );

    const res = NextResponse.json(regions);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
