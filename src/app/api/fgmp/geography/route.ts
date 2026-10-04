import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
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
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const regions = await db.region.findMany({
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
    });

    const res = NextResponse.json(regions);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
