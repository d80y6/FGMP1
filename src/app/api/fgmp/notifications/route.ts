import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
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
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const where: Record<string, unknown> = { ...tenantWhereOrAll(me) };
    if (status) where.status = { in: status.split(",") };
    const notifs = await db.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 });
    const res = NextResponse.json(notifs);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, [...ROLES.NOTIFICATION, "SUPERADMIN"] as any);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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
      const existing = await db.notification.findUnique({ where: { id: data.notificationId } });
      const denied = assertTenantOwned(existing, me);
      if (denied) {
        applyRateLimitHeaders(denied.headers, rl);
        return denied;
      }
      const updated = await db.notification.update({
        where: { id: data.notificationId },
        data: { status: "SENT", sentAt: new Date() },
      });
      await audit({ userId: user.id, action: "NOTIF_DISMISS", entity: "notification", entityId: data.notificationId });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // markAllSent
    const result = await db.notification.updateMany({
      where: { status: "QUEUED", ...tenantWhereOrAll(me) },
      data: { status: "SENT", sentAt: new Date() },
    });
    await audit({ userId: user.id, action: "NOTIF_DISMISS_ALL", entity: "notification", entityId: "batch" });
    const res = NextResponse.json({ updated: result.count });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
