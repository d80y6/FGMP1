import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { bootstrap } from "@/lib/fgmp";
import { validateBody } from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, ApiError } from "@/lib/fgmp/api-error";
import { requireRole, ROLES, assertSiteTenantOwned } from "@/lib/fgmp/auth-helpers";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { emitToRealtime } from "@/lib/fgmp/realtime-emitter";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/maintenance/[id]/assign — explicit assign transition.
 *
 * Assigns a maintenance ticket to a user. The assignee must be an active
 * user with role ADMIN, REGIONAL_MANAGER, or FIELD_ENGINEER.
 *
 * Side-effect on status: if the ticket is currently OPEN, it is also
 * flipped to SCHEDULED (assignment implies the work is now scheduled for
 * that engineer). Tickets already in SCHEDULED / IN_PROGRESS keep their
 * current status (only the assignee changes). DONE / CANCELLED tickets
 * are rejected with 409.
 *
 * Roles: ADMIN, REGIONAL_MANAGER, FIELD_ENGINEER (ROLES.MAINTENANCE).
 *
 * Rate-limited at MUTATION_LIMIT. Audited as TICKET_ASSIGN with the
 * previous + new assignee + status transition. Emits a
 * `maintenance:update` realtime event so subscribed browsers refresh.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 * The assignee lookup validated role + active but NOT `assignee.tenantId`, so
 * any tenant's admin could attach a ticket to a user of ANOTHER tenant
 * (leaking the assignee's name through the ticket response and the audit
 * details, and cross-tenant-corrupting the assignment graph). `tenantId` is
 * now selected and checked; a cross-tenant assignee returns **404**, not 403,
 * so the route does not confirm that the user id exists elsewhere.
 *
 * `assignSchema` validated `assigneeId` against `/^c[a-z0-9]{24}$/i` — but
 * every seeded user id looks like `u-admin-1` / `u-noc-1` / `u-fe-1`
 * (see src/lib/fgmp/seed.ts), so assignment to ANY real user failed with 400.
 * The pattern is relaxed to an opaque-id shape check; the authoritative check
 * is still the database lookup below.
 *
 * The status guard is applied as a CONDITIONAL write (`updateMany` with the
 * allowed source statuses in the WHERE clause) rather than a read-then-write,
 * so two concurrent assignments cannot both pass the check. A count of 0
 * means somebody else won the race → 409.
 *
 * This endpoint is ADDITIVE — the existing POST /api/fgmp/maintenance
 * (action: "create" | "complete") and the generic PUT on
 * /api/fgmp/maintenance/[id] are untouched.
 */
const assigneeIdSchema = z
  .string()
  .trim()
  .min(1, "assigneeId is required")
  .max(64, "assigneeId must be at most 64 characters")
  // Opaque, path-safe id. NOT a cuid: the seeded users use `u-*-N` ids and a
  // cuid regex rejected every one of them with 400.
  .regex(/^[A-Za-z0-9._:-]+$/, "assigneeId contains unsupported characters");

const assignSchema = z.object({ assigneeId: assigneeIdSchema });

const ASSIGNABLE_ROLES = ["ADMIN", "REGIONAL_MANAGER", "FIELD_ENGINEER"];

/** Statuses a ticket may be assigned FROM. Anything else → 409. */
const ASSIGNABLE_FROM = ["OPEN", "SCHEDULED", "IN_PROGRESS"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireRole(req, ROLES.MAINTENANCE);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(
      req,
      user.id,
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
    const body = await req.json().catch(() => ({}));
    const r = validateBody(assignSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    const ticket = await withTenant(me.tenantId, (tx) => tx.maintenanceTicket.findUnique({
      where: { id },
      select: { id: true, status: true, siteId: true, assignedToId: true, site: { select: { tenantId: true } } },
    }));
    if (!ticket) throw new ApiError(404, "ticket not found");
    const tenantDenied = assertSiteTenantOwned(ticket.site, me);
    if (tenantDenied) return tenantDenied;
    if (!ASSIGNABLE_FROM.includes(ticket.status)) {
      throw new ApiError(
        409,
        `Ticket cannot be reassigned from terminal status ${ticket.status}`,
        { currentStatus: ticket.status, allowedFrom: ASSIGNABLE_FROM },
      );
    }

    // Validate assignee exists + is active + same tenant + has an assignable
    // role. `tenantId` MUST be selected for the cross-tenant check below.
    const assignee = await withTenant(me.tenantId, (tx) => tx.user.findUnique({
      where: { id: data.assigneeId },
      select: { id: true, role: true, active: true, name: true, tenantId: true },
    }));
    // 404 (not 403) for missing OR cross-tenant — a 403 would confirm the id
    // exists in some other tenant.
    if (!assignee || assignee.tenantId !== me.tenantId) {
      throw new ApiError(404, "assignee not found");
    }
    if (!assignee.active) {
      throw new ApiError(409, `assignee ${assignee.name} is not active`);
    }
    if (!ASSIGNABLE_ROLES.includes(assignee.role)) {
      throw new ApiError(
        409,
        `assignee role ${assignee.role} is not assignable (must be FIELD_ENGINEER, REGIONAL_MANAGER, or ADMIN)`,
        { role: assignee.role, assignable: ASSIGNABLE_ROLES },
      );
    }

    // If current status is OPEN, also flip to SCHEDULED (assignment implies
    // the work is now scheduled for that engineer). Otherwise preserve status.
    const newStatus = ticket.status === "OPEN" ? "SCHEDULED" : ticket.status;

    // Conditional write. Because `newStatus` is DERIVED from the status we read
    // (OPEN → SCHEDULED, everything else preserved), this must be a strict
    // compare-and-swap on the exact expected status — an `in: ASSIGNABLE_FROM`
    // predicate would still match a ticket a concurrent `/progress` had just
    // moved OPEN → IN_PROGRESS and would regress it back to SCHEDULED. A count
    // of 0 means somebody else moved it first → 409, client retries.
    const updated = await withTenant(me.tenantId, async (tx) => {
      const { count } = await tx.maintenanceTicket.updateMany({
        where: { id, status: ticket.status },
        data: { assignedToId: data.assigneeId, status: newStatus },
      });
      if (count === 0) {
        throw new ApiError(
          409,
          "Ticket status changed concurrently — reload and retry",
          { allowedFrom: ASSIGNABLE_FROM },
        );
      }
      await tx.auditLog.create({
        data: {
          tenantId: ticket.site.tenantId,
          userId: user.id,
          action: "TICKET_ASSIGN",
          entity: "ticket",
          entityId: id,
          details: JSON.stringify({
            assigneeId: data.assigneeId,
            assigneeName: assignee.name,
            previousAssigneeId: ticket.assignedToId ?? null,
            statusFrom: ticket.status,
            statusTo: newStatus,
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
