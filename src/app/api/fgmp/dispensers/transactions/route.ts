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
import { decimalsToJson } from "@/lib/fgmp/decimal";
import { requireAuth, siteTenantWhere } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/dispensers/transactions
 * Returns fueling transactions with optional filters + pagination.
 *
 * Query params (all optional):
 *   - dispenserId : filter by dispenser
 *   - siteId      : filter by site
 *   - status      : COMPLETED | IN_PROGRESS | CANCELLED | FAILED (comma list ok)
 *   - from        : ISO datetime (inclusive)
 *   - to          : ISO datetime (inclusive)
 *   - limit       : default 200, max 1000
 *   - offset      : default 0
 *
 * Ordered by startedAt DESC. Includes the related dispenser (label) and
 * site (name, code) so the transactions table can render without a second
 * round-trip.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const dispenserId = searchParams.get("dispenserId");
    const siteId = searchParams.get("siteId");
    const status = searchParams.get("status");
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    // parseIntParam: `Math.min/max` + `Number()` produced NaN for junk input
    // ("abc") which Prisma rejects with a 500, and had no floor on `limit`.
    const limit = parseIntParam(searchParams.get("limit"), {
      min: 1,
      max: 1000,
      fallback: 200,
    });
    const offset = parseIntParam(searchParams.get("offset"), {
      min: 0,
      max: 1_000_000,
      fallback: 0,
    });

    const where: Record<string, unknown> = { ...siteTenantWhere(user) };
    if (dispenserId) where.dispenserId = dispenserId;
    if (siteId) where.siteId = siteId;
    if (status) where.status = { in: status.split(",").map((s) => s.trim()).filter(Boolean) };
    if (from || to) {
      const r: Record<string, Date> = {};
      if (from) r.gte = new Date(from);
      if (to) r.lte = new Date(to);
      where.startedAt = r;
    }

    // Both reads inside one transaction. The nested `dispenser` and `site`
    // includes are themselves RLS-protected, so scoping only the outer
    // findMany would return transactions with null relations behind a 200.
    const [rows, total] = await asTenant(me, (tx) =>
      Promise.all([
      tx.fuelTransaction.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          dispenser: { select: { id: true, label: true, espDeviceId: true } },
          site: { select: { id: true, name: true, code: true } },
        },
      }),
      tx.fuelTransaction.count({ where }),
    ]),
    );

    // Prisma Decimal columns serialize to JSON strings by default. Keep the
    // client contract numeric (volumeLitres is formatted with toFixed there).
    const res = NextResponse.json(decimalsToJson({ rows, total, limit, offset }));
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
