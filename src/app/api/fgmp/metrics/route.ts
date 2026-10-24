import { NextResponse } from "next/server";
import { registry } from "@/lib/observability/metrics";
import { observePoolSaturation } from "@/lib/fgmp/alerting/metrics-wiring";
import { requireRole, ROLES } from "@/lib/fgmp/auth-helpers";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/metrics — Prometheus exposition.
 *
 * ── WHO CAN READ THIS ────────────────────────────────────────────────────────
 * Metric label values are deliberately low-cardinality and non-identifying (a
 * severity, a channel, a status), so the payload carries no customer data. It
 * still reveals operational shape — how many alarms exist, when the last tick
 * ran, whether the limiter is degraded — so it is gated on ALARM_OPS rather
 * than left to a bare `requireAuth()`, which would let any signed-in READONLY
 * account scrape internal timings.
 *
 * ALARM_OPS is the same gate used for alarm acknowledgement: the roles that act
 * on alarms are the roles that get to see the alarms in aggregate.
 */
export async function GET(req: Request) {
  const auth = await requireRole(req as never, ROLES.ALARM_OPS);
  if ("error" in auth) return auth.error;

  // Read the process-local pg.Pool counters without issuing SQL or borrowing a
  // second connection. If the app client has not connected yet, the gauges stay
  // absent and alert evaluation remains unknown rather than implying zero use.
  observePoolSaturation();

  return new NextResponse(registry.render(), {
    status: 200,
    headers: {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      // Never cached: a stale metrics page during an incident is worse than no
      // page, because it says the problem has stopped.
      "cache-control": "no-store",
    },
  });
}