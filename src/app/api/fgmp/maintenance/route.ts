import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/fgmp/audit";
import {
  maintenanceActionSchema,
  validateBody,
} from "@/lib/fgmp/schemas";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  MUTATION_LIMIT,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, can, assertSiteTenantOwned, siteTenantWhereOrAll } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const where: Record<string, unknown> = { ...siteTenantWhereOrAll(me) };
    if (status) where.status = { in: status.split(",") };
    const tickets = await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.maintenanceTicket.findMany({
      where,
      orderBy: [{ priority: "asc" }, { scheduledFor: "asc" }],
      take: 200,
      include: { site: { select: { name: true, code: true } }, assignedTo: { select: { name: true } } },
    }));
    const res = NextResponse.json(tickets);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ROLES.MAINTENANCE);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const rl = await rateLimitByUser(req, me.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const body = await req.json().catch(() => ({}));
    const r = validateBody(maintenanceActionSchema, body);
    if (!r.success) {
      const res = NextResponse.json(
        { error: "Validation failed", details: r.error },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const data = r.data;

    if (data.action === "complete") {
      // ── The action's own capability, not just the endpoint's ─────────────
      // `ticket:complete` is declared in the matrix and until now gated
      // NOTHING: ROLES.MAINTENANCE admitted ADMIN, REGIONAL_MANAGER and
      // FIELD_ENGINEER, and the path policy only asked for `ticket:manage`,
      // which all three hold. A role could therefore appear in the Roles table
      // without the capability and still close tickets, and — the case that
      // matters — a role could HOLD the capability, be shown the Complete
      // button, and be refused. Closing a work order is the write that retires
      // an alarm condition, so it gets the explicit check.
      //
      // Checked after validation (malformed body ⇒ 400, not 403) and before any
      // read. All three roles above now hold the capability, so no caller that
      // succeeds today starts failing; what changes is that the declaration is
      // true and the client can gate on it.
      if (!can(me, "ticket:complete")) {
        return NextResponse.json(
          { error: "Forbidden", code: "INSUFFICIENT_CAPABILITY" },
          { status: 403 },
        );
      }
      const existing = await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.maintenanceTicket.findUnique({
        where: { id: data.ticketId },
        select: { site: { select: { tenantId: true } } },
      }));
      const denied = assertSiteTenantOwned(existing?.site ?? null, me);
      if (denied) return denied;
      const updated = await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.maintenanceTicket.update({
        where: { id: data.ticketId },
        data: { status: "DONE", completedAt: new Date() },
      }));
      await audit({ userId: me.id, action: "TICKET_COMPLETE", entity: "ticket", entityId: data.ticketId });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // create — the same check for the other declared action. `ticket:create`
    // was inert for the same reason as `ticket:complete`; opening a work order
    // is lower risk but the asymmetry between "the matrix says READONLY cannot
    // create" and "the route never asked" is exactly what this pass removes.
    if (!can(me, "ticket:create")) {
      return NextResponse.json(
        { error: "Forbidden", code: "INSUFFICIENT_CAPABILITY" },
        { status: 403 },
      );
    }
    // create — verify the referenced site belongs to the caller's tenant
    const site = await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.site.findUnique({
      where: { id: data.siteId },
      select: { tenantId: true },
    }));
    const siteDenied = assertSiteTenantOwned(site, me);
    if (siteDenied) return siteDenied;
    // `site` is null when it does not exist; assertSiteTenantOwned returns
    // null (allowed) for a same-tenant site, so the null case needs its own
    // check before `site.tenantId` is read.
    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }
    const created = await withTenant(tenantIdOrThrow(me.tenantId), (tx) => tx.maintenanceTicket.create({
      data: {
        siteId: data.siteId,
        tenantId: site.tenantId,
        assetKind: data.assetKind,
        assetId: data.assetId ?? "",
        type: data.type,
        priority: data.priority,
        title: data.title,
        description: data.description,
        assignedToId: me.id,
        scheduledFor: data.scheduledFor ? new Date(data.scheduledFor) : null,
        status: "OPEN",
      },
    }));
    await audit({ userId: me.id, action: "TICKET_CREATE", entity: "ticket", entityId: created.id, details: { title: data.title } });
    const res = NextResponse.json(created);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
