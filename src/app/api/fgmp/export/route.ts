import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { render, isExportFormat } from "@/lib/fgmp/export-render";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const me = auth.user;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") ?? "sites"; // sites | tanks | generators | alarms | deliveries

    // Engine memory can contain several tenants. Never let the platform role
    // turn an ordinary export into a cross-tenant data export.
    const tenantId = tenantIdOrThrow(me.tenantId);
    const tenantSiteIds = new Set(engine.sites.filter((s) => s.tenantId === tenantId).map((s) => s.id));
    const sites = engine.sites.filter((s) => s.tenantId === tenantId);
    const tanks = engine.tanks.filter((t) => tenantSiteIds.has(t.siteId));
    const generators = engine.generators.filter((g) => tenantSiteIds.has(g.siteId));
    const batteries = engine.batteries.filter((b) => tenantSiteIds.has(b.siteId));

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
    // Format is a QUERY parameter, validated against a fixed allowlist. An
    // unvalidated format string would reach the renderer as an arbitrary
    // dispatch key; an unknown one is a 400 rather than a silent CSV fallback,
    // because a caller asking for XLSX and silently receiving CSV is the kind of
    // thing that gets discovered during an audit.
    const format = (searchParams.get("format") ?? "csv").toLowerCase();
    if (!isExportFormat(format)) {
      const res = NextResponse.json(
        { error: `Unsupported format "${format}"`, supported: ["csv", "xlsx", "docx", "pdf"] },
        { status: 400 },
      );
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const title = `FGMP ${type}`;
    const { body, contentType } = await render(rows, format, { title });

    const res = new NextResponse(body as BodyInit, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition":
          `attachment; filename="fgmp-${filename}-${Date.now()}.${format}"`,
      },
    });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

