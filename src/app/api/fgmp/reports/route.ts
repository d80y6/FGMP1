import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import { asTenant, tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { toNum } from "@/lib/fgmp/decimal";
import { errorResponse } from "@/lib/fgmp/api-error";
import { hasCapability, type Role } from "@/lib/fgmp/rbac-core";
import {
  requireAuth,
  tenantWhereOrAll,
  siteTenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap(auth.user);
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const period = searchParams.get("period") ?? "daily"; // daily|weekly|monthly|quarterly|annual

    const now = new Date();
    const from = new Date(now);
    switch (period) {
      case "daily": from.setDate(from.getDate() - 1); break;
      case "weekly": from.setDate(from.getDate() - 7); break;
      case "monthly": from.setMonth(from.getMonth() - 1); break;
      case "quarterly": from.setMonth(from.getMonth() - 3); break;
      case "annual": from.setFullYear(from.getFullYear() - 1); break;
    }

    // The generator screen also shows command history, but that does not grant
    // access to the full reports payload (which includes audit, alarm,
    // delivery, and maintenance records). For generator-only roles, perform
    // only the allowed command-history query and return only that projection.
    if (!hasCapability(me.role as Role, "view:reports")) {
      const commands = await asTenant(me, (tx) =>
        tx.controlCommand.findMany({
          where: {
            issuedAt: { gte: from },
            generator: { site: { ...tenantWhereOrAll(me) } },
          },
          include: { generator: { select: { label: true } } },
          orderBy: { issuedAt: "desc" },
          take: 500,
        }),
      );
      const res = NextResponse.json({ commands });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // All five reads move inside ONE asTenant transaction. Four of them carry
    // nested `include: { site }` / `include: { generator }` traversals, and
    // every one of those relations is RLS-protected — scoping only the outer
    // findMany would return rows with a null site behind a 200.
    const [alarms, deliveries, tickets, commands, auditLogs] = await asTenant(me, (tx) =>
      Promise.all([
      tx.alarm.findMany({ where: { createdAt: { gte: from }, ...tenantWhereOrAll(me) }, include: { site: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
      tx.fuelDelivery.findMany({ where: { scheduledAt: { gte: from }, ...siteTenantWhereOrAll(me) }, include: { site: { select: { name: true } } }, orderBy: { scheduledAt: "desc" }, take: 500 }),
      tx.maintenanceTicket.findMany({ where: { createdAt: { gte: from }, ...siteTenantWhereOrAll(me) }, include: { site: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
      tx.controlCommand.findMany({ where: { issuedAt: { gte: from }, generator: { site: { ...tenantWhereOrAll(me) } } }, include: { generator: { select: { label: true } } }, orderBy: { issuedAt: "desc" }, take: 500 }),
      tx.auditLog.findMany({ where: { createdAt: { gte: from }, ...tenantWhereOrAll(me) }, orderBy: { createdAt: "desc" }, take: 500 }),
    ]),
    );

    // Summary KPIs use the same authenticated tenant as the database reads;
    // platform role does not widen this response to customer tenants.
    const tenantId = tenantIdOrThrow(me.tenantId);
    const tenantSites = engine.sites.filter((s) => s.tenantId === tenantId);
    const tenantSiteIds = new Set(tenantSites.map((s) => s.id));
    const tenantTanks = engine.tanks.filter((t) => tenantSiteIds.has(t.siteId));
    const tenantGenerators = engine.generators.filter((g) => tenantSiteIds.has(g.siteId));

    // Summary KPIs for the report
    const totalFuel = tenantTanks.reduce((a, t) => a + t.current, 0);
    const totalCapacity = tenantTanks.reduce((a, t) => a + t.capacity, 0);
    const summary = {
      period,
      from: from.toISOString(),
      to: now.toISOString(),
      totalSites: tenantSites.length,
      totalGenerators: tenantGenerators.length,
      totalTanks: tenantTanks.length,
      totalFuelLitres: Math.round(totalFuel),
      totalCapacityLitres: Math.round(totalCapacity),
      fuelPct: totalCapacity ? Math.round((totalFuel / totalCapacity) * 1000) / 10 : 0,
      alarmsTotal: alarms.length,
      alarmsBySeverity: {
        L1: alarms.filter((a) => a.severity === "L1").length,
        L2: alarms.filter((a) => a.severity === "L2").length,
        L3: alarms.filter((a) => a.severity === "L3").length,
      },
      deliveriesTotal: deliveries.length,
      deliveriesVerified: deliveries.filter((d) => d.status === "VERIFIED").length,
      // Phase 5 task 1: volumeDeliveredLitres is Decimal(12,3). The old
      // `(d.volumeDeliveredLitres ?? 0)` was inert — `??` only fires on null or
      // undefined, and a Decimal is an object, so this was `0 + DecimalObject`,
      // yielding NaN rather than a total. toNum handles both the conversion and
      // the genuinely-absent case (a delivery not yet delivered).
      volumeDelivered: deliveries.reduce(
        (a, d) => a + toNum(d.volumeDeliveredLitres, { scale: 3 }),
        0,
      ),
      ticketsTotal: tickets.length,
      ticketsDone: tickets.filter((t) => t.status === "DONE").length,
      commandsTotal: commands.length,
      generatorsRunning: tenantGenerators.filter((g) => g.status === "RUNNING").length,
    };

    const res = NextResponse.json({ summary, alarms, deliveries, tickets, commands, auditLogs });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
