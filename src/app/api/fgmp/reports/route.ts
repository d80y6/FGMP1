import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  requireAuth,
  isSuperAdminUser,
  tenantWhereOrAll,
  siteTenantWhereOrAll,
} from "@/lib/fgmp/auth-helpers";

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

    const [alarms, deliveries, tickets, commands, auditLogs] = await Promise.all([
      db.alarm.findMany({ where: { createdAt: { gte: from }, ...tenantWhereOrAll(me) }, include: { site: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
      db.fuelDelivery.findMany({ where: { scheduledAt: { gte: from }, ...siteTenantWhereOrAll(me) }, include: { site: { select: { name: true } } }, orderBy: { scheduledAt: "desc" }, take: 500 }),
      db.maintenanceTicket.findMany({ where: { createdAt: { gte: from }, ...siteTenantWhereOrAll(me) }, include: { site: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
      db.controlCommand.findMany({ where: { issuedAt: { gte: from }, generator: { site: { ...tenantWhereOrAll(me) } } }, include: { generator: { select: { label: true } } }, orderBy: { issuedAt: "desc" }, take: 500 }),
      db.auditLog.findMany({ where: { createdAt: { gte: from }, ...tenantWhereOrAll(me) }, orderBy: { createdAt: "desc" }, take: 500 }),
    ]);

    // Scope the in-memory engine snapshots to the caller's tenant so the
    // summary KPIs below reflect only sites/tanks/generators that belong to
    // the current tenant. SUPERADMIN bypasses — they see the cross-tenant
    // totals. (Task TI-2c)
    const tenantSites = isSuperAdminUser(me)
      ? engine.sites
      : engine.sites.filter((s) => s.tenantId === me.tenantId);
    const tenantSiteIds = isSuperAdminUser(me)
      ? null
      : new Set(tenantSites.map((s) => s.id));
    const tenantTanks = tenantSiteIds === null
      ? engine.tanks
      : engine.tanks.filter((t) => tenantSiteIds.has(t.siteId));
    const tenantGenerators = tenantSiteIds === null
      ? engine.generators
      : engine.generators.filter((g) => tenantSiteIds.has(g.siteId));

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
      volumeDelivered: deliveries.reduce((a, d) => a + (d.volumeDeliveredLitres ?? 0), 0),
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
