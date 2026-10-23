import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { withMetrics } from "@/lib/fgmp/with-metrics";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

export const GET = withMetrics(async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const me = auth.user;
  try {
    // `requireAuth()` already resolved this request's session. Do not perform
    // an all-tenant engine bootstrap on every browser state refresh.
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // Platform operators are scoped to their own platform tenant just like
    // other sessions. Cross-tenant customer content is available only through
    // the explicit, audited support-session surface.
    const snap = await engine.snapshotForTenant(tenantIdOrThrow(me.tenantId));
    const res = NextResponse.json(snap);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
});
