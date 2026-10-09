import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";
import { withMetrics } from "@/lib/fgmp/with-metrics";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

export const GET = withMetrics(async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // Tenant isolation (Task TI-2c): SUPERADMIN gets the global cross-tenant
    // snapshot (tenantId === null); every other role gets only their own
    // tenant's sites/tanks/generators/batteries/events/transactions/...
    const snap = await engine.snapshotForTenant(
      isSuperAdminUser(me) ? null : tenantIdOrThrow(me.tenantId),
    );
    const res = NextResponse.json(snap);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
});
