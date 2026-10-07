import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import { asTenant } from "@/lib/fgmp/route-tenant";
import { audit } from "@/lib/fgmp/audit";
import {
  createSuppressionSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, tenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import { invalidateSuppressionCache } from "@/lib/fgmp/suppression-check";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/suppressions
 * Returns all suppressions (active + expired), sorted by endsAt DESC.
 * Includes the related Site (name, code) and User (name) so the UI can
 * render the cards without a second round-trip.
 *
 * Any authenticated session may list suppressions — the role-sensitive
 * mutations below (POST/PATCH/DELETE) are still enforced server-side.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const suppressions = await asTenant(user, (tx) =>
      tx.alarmSuppression.findMany({
      where: tenantWhereOrAll(user),
      orderBy: { endsAt: "desc" },
      take: 200,
      include: {
        site: { select: { id: true, name: true, code: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    }));

    const res = NextResponse.json(suppressions);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/fgmp/suppressions
 * Create a new suppression rule.
 * Roles: ADMIN, NOC_OPERATOR, REGIONAL_MANAGER (ROLES.ALARM_OPS).
 *
 * Body is validated with createSuppressionSchema. createdBy and tenantId
 * are stamped from the authenticated session, NOT from the body, so a
 * client cannot impersonate another user / tenant.
 *
 * Server-side guards beyond the zod schema:
 *   - endsAt must be strictly later than startsAt.
 *   - siteId (if provided) must exist in the same tenant.
 *   - alarmType is free-form but capped at 60 chars by the DB column.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.ALARM_OPS);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(createSuppressionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    const startsAt = data.startsAt instanceof Date ? data.startsAt : new Date(data.startsAt);
    const endsAt = data.endsAt instanceof Date ? data.endsAt : new Date(data.endsAt);
    if (!isFinite(startsAt.getTime()) || !isFinite(endsAt.getTime())) {
      const res = NextResponse.json(
        { error: "Invalid date format for startsAt/endsAt" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      const res = NextResponse.json(
        { error: "endsAt must be later than startsAt" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // If siteId is supplied, ensure it belongs to the same tenant.
    // Declared in the outer scope because the create below is scoped to
    // `site.tenantId` once verified — declaring it inside the `if` left the
    // later reference unbound.
    //
    // `verifiedSiteTenantId` is DELETED, not rewritten. It was assigned from
    // `site.tenantId` where `site` came from a query already scoped to
    // `user.tenantId`, so it was always equal to the caller's own tenant and
    // gated nothing — and the row itself was written with `user.tenantId`
    // regardless, so the variable controlled the transaction CONTEXT while the
    // data used the session. That inconsistency is the whole reason the helper
    // now takes the user: there is no longer a way to pass a context that is
    // not literally the caller's.
    //
    // The site check remains and is still required — it is what rejects a
    // cross-tenant siteId, not the tenant it would have been written under.
    const requestedSiteId = data.siteId;
    if (requestedSiteId) {
      const site = await asTenant(user, (tx) =>
        tx.site.findFirst({
          where: { id: requestedSiteId, tenantId: user.tenantId },
          select: { id: true, tenantId: true },
        }),
      );
      if (!site || site.tenantId !== user.tenantId) {
        const res = NextResponse.json(
          { error: "Site not found in your tenant" },
          { status: 404 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
    }

    // Truncate alarmType to a reasonable length so a stray client can't
    // blow up the column (SQLite is permissive, but the UI shows it).
    const alarmType = data.alarmType ? data.alarmType.slice(0, 60) : null;

    const created = await asTenant(user, (tx) =>
      tx.alarmSuppression.create({
      data: {
        tenantId: user.tenantId,
        siteId: data.siteId ?? null,
        alarmType,
        reason: data.reason,
        createdBy: user.id,
        startsAt,
        endsAt,
        isActive: true,
      },
      include: {
        site: { select: { id: true, name: true, code: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    }));

    // Invalidate the matcher cache so the engine picks up the new rule
    // immediately on the next raiseAlarm() call (no 30s lag).
    invalidateSuppressionCache();

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "SUPPRESSION_CREATE",
      entity: "AlarmSuppression",
      entityId: created.id,
      details: {
        siteId: data.siteId ?? null,
        alarmType,
        reason: data.reason,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      },
    });

    const res = NextResponse.json(created, { status: 201 });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
