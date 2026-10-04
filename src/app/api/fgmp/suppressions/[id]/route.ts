import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  updateSuppressionSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertTenantOwned } from "@/lib/fgmp/auth-helpers";
import { invalidateSuppressionCache } from "@/lib/fgmp/suppression-check";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/fgmp/suppressions/[id]
 * Update a suppression rule. Two operations are supported:
 *   - { endsAt: <new ISO date> }  → extend the maintenance window.
 *   - { isActive: false }         → cancel the suppression early.
 *
 * Both fields may be supplied together (e.g. extend + reactivate).
 * At least one field must be present — empty bodies are rejected.
 *
 * Roles: ADMIN, NOC_OPERATOR, REGIONAL_MANAGER (ROLES.ALARM_OPS).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ALARM_OPS);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const r = validateBody(updateSuppressionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    if (data.endsAt === undefined && data.isActive === undefined) {
      const res = NextResponse.json(
        { error: "Supply at least one of: endsAt, isActive" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const existing = await db.alarmSuppression.findUnique({
      where: { id },
      select: { id: true, tenantId: true, startsAt: true, endsAt: true, isActive: true },
    });
    const denied = assertTenantOwned(existing, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json(
        { error: "Suppression not found" },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const update: Record<string, unknown> = {};
    if (data.endsAt !== undefined) {
      const endsAt = data.endsAt instanceof Date ? data.endsAt : new Date(data.endsAt);
      if (!isFinite(endsAt.getTime())) {
        const res = NextResponse.json(
          { error: "Invalid date format for endsAt" },
          { status: 400 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
      // Allow endsAt to be moved forward OR backward, but never before startsAt.
      if (endsAt.getTime() <= existing.startsAt.getTime()) {
        const res = NextResponse.json(
          { error: "endsAt must be later than startsAt" },
          { status: 400 },
        );
        applyRateLimitHeaders(res.headers, rl);
        return res;
      }
      update.endsAt = endsAt;
    }
    if (data.isActive !== undefined) {
      update.isActive = data.isActive;
    }

    const updated = await db.alarmSuppression.update({
      where: { id },
      data: update,
      include: {
        site: { select: { id: true, name: true, code: true } },
        user: { select: { id: true, name: true, email: true } },
      },
    });

    invalidateSuppressionCache();

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "SUPPRESSION_UPDATE",
      entity: "AlarmSuppression",
      entityId: id,
      details: update,
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/suppressions/[id]
 * Hard-delete a suppression rule.
 *
 * ADMIN-only. Use PATCH { isActive: false } for non-admins to cancel.
 * Hard-delete is reserved for admins cleaning up test/duplicate rows;
 * the audit log retains a record of the action for traceability.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(req, ROLES.ADMIN_ONLY);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await ctx.params;
    const existing = await db.alarmSuppression.findUnique({
      where: { id },
      select: { id: true, tenantId: true, reason: true, siteId: true, alarmType: true },
    });
    const denied = assertTenantOwned(existing, user);
    if (denied) {
      applyRateLimitHeaders(denied.headers, rl);
      return denied;
    }
    if (!existing) {
      const res = NextResponse.json(
        { error: "Suppression not found" },
        { status: 404 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await db.alarmSuppression.delete({ where: { id } });

    invalidateSuppressionCache();

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "SUPPRESSION_DELETE",
      entity: "AlarmSuppression",
      entityId: id,
      details: {
        reason: existing.reason,
        siteId: existing.siteId,
        alarmType: existing.alarmType,
      },
    });

    const res = NextResponse.json({ ok: true, id });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
