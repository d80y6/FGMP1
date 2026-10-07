import { NextRequest, NextResponse } from "next/server";
import { engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse, forbidden } from "@/lib/fgmp/api-error";
import { requireAuth, siteTenantWhere } from "@/lib/fgmp/auth-helpers";
import { withTenant } from "@/lib/fgmp/tenant-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/edge/rs485
 * Returns RS485 bus diagnostics for the tenant's dispensers.
 *
 * PHASE 2 CHANGE — this route previously reported hard-coded zeros:
 *
 *     const latency = 0;
 *     const crcErrors = 0;
 *     const timeouts = 0;
 *
 * with a comment admitting the true values were "neither persisted … nor
 * simulated". A dashboard showing "0 CRC errors" on a failing bus is worse than
 * showing nothing at all, because zero reads as healthy. This route now reads
 * PERSISTED measurements written by the protocol layer
 * (src/lib/fgmp/protocol/client.ts), and distinguishes explicitly between:
 *
 *   - a device with a diagnostics row  → real counters, measured on the bus
 *   - a device with no diagnostics row → `polled: false`, meaning "we have never
 *     polled this device", which is NOT the same as "0 errors"
 *
 * That distinction is the whole reason the shape changed. Collapsing
 * "not measured" into "zero" is how the original version ended up lying.
 *
 * DISP-FW-GW — Edge & Firmware view → RS485 tab.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = await rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    // Every database read here must run INSIDE withTenant().
    //
    // RLS is FORCE-enabled, so a `withTenant(user.tenantId, (tx) => tx.*` query with no tenant context in scope
    // returns ZERO rows — including a query with an explicit tenantId filter,
    // because the policy's USING clause is ANDed with it and `current_setting`
    // is still NULL:
    //
    //     withTenant(user.tenantId, (tx) => tx.fuelDispenser.count()))                                      -> 0
    //     withTenant(user.tenantId, (tx) => tx.fuelDispenser.count({ where: { tenantId: "t-default" } }))  -> 0
    //     withTenant("t-default", tx => tx.fuelDispenser.count())       -> 24
    //
    // The explicit filter looks like it should work and does not. Verified
    // against the real fgmp_app role, not the ops or migrate connection —
    // running this route on the owner role would have returned rows and
    // proved nothing about production behaviour.
    const tenantId = requireTenant(auth.user);
    const dispenserRows = await withTenant(tenantId, (tx) =>
      tx.fuelDispenser.findMany({
        where: siteTenantWhere(auth.user),
        orderBy: [{ siteId: "asc" }, { label: "asc" }],
        include: {
          site: { select: { id: true, name: true, code: true } },
        },
      }),
    );

    // Diagnostics are tenant-scoped too, and must share the transaction context
    // — a second withTenant() call would open a different transaction on a
    // different pooled connection, which has no tenant context.
    const diagnosticRows = await withTenant(tenantId, (tx) =>
      tx.rs485BusDiagnostic.findMany({
        include: { bus: { select: { label: true, online: true } } },
      }),
    );

    const dispensers = dispenserRows;
    const diagnosticsByUnit = indexDiagnostics(diagnosticRows);

    const live = engine.dispensers;
    const merged = dispensers.map((d) => {
      const l = live.find((x) => x.id === d.id);
      const diag = diagnosticsByUnit.get(d.rs485Address);

      // No diagnostics row means this device has never been polled over RS485.
      // Report that explicitly instead of fabricating zeroed counters.
      const polled = diag !== undefined;

      return {
        dispenserId: d.id,
        label: d.label,
        nozzleCount: d.nozzleCount,
        site: d.site,
        modbusUnit: d.rs485Address,
        rs485Baud: d.rs485Baudrate,
        rs485Parity: d.rs485Parity,
        espControllerId: d.espDeviceId,
        espFirmware: d.espFirmware,
        espIpAddress: d.ipAddress,
        wifiRssi: d.wifiRssi,

        // ── Measured, persisted values ──────────────────────────────────
        // null (not 0) when never polled. Callers can distinguish "healthy"
        // from "unmeasured", which the previous implementation could not.
        polled,
        busId: diag?.busId ?? null,
        pollLatencyMs: diag?.lastLatencyMs ?? null,
        avgPollLatencyMs: diag?.averageLatencyMs ?? null,
        crcErrors: diag?.crcErrors ?? null,
        timeouts: diag?.timeouts ?? null,
        retries: diag?.retries ?? null,
        retriesExhausted: diag?.retriesExhausted ?? null,
        exceptionResponses: diag?.exceptionResponses ?? null,
        successfulReads: diag?.successfulReads ?? null,
        failedReads: diag?.failedReads ?? null,
        lastPollAt: diag?.lastPollAt?.getTime() ?? null,
        lastError: diag?.lastError ?? null,
        lastErrorKind: diag?.lastErrorKind ?? null,

        // `lastCommAt` is the transport-level "device last heard from" stamp,
        // which survives independently of a bus poll, so it stays useful as a
        // liveness signal. `lastPollAt` above is the Modbus-level measurement.
        lastCommAt: d.lastCommAt?.getTime() ?? null,

        // A dispenser-level comm-loss window does not exist in engine state
        // (commLossUntil is tracked per Site), so this stays unset until the
        // dispenser model carries one.
        commLossUntil: undefined,
        commLossActive: false,
        status: l?.status ?? d.status,
        liveStatus: l?.status ?? d.status,
      };
    });

    // Bus-level health, aggregated from the persisted rows rather than derived
    // from `lastCommAt`. A shorted trunk or two devices sharing a slave address
    // is a bus fault, not a device fault, and needs to be visible as such.
    const buses = aggregateBuses(diagnosticsByUnit.values());

    const res = NextResponse.json({ dispensers: merged, buses });
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

type DiagnosticRow = {
  busId: string;
  unitAddress: number;
  lastLatencyMs: number;
  averageLatencyMs: number | null;
  crcErrors: number;
  timeouts: number;
  retries: number;
  retriesExhausted: number;
  exceptionResponses: number;
  successfulReads: number;
  failedReads: number;
  lastPollAt: Date | null;
  lastError: string | null;
  lastErrorKind: string | null;
  busLabel?: string;
  busOnline?: boolean;
};

/**
 * Resolve the tenant this request may read.
 *
 * Fails closed rather than falling back to a default tenant. Returning data
 * for the wrong tenant, or silently returning nothing, are both worse than an
 * error the caller can act on.
 */
function requireTenant(user: { tenantId?: string | null }): string {
  if (!user.tenantId) {
    // SUPERADMIN spans tenants and has no single tenantId. It cannot use this
    // route; attempting to guess a tenant would be exactly the cross-tenant
    // read the backstop exists to prevent.
    throw forbidden("This endpoint requires a tenant-scoped account");
  }
  return user.tenantId;
}

/** Index diagnostics by Modbus unit address. */
function indexDiagnostics(
  rows: {
    busId: string;
    unitAddress: number;
    lastLatencyMs: number;
    averageLatencyMs: number | null;
    crcErrors: number;
    timeouts: number;
    retries: number;
    retriesExhausted: number;
    exceptionResponses: number;
    successfulReads: number;
    failedReads: number;
    lastPollAt: Date | null;
    lastError: string | null;
    lastErrorKind: string | null;
    bus: { label: string; online: boolean };
  }[],
): Map<number, DiagnosticRow> {
  const out = new Map<number, DiagnosticRow>();
  for (const r of rows) {
    // Keep the most recently polled row if two buses share a unit address, so
    // the newest measurement wins rather than an arbitrary one.
    const existing = out.get(r.unitAddress);
    if (existing && (existing.lastPollAt?.getTime() ?? 0) > (r.lastPollAt?.getTime() ?? 0)) {
      continue;
    }
    out.set(r.unitAddress, {
      busId: r.busId,
      unitAddress: r.unitAddress,
      lastLatencyMs: r.lastLatencyMs,
      averageLatencyMs: r.averageLatencyMs,
      crcErrors: r.crcErrors,
      timeouts: r.timeouts,
      retries: r.retries,
      retriesExhausted: r.retriesExhausted,
      exceptionResponses: r.exceptionResponses,
      successfulReads: r.successfulReads,
      failedReads: r.failedReads,
      lastPollAt: r.lastPollAt,
      lastError: r.lastError,
      lastErrorKind: r.lastErrorKind,
      busLabel: r.bus.label,
      busOnline: r.bus.online,
    });
  }
  return out;
}

/**
 * Aggregate device diagnostics into per-bus health.
 *
 * Kept separate from the per-device list because the operator's first question
 * when a bus misbehaves is "is the wiring broken or is one device dead?", and
 * that cannot be answered from a flat list of per-device counters.
 */
function aggregateBuses(diags: Iterable<DiagnosticRow>) {
  const byBus = new Map<string, {
    busId: string;
    label: string | null;
    online: boolean;
    devices: number;
    polledDevices: number;
    crcErrors: number;
    timeouts: number;
    failedReads: number;
    successfulReads: number;
    totalAttempts: number;
    availability: number | null;
    worstLatencyMs: number;
    lastPollAt: Date | null;
  }>();

  for (const d of diags) {
    let b = byBus.get(d.busId);
    if (!b) {
      b = {
        busId: d.busId,
        label: d.busLabel ?? null,
        online: d.busOnline ?? false,
        devices: 0,
        polledDevices: 0,
        crcErrors: 0,
        timeouts: 0,
        failedReads: 0,
        successfulReads: 0,
        totalAttempts: 0,
        availability: null,
        worstLatencyMs: 0,
        lastPollAt: null,
      };
      byBus.set(d.busId, b);
    }
    b.devices += 1;
    b.polledDevices += 1;
    b.crcErrors += d.crcErrors;
    b.timeouts += d.timeouts;
    b.failedReads += d.failedReads;
    b.successfulReads += d.successfulReads;
    b.totalAttempts += d.successfulReads + d.failedReads;
    b.worstLatencyMs = Math.max(b.worstLatencyMs, d.lastLatencyMs);
    if (d.lastPollAt && (!b.lastPollAt || d.lastPollAt > b.lastPollAt)) {
      b.lastPollAt = d.lastPollAt
    }
  }

  // Availability is a MEASURED ratio, or null when nothing has been polled.
  // Reporting 0% or 100% for an unmeasured bus would be the same class of lie
  // this route originally told.
  for (const b of byBus.values()) {
    b.availability =
      b.totalAttempts === 0
        ? null
        : Math.round((b.successfulReads / b.totalAttempts) * 10_000) / 100;
  }

  return [...byBus.values()];
}