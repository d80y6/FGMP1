import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

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
    // Tenant-scoped: `Alarm` is FORCE-RLS protected, so this unscoped read
    // returned null for EVERY alarm and the assertTenantOwned check below was
    // comparing against nothing — the Phase 0 IDOR fix was inert rather than
    // merely weak. Scoping in the query also makes a cross-tenant id
    // indistinguishable from a non-existent one, so this cannot be used to
    // enumerate alarm ids.
    // The nested `site` relation is RLS-protected too, and Prisma resolves it
    // on this same client. Leaving it unfiltered returns the alarm with a NULL
    // site — a populated response with silently wrong relations, which is
    // WORSE than the original empty result because it looks correct.
    const alarm = await asTenant(user.tenantId, async (tx) => {
      const row = await tx.alarm.findFirst({
        where: { id, tenantId: user.tenantId },
        select: {
          id: true,
          type: true,
          severity: true,
          status: true,
          message: true,
          createdAt: true,
          acknowledgedAt: true,
          resolvedAt: true,
          value: true,
          threshold: true,
          entityKind: true,
          entityId: true,
          // Only a site belonging to the SAME tenant may be attached.
          site: {
            select: { id: true, name: true, code: true, tenantId: true },
          },
        },
      });
      if (!row) return null;
      // Defence in depth: if the relation did not resolve within this tenant,
      // do not return a half-populated alarm. A populated response with a null
      // or foreign site is worse than an empty one, because it looks correct.
      if (!row.site || row.site.tenantId !== user.tenantId) return null;
      return { ...row, tenantId: user.tenantId };
    });
    const denied = assertTenantOwned(alarm, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    const res = NextResponse.json(alarm);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
