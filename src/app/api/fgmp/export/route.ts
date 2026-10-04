import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, isSuperAdminUser } from "@/lib/fgmp/auth-helpers";

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
    const type = searchParams.get("type") ?? "sites"; // sites | tanks | generators | alarms | deliveries

    // ── Tenant isolation (Task TI-2c) ────────────────────────────────────
    // SUPERADMIN sees every site cross-tenant. Every other role only sees
    // rows whose parent site belongs to their own tenant. CSV exports must
    // not leak cross-tenant data.
    const tenantSiteIds = isSuperAdminUser(me)
      ? null
      : new Set(engine.sites.filter((s) => s.tenantId === me.tenantId).map((s) => s.id));
    const sites = tenantSiteIds === null
      ? engine.sites
      : engine.sites.filter((s) => tenantSiteIds.has(s.id));
    const tanks = tenantSiteIds === null
      ? engine.tanks
      : engine.tanks.filter((t) => tenantSiteIds.has(t.siteId));
    const generators = tenantSiteIds === null
      ? engine.generators
      : engine.generators.filter((g) => tenantSiteIds.has(g.siteId));
    const batteries = tenantSiteIds === null
      ? engine.batteries
      : engine.batteries.filter((b) => tenantSiteIds.has(b.siteId));

    let rows: Record<string, unknown>[] = [];
    let filename = type;

    if (type === "sites") {
      rows = sites.map((s) => ({
        code: s.code, name: s.name, region: s.region, governorate: s.governorate, district: s.district,
        status: s.status, criticality: s.criticality, loadKw: s.loadKw, powerSource: s.powerSource,
        gridAvailable: s.gridAvailable, latitude: s.latitude, longitude: s.longitude,
      }));
    } else if (type === "tanks") {
      rows = tanks.map((t) => {
        const s = sites.find((x) => x.id === t.siteId);
        return {
          site: s?.code, siteName: s?.name, label: t.label, fuelType: t.fuelType,
          capacity: t.capacity, current: Math.round(t.current),
          pct: Math.round((t.current / t.capacity) * 1000) / 10, low: t.low, critical: t.critical, status: t.status,
        };
      });
    } else if (type === "generators") {
      rows = generators.map((g) => {
        const s = sites.find((x) => x.id === g.siteId);
        return {
          site: s?.code, siteName: s?.name, label: g.label, manufacturer: g.manufacturer, model: g.model,
          ratedPowerKw: g.ratedPowerKw, status: g.status, mode: g.mode, runtimeHours: g.runtimeHours,
          temperatureC: g.temperatureC, loadKw: g.loadKw, fuelRateLph: g.fuelRateLph,
          nextMaintenanceHrs: g.nextMaintenanceHrs,
        };
      });
    } else if (type === "batteries") {
      rows = batteries.map((b) => {
        const s = sites.find((x) => x.id === b.siteId);
        return {
          site: s?.code, siteName: s?.name, label: b.label, chemistry: b.chemistry,
          nominalVoltage: b.nominalVoltage, voltage: b.voltage, soc: b.stateOfCharge,
          soh: b.stateOfHealth, charging: b.charging, status: b.status,
        };
      });
    } else {
      rows = sites.map((s) => ({ code: s.code, name: s.name, region: s.region, status: s.status }));
    }

    if (rows.length === 0) {
      const res = NextResponse.json({ error: "no data" }, { status: 404 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
    ].join("\n");

    const res = new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="fgmp-${filename}-${Date.now()}.csv"`,
      },
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
