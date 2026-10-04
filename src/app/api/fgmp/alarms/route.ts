import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  alarmActionSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireAuth,
  requireRole,
  ROLES,
  assertTenantOwned,
} from "@/lib/fgmp/auth-helpers";
import { withMetrics } from "@/lib/fgmp/with-metrics";

export const dynamic = "force-dynamic";

export const GET = withMetrics(async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
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
    const severity = searchParams.get("severity");
    const type = searchParams.get("type");
    const siteId = searchParams.get("siteId");
    const limit = Math.min(500, Number(searchParams.get("limit") ?? 200));

    const where: Record<string, unknown> = {};
    where.tenantId = me.tenantId;
    if (status) where.status = { in: status.split(",") };
    if (severity) where.severity = { in: severity.split(",") };
    if (type) where.type = { in: type.split(",") };
    if (siteId) where.siteId = siteId;

    const alarms = await db.alarm.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { site: { select: { name: true, code: true } } },
    });
    const res = NextResponse.json(alarms);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
});

export const POST = withMetrics(async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ALARM_OPS);
  if (auth.error) return auth.error;
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
    const r = validateBody(alarmActionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    // Bulk actions.
    if (data.action === "bulkAcknowledge") {
      const result = await db.alarm.updateMany({
        where: { id: { in: data.alarmIds }, tenantId: me.tenantId, status: { in: ["OPEN", "ESCALATED"] } },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedById: user.id },
      });
      await audit({ userId: user.id, action: "BULK_ACK", entity: "alarm", details: { count: result.count, ids: data.alarmIds } });
      const res = NextResponse.json({ ok: true, count: result.count });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (data.action === "bulkResolve") {
      const result = await db.alarm.updateMany({
        where: { id: { in: data.alarmIds }, tenantId: me.tenantId, status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: user.id, resolution: data.resolution ?? "Bulk resolved by operator" },
      });
      await audit({ userId: user.id, action: "BULK_RESOLVE", entity: "alarm", details: { count: result.count, ids: data.alarmIds } });
      const res = NextResponse.json({ ok: true, count: result.count });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Single-alarm actions.
    const alarmId = data.alarmId;
    const alarm = await db.alarm.findUnique({ where: { id: alarmId } });
    const denied = assertTenantOwned(alarm, me);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    // assertTenantOwned() 404s a null record for every role EXCEPT super-admin
    // (which bypasses the check entirely), so a super-admin acking/ing an
    // unknown alarmId would otherwise dereference null and 500.
    if (!alarm) {
      const res = NextResponse.json({ error: "Alarm not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    if (data.action === "acknowledge") {
      const updated = await db.alarm.update({
        where: { id: alarmId },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedById: user.id },
      });
      await audit({ userId: user.id, action: "ACK", entity: "alarm", entityId: alarmId, details: { type: alarm.type } });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // resolve
    const updated = await db.alarm.update({
      where: { id: alarmId },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: user.id, resolution: data.resolution ?? "Resolved by operator" },
    });
    await audit({ userId: user.id, action: "RESOLVE", entity: "alarm", entityId: alarmId, details: { type: alarm.type, resolution: data.resolution } });
    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
});
