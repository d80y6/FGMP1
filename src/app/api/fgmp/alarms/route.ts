import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
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
  const auth = await requireAuth(req);
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

    // ── Tenant scoping ────────────────────────────────────────────────────
    // `where.tenantId` is already set above, but a WHERE alone does NOT satisfy
    // RLS: the policy's USING clause is ANDed with it and
    // current_setting('app.tenant_id') is NULL, so this returned zero rows for
    // every caller while returning HTTP 200 with an empty list — the exact
    // "no data" vs "hidden by RLS" ambiguity that made the class survivable.
    //
    // The nested `site` is RLS-protected too and resolves on the same client,
    // so it is selected WITH its tenantId and checked below. Leaving it
    // unfiltered returns alarms carrying a null site — a populated response
    // with silently wrong relations, which is worse than an empty one because
    // it looks correct.
    const alarms = await asTenant(me, async (tx) => {
      const rows = await tx.alarm.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { site: { select: { name: true, code: true, tenantId: true } } },
      });
      // Defence in depth: drop any row whose site did not resolve inside this
      // tenant rather than emitting a half-populated alarm.
      return rows.filter((a) => !a.site || a.site.tenantId === tenantIdOrThrow(me.tenantId));
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
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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
      // Tenant-scoped. `updateMany` with tenantId in the where was returning
      // count: 0 under RLS while still answering `{ ok: true }` — a mutation
      // that silently affected nothing and reported success.
      const result = await asTenant(me, (tx) =>
        tx.alarm.updateMany({
        where: { id: { in: data.alarmIds }, tenantId: tenantIdOrThrow(me.tenantId), status: { in: ["OPEN", "ESCALATED"] } },
        data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedById: user.id },
      }),
      );
      await audit({ userId: user.id, action: "BULK_ACK", entity: "alarm", details: { count: result.count, ids: data.alarmIds } });
      const res = NextResponse.json({ ok: true, count: result.count });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (data.action === "bulkResolve") {
      const result = await asTenant(me, (tx) =>
        tx.alarm.updateMany({
        where: { id: { in: data.alarmIds }, tenantId: tenantIdOrThrow(me.tenantId), status: { in: ["OPEN", "ACKNOWLEDGED", "ESCALATED"] } },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: user.id, resolution: data.resolution ?? "Bulk resolved by operator" },
      }),
      );
      await audit({ userId: user.id, action: "BULK_RESOLVE", entity: "alarm", details: { count: result.count, ids: data.alarmIds } });
      const res = NextResponse.json({ ok: true, count: result.count });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Single-alarm actions.
    const alarmId = data.alarmId;
    // Scoped in the QUERY, not filtered after the fetch: assertTenantOwned
    // compares alarm.tenantId after the row is read, and under RLS the read
    // returned null for every alarm, so the check was comparing against
    // nothing — the Phase 0 IDOR fix was inert rather than merely weak.
    // Cross-tenant and non-existent ids are both null here, so this cannot be
    // used to enumerate alarm ids.
    const alarm = await asTenant(me, (tx) =>
      tx.alarm.findFirst({ where: { id: alarmId, tenantId: me.tenantId } }),
    );
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
      // Re-assert ownership inside the writing transaction: `update` takes a
      // unique selector so tenantId cannot be part of it, and a row that changed
      // tenants between the authorising read and this write must not be touched.
      const updated = await asTenant(me, async (tx) => {
        const owned = await tx.alarm.findFirst({
          where: { id: alarmId, tenantId: me.tenantId },
          select: { id: true },
        });
        if (!owned) return null;
        return tx.alarm.update({
          where: { id: owned.id },
          data: { status: "ACKNOWLEDGED", acknowledgedAt: new Date(), acknowledgedById: user.id },
        });
      });
      if (!updated) {
        const res = NextResponse.json({ error: "Alarm not found" }, { status: 404 });
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
      await audit({ userId: user.id, action: "ACK", entity: "alarm", entityId: alarmId, details: { type: alarm.type } });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // resolve — same re-assert-ownership pattern as acknowledge above.
    const updated = await asTenant(me, async (tx) => {
      const owned = await tx.alarm.findFirst({
        where: { id: alarmId, tenantId: me.tenantId },
        select: { id: true },
      });
      if (!owned) return null;
      return tx.alarm.update({
        where: { id: owned.id },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: user.id, resolution: data.resolution ?? "Resolved by operator" },
      });
    });
    if (!updated) {
      const res = NextResponse.json({ error: "Alarm not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    await audit({ userId: user.id, action: "RESOLVE", entity: "alarm", entityId: alarmId, details: { type: alarm.type, resolution: data.resolution } });
    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
});
