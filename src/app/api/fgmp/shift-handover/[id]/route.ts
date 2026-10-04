import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
import { audit } from "@/lib/fgmp/audit";
import {
  acknowledgeShiftHandoverSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertTenantOwned } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/shift-handover/[id]
 * Returns a single handover note by id. Tenant-isolated.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { id } = await ctx.params;
    const note = await db.shiftHandover.findUnique({ where: { id } });
    const denied = assertTenantOwned(note, user);
    if (denied) return denied;

    const res = NextResponse.json(note);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/fgmp/shift-handover/[id]
 * Acknowledge an OPEN handover note (incoming operator confirms receipt).
 * Body: { action: "acknowledge", acknowledgedNote?: string }
 *
 * Roles: same as POST (operators who can be on shift to receive a handover).
 * - Only OPEN notes can be acknowledged (idempotent — acknowledging an
 *   already-acknowledged note is a no-op returning the existing record).
 * - acknowledgedById / acknowledgedAt are stamped server-side from the
 *   session. An operator cannot acknowledge their own handover note
 *   (would defeat the purpose of the receipt confirmation).
 */
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, [
    ...ROLES.ALARM_OPS,
    ...ROLES.DELIVERY,
    ...ROLES.MAINTENANCE,
  ] as any);
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(acknowledgeShiftHandoverSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    const { id } = await ctx.params;
    const note = await db.shiftHandover.findUnique({ where: { id } });
    const denied = assertTenantOwned(note, user);
    if (denied) return denied;
    // assertTenantOwned() 404s a null record for every role EXCEPT super-admin
    // (which bypasses the check entirely), so a super-admin acknowledging an
    // unknown id would otherwise dereference null and 500.
    if (!note) {
      const res = NextResponse.json({ error: "Handover note not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // An operator cannot acknowledge their own handover note.
    if (note.authorId === user.id) {
      const res = NextResponse.json(
        { error: "You cannot acknowledge your own handover note" },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Idempotent: if already acknowledged, return the existing record.
    if (note.status === "ACKNOWLEDGED") {
      const res = NextResponse.json(note);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const updated = await db.shiftHandover.update({
      where: { id },
      data: {
        status: "ACKNOWLEDGED",
        acknowledgedById: user.id,
        acknowledgedAt: new Date(),
        acknowledgedNote: data.acknowledgedNote ?? null,
      },
    });

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "HANDOVER_ACK",
      entity: "ShiftHandover",
      entityId: id,
      details: {
        authorId: note.authorId,
        acknowledgedNote: data.acknowledgedNote ?? null,
      },
    });

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/fgmp/shift-handover/[id]
 * Admin-only: remove a handover note (e.g. created in error, abusive content).
 * Soft-delete is overkill for this operational record — we hard-delete.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
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
    const note = await db.shiftHandover.findUnique({ where: { id } });
    const denied = assertTenantOwned(note, user);
    if (denied) return denied;
    // Super-admin bypass in assertTenantOwned() means a missing note is not
    // caught above; 404 explicitly instead of throwing on note.authorId.
    if (!note) {
      const res = NextResponse.json({ error: "Handover note not found" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    await db.shiftHandover.delete({ where: { id } });

    await audit({
      userId: user.id,
      tenantId: user.tenantId,
      action: "HANDOVER_DELETE",
      entity: "ShiftHandover",
      entityId: id,
      details: { authorId: note.authorId, shift: note.shift },
    });

    const res = NextResponse.json({ ok: true });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
