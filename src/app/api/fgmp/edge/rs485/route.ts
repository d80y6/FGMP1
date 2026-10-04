import { NextRequest, NextResponse } from "next/server";
import { db, engine, bootstrap } from "@/lib/fgmp";
import {
  rateLimitByUser,
  applyRateLimitHeaders,
  READ_LIMIT,
} from "@/lib/fgmp/rate-limit";
import { errorResponse } from "@/lib/fgmp/api-error";
import { requireAuth, siteTenantWhere } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/edge/rs485
 * Returns all dispensers' RS485 bus diagnostics. The DB row carries the
 * bus configuration (baud / address / parity) and the last-persisted
 * `lastCommAt`; dispenser status is overlaid from the engine so the UI sees
 * fresh data on every refresh.
 *
 * NOTE: the true bus diagnostics (poll latency, CRC errors, timeouts) are not
 * persisted on FuelDispenser and are not simulated by the engine, so they are
 * reported as 0 / derived from `lastCommAt`.
 *
 * DISP-FW-GW — Edge & Firmware view → RS485 tab.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;
  try {
    const { user } = await bootstrap();
    const rl = rateLimitByUser(req, user.id, READ_LIMIT.limit, READ_LIMIT.windowMs);
    if (!rl.success) {
      const res = NextResponse.json({ error: "Too many requests" }, { status: 429 });
      applyRateLimitHeaders(res.headers, rl);
      return res;
    }

    const dispensers = await db.fuelDispenser.findMany({
      where: siteTenantWhere(auth.user),
      orderBy: [{ siteId: "asc" }, { label: "asc" }],
      include: {
        site: { select: { id: true, name: true, code: true } },
      },
    });

    const live = engine.dispensers;
    const merged = dispensers.map((d) => {
      const l = live.find((x) => x.id === d.id);
      // RS485 bus diagnostics (poll latency, CRC errors, timeouts, last poll)
      // are neither persisted on FuelDispenser nor simulated by the engine, so
      // there is no live source to merge — the documented fallbacks apply and
      // `lastPollAt` tracks the persisted `lastCommAt`.
      const latency = 0;
      const crcErrors = 0;
      const timeouts = 0;
      const lastPollAt = d.lastCommAt?.getTime() ?? Date.now();
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
        rs485PollLatencyMs: latency,
        rs485CrcErrors: crcErrors,
        rs485Timeouts: timeouts,
        rs485LastPollAt: lastPollAt,
        // A dispenser-level comm-loss window does not exist in engine state
        // (commLossUntil is tracked per Site), so this stays unset until the
        // dispenser model carries one.
        commLossUntil: undefined,
        commLossActive: false,
        status: l?.status ?? d.status,
        liveStatus: l?.status ?? d.status,
        lastCommAt: d.lastCommAt?.getTime() ?? null,
      };
    });

    const res = NextResponse.json(merged);
    applyRateLimitHeaders(res.headers, rl);
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
