import { NextRequest, NextResponse } from "next/server";
import { db, bootstrap } from "@/lib/fgmp";
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
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, requireRole, ROLES, assertSiteTenantOwned, siteTenantWhereOrAll } from "@/lib/fgmp/auth-helpers";

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
    const where: Record<string, unknown> = { ...siteTenantWhereOrAll(me) };
    if (status) where.status = { in: status.split(",") };
    const tickets = await db.maintenanceTicket.findMany({
      where,
      orderBy: [{ priority: "asc" }, { scheduledFor: "asc" }],
      take: 200,
      include: { site: { select: { name: true, code: true } }, assignedTo: { select: { name: true } } },
    });
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
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, MUTATION_LIMIT.limit, MUTATION_LIMIT.windowMs);
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
      const existing = await db.maintenanceTicket.findUnique({
        where: { id: data.ticketId },
        select: { site: { select: { tenantId: true } } },
      });
      const denied = assertSiteTenantOwned(existing?.site ?? null, me);
      if (denied) return denied;
      const updated = await db.maintenanceTicket.update({
        where: { id: data.ticketId },
        data: { status: "DONE", completedAt: new Date() },
      });
      await audit({ userId: user.id, action: "TICKET_COMPLETE", entity: "ticket", entityId: data.ticketId });
      const res = NextResponse.json(updated);
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    // create — verify the referenced site belongs to the caller's tenant
    const site = await db.site.findUnique({
      where: { id: data.siteId },
      select: { tenantId: true },
    });
    const siteDenied = assertSiteTenantOwned(site, me);
    if (siteDenied) return siteDenied;
    // `site` is null when it does not exist; assertSiteTenantOwned returns
    // null (allowed) for a same-tenant site, so the null case needs its own
    // check before `site.tenantId` is read.
    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }
    const created = await db.maintenanceTicket.create({
      data: {
        siteId: data.siteId,
        tenantId: site.tenantId,
        assetKind: data.assetKind,
        assetId: data.assetId ?? "",
        type: data.type,
        priority: data.priority,
        title: data.title,
        description: data.description,
        assignedToId: user.id,
        scheduledFor: data.scheduledFor ? new Date(data.scheduledFor) : null,
        status: "OPEN",
      },
    });
    await audit({ userId: user.id, action: "TICKET_CREATE", entity: "ticket", entityId: created.id, details: { title: data.title } });
    const res = NextResponse.json(created);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
