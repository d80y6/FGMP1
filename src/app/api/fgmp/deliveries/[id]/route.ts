import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await params;
    // NESTED READS MATTER HERE. The `include: { site, tank }` traversal is
    // resolved on the same client and site/tank are BOTH RLS-protected, so a
    // top-level-scoped query that leaves the include unscoped still returns a
    // row with empty relations. Both are inside the tenant context, and the
    // relation filter is expressed in the query rather than checked afterwards.
    const d = await asTenant(me, (tx) =>
      tx.fuelDelivery.findFirst({
        where: { id, site: { tenantId: me.tenantId } },
        include: { site: true, tank: true },
      }),
    );
    const denied = assertSiteTenantOwned(d?.site ?? null, me);
    if (denied) return denied;
    const res = NextResponse.json(d);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
