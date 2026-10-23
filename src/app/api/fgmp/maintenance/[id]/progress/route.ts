import type { TicketStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, ApiError } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { emitToRealtime } from "@/lib/fgmp/realtime-emitter";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/maintenance/[id]/progress — explicit IN_PROGRESS transition.
 *
 * Transitions a maintenance ticket from OPEN or SCHEDULED to IN_PROGRESS,
 * signaling that the field engineer has started the actual work. Optionally
 * accepts a `scheduledFor` ISO timestamp to update the planned start.
 *
 * Rejected with 409 if the ticket is already IN_PROGRESS or in a terminal
 * status (DONE / CANCELLED).
 *
 * Roles: ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER (ROLES.MAINTENANCE).
 *
 * Rate-limited at MUTATION_LIMIT. Audited as TICKET_STATUS_CHANGE with
 * `{ from, to: "IN_PROGRESS" }` details. Emits a `maintenance:update`
 * realtime event so subscribed browsers refresh.
 *
 * ── CONCURRENCY (TOCTOU) ───────────────────────────────────────────────────
 * The guard used to be a `findUnique` status check followed by an
 * unconditional `update`. Between the two statements another request (a
 * concurrent `/complete`, `/cancel`, or `/assign`) could move the ticket, and
 * this handler would then happily overwrite a terminal status with
 * IN_PROGRESS — resurrecting a DONE / CANCELLED ticket. The guard is now the
 * WHERE clause of a conditional `updateMany`, so the check and the write are
 * one atomic statement; `count === 0` means the race was lost → 409.
 * The ticket update and its audit row are written in one `withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.$transaction`.
 *
 * This endpoint is ADDITIVE — the existing POST /api/fgmp/maintenance
 * (action: "create" | "complete")) and the generic PUT on
 * /api/fgmp/maintenance/[id] are untouched.
 */
const progressSchema = z
  .object({
    scheduledFor: z
      .string()
      .datetime({ offset: true })
      .optional()
      .or(z.string().min(1).max(40).optional()),
  })
  .optional()
  .default({});

/** Statuses a ticket may be started FROM. Anything else → 409. */
const PROGRESS_FROM: TicketStatus[] = ["OPEN", "SCHEDULED"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.MAINTENANCE);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(
      req,
      me.id,
      MUTATION_LIMIT.limit,
      MUTATION_LIMIT.windowMs,
    );
    if (!rl.success) {
      const res = NextResponse.json(
        { error: "Too many requests" },
        { status: 429 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const { id } = await params;
    // Body is optional — accept empty body so a plain `POST /progress` works.
    const body = await req.json().catch(() => ({}));
    const r = validateBody(progressSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    const ticket = await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.maintenanceTicket.findUnique({
      where: { id },
      select: { id: true, status: true, siteId: true, site: { select: { tenantId: true } } },
    }));
    if (!ticket) throw new ApiError(404, "ticket not found");
    const tenantDenied = assertSiteTenantOwned(ticket.site, me);
    if (tenantDenied) return tenantDenied;
    if (!PROGRESS_FROM.includes(ticket.status)) {
      throw new ApiError(
        409,
        `Ticket cannot be started from status ${ticket.status}`,
        { currentStatus: ticket.status, allowedFrom: PROGRESS_FROM },
      );
    }

    const update: Record<string, unknown> = { status: "IN_PROGRESS" };
    if (data?.scheduledFor) {
      update.scheduledFor = new Date(data.scheduledFor);
    }

    // Conditional write — the allowed source statuses live in the WHERE clause
    // so the guard and the mutation cannot interleave with another transition.
    const updated = await withTenant(tenantIdOrThrow(me.tenantId), async (tx) => {
      const { count } = await tx.maintenanceTicket.updateMany({
        where: { id, status: { in: PROGRESS_FROM } },
        data: update,
      });
      if (count === 0) {
        throw new ApiError(
          409,
          "Ticket status changed concurrently — reload and retry",
          { allowedFrom: PROGRESS_FROM },
        );
      }
      await tx.auditLog.create({
        data: {
          tenantId: ticket.site.tenantId,
          userId: me.id,
          action: "TICKET_STATUS_CHANGE",
          entity: "ticket",
          entityId: id,
          details: JSON.stringify({
            from: ticket.status,
            to: "IN_PROGRESS",
            scheduledFor: data?.scheduledFor ?? null,
          }),
        },
      });
      return tx.maintenanceTicket.findUnique({ where: { id } });
    });
    if (!updated) throw new ApiError(404, "ticket not found");

    try {
      emitToRealtime(
        "maintenance:update",
        { id: updated.id, siteId: updated.siteId, status: updated.status },
        updated.siteId ? `site:${updated.siteId}` : undefined,
      );
    } catch {
      /* best-effort — polling fallback covers freshness */
    }

    const res = NextResponse.json(updated);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
