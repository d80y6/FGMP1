import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import { notificationActionSchema, validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertTenantOwned, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const where: Record<string, unknown> = { ...tenantWhereOrAll(me) };
    if (status) where.status = { in: status.split(",") };
    const notifs = await asTenant(me, (tx) =>
      tx.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
    );
    const res = NextResponse.json(notifs);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, [...ROLES.NOTIFICATION, "SUPERADMIN"]);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(notificationActionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    if (data.action === "markSent") {
      // Scoped in the QUERY so the rightful tenant can actually find the row.
      // assertTenantOwned is KEPT as defence in depth — it compares
      // record.tenantId after the fetch, so it cannot work until the read is
      // scoped, but it still guards against a future where-clause regression.
      const updated = await asTenant(me, async (tx) => {
        const existing = await tx.notification.findFirst({
          where: { id: data.notificationId, tenantId: me.tenantId },
        });
        const denied = assertTenantOwned(existing, me);
        if (denied) {
          applyRateLimitHeaders(denied.headers, rl);
          return denied;
        }
        return tx.notification.update({
          where: { id: data.notificationId },
          data: { status: "SENT", sentAt: new Date() },
        });
      });
      if (updated instanceof NextResponse) return updated;
      await audit({ userId: user.id, action: "NOTIF_DISMISS", entity: "notification", entityId: data.notificationId });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // markAllSent
    const result = await asTenant(me, (tx) =>
      tx.notification.updateMany({
        where: { status: "QUEUED", ...tenantWhereOrAll(me) },
        data: { status: "SENT", sentAt: new Date() },
      }),
    );
    await audit({ userId: user.id, action: "NOTIF_DISMISS_ALL", entity: "notification", entityId: "batch" });
    const res = NextResponse.json({ updated: result.count });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
