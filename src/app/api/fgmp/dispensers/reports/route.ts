import { toJsonNumber } from "@/lib/fgmp/decimal";
import { NextRequest, NextResponse } from "next/server";
import { bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { withTenant } from "@/lib/fgmp/tenant-context";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, siteTenantWhere } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/dispensers/reports
 * Aggregated fueling stats for the reports tab.
 *
 * Query params:
 *   - period : "today" | "7d" | "30d" (default "today")
 *   - siteId : optional site filter
 *
 * Returns:
 *   - totals: { txns, volume, revenue, avgVolume, avgDuration, faultCount }
 *   - bySite: [{ siteId, siteName, siteCode, txns, volume, revenue }]
 *   - byDispenser: [{ dispenserId, label, pumpNumber, siteName, txns, volume, revenue }]
 *   - byVehicle: [{ vehiclePlate, txns, volume, revenue }]
 *   - byStatus: [{ status, txns, volume }]
 *   - hourly: [{ hour: 0..23, txns, volume }] (volume per hour-of-day)
 *   - daily: [{ date: "YYYY-MM-DD", txns, volume, revenue }] (per day for the period)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
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
    const period = searchParams.get("period") ?? "today";
    const siteId = searchParams.get("siteId");

    const now = new Date();
    let since: Date;
    if (period === "7d") since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    else if (period === "30d") since = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    else since = new Date(now.getTime() - 24 * 3600 * 1000); // "today" = last 24h

    const where: Record<string, unknown> = { startedAt: { gte: since }, ...siteTenantWhere(me) };
    if (siteId) where.siteId = siteId;

    // Run all queries in parallel
    const [txns, totalAgg, faultCount, bySiteRaw, byDispenserRaw, byVehicleRaw, byStatusRaw, hourlyRaw, dailyRaw] = await Promise.all([
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: 5000, // cap for safety
        select: {
          id: true,
          dispenserId: true,
          siteId: true,
          startedAt: true,
          completedAt: true,
          durationSec: true,
          volumeLitres: true,
          amountYer: true,
          status: true,
          vehiclePlate: true,
        },
      })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.aggregate({
        where,
        _sum: { volumeLitres: true, amountYer: true },
        _avg: { volumeLitres: true, durationSec: true },
        _count: true,
      })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.count({ where: { ...where, status: "FAILED" } })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.groupBy({
        by: ["siteId"],
        where,
        _count: true,
        _sum: { volumeLitres: true, amountYer: true },
      })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.groupBy({
        by: ["dispenserId"],
        where,
        _count: true,
        _sum: { volumeLitres: true, amountYer: true },
      })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.groupBy({
        by: ["vehiclePlate"],
        where,
        _count: true,
        _sum: { volumeLitres: true, amountYer: true },
      })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.groupBy({
        by: ["status"],
        where,
        _count: true,
        _sum: { volumeLitres: true },
      })),
      // hourly: group by hour-of-day. SQLite has no EXTRACT; we do it in JS.
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.findMany({
        where,
        select: { startedAt: true, volumeLitres: true },
        take: 5000,
      })),
            withTenant(me.tenantId, (tx) => tx.fuelTransaction.findMany({
        where,
        select: { startedAt: true, volumeLitres: true, amountYer: true },
        take: 5000,
      })),
    ]);

    // Resolve site + dispenser names
    const siteIds = [...new Set(bySiteRaw.map((s) => s.siteId))];
    const dispenserIds = [...new Set(byDispenserRaw.map((d) => d.dispenserId))];
    const [sites, dispensers] = await Promise.all([
            withTenant(me.tenantId, (tx) => tx.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true, code: true } })),
            withTenant(me.tenantId, (tx) => tx.fuelDispenser.findMany({
        where: { id: { in: dispenserIds } },
        select: { id: true, label: true, pumpNumber: true, siteId: true, site: { select: { name: true } } },
      })),
    ]);
    const siteMap = new Map(sites.map((s) => [s.id, s]));
    const dispenserMap = new Map(dispensers.map((d) => [d.id, d]));

    const bySite = bySiteRaw
      .map((s) => {
        const site = siteMap.get(s.siteId);
        return {
          siteId: s.siteId,
          siteName: site?.name ?? s.siteId,
          siteCode: site?.code ?? "",
          txns: s._count,
          volume: Math.round(s._sum.volumeLitres ?? 0),
          revenue: toJsonNumber(s._sum.amountYer),
        };
      })
      .sort((a, b) => b.volume - a.volume);

    const byDispenser = byDispenserRaw
      .map((d) => {
        const disp = dispenserMap.get(d.dispenserId);
        return {
          dispenserId: d.dispenserId,
          label: disp?.label ?? d.dispenserId,
          pumpNumber: disp?.pumpNumber ?? 0,
          siteName: disp?.site?.name ?? "",
          txns: d._count,
          volume: Math.round(d._sum.volumeLitres ?? 0),
          revenue: toJsonNumber(d._sum.amountYer),
        };
      })
      .sort((a, b) => b.volume - a.volume);

    const byVehicle = byVehicleRaw
      .map((v) => ({
        vehiclePlate: v.vehiclePlate ?? "—",
        txns: v._count,
        volume: Math.round(v._sum.volumeLitres ?? 0),
        revenue: toJsonNumber(v._sum.amountYer),
      }))
      .sort((a, b) => b.volume - a.volume);

    const byStatus = byStatusRaw.map((s) => ({
      status: s.status,
      txns: s._count,
      volume: Math.round(s._sum.volumeLitres ?? 0),
    }));

    // Hourly histogram (24 buckets, hour-of-day)
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, txns: 0, volume: 0 }));
    for (const t of hourlyRaw) {
      const h = new Date(t.startedAt).getHours();
      hourly[h].txns++;
      hourly[h].volume += t.volumeLitres;
    }
    for (const h of hourly) h.volume = Math.round(h.volume);

    // Daily breakdown
    const dailyMap = new Map<string, { txns: number; volume: number; revenue: number }>();
    for (const t of dailyRaw) {
      const d = new Date(t.startedAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const entry = dailyMap.get(key) ?? { txns: 0, volume: 0, revenue: 0 };
      entry.txns++;
      entry.volume += t.volumeLitres;
      entry.revenue += toJsonNumber(t.amountYer);
      dailyMap.set(key, entry);
    }
    const daily = Array.from(dailyMap.entries())
      .map(([date, v]) => ({ date, txns: v.txns, volume: Math.round(v.volume), revenue: Math.round(v.revenue) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const totals = {
      txns: totalAgg._count,
      volume: Math.round(totalAgg._sum.volumeLitres ?? 0),
      revenue: toJsonNumber(totalAgg._sum.amountYer),
      avgVolume: Math.round((totalAgg._avg.volumeLitres ?? 0) * 10) / 10,
      avgDuration: Math.round(totalAgg._avg.durationSec ?? 0),
      faultCount,
    };

    // Recent txns (last 10) for the "live feed" panel
    const recent = txns.slice(0, 10).map((t) => {
      const disp = dispenserMap.get(t.dispenserId);
      const site = siteMap.get(t.siteId);
      return {
        id: t.id,
        dispenserId: t.dispenserId,
        dispenserLabel: disp?.label ?? t.dispenserId,
        pumpNumber: disp?.pumpNumber ?? 0,
        siteId: t.siteId,
        siteName: site?.name ?? t.siteId,
        siteCode: site?.code ?? "",
        startedAt: t.startedAt.getTime(),
        completedAt: t.completedAt?.getTime(),
        durationSec: t.durationSec,
        volumeLitres: t.volumeLitres,
        amountYer: t.amountYer,
        status: t.status,
        vehiclePlate: t.vehiclePlate,
      };
    });

    const res = NextResponse.json({
      period,
      since: since.toISOString(),
      until: now.toISOString(),
      totals,
      bySite,
      byDispenser,
      byVehicle,
      byStatus,
      hourly,
      daily,
      recent,
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
