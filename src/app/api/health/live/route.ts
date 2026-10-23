import { NextResponse } from "next/server";

/**
 * Liveness probe — unauthenticated, no database, no secrets.
 *
 * `/api/fgmp/health` is ADMIN-only by design (it exposes process memory, table
 * counts and the error ring buffer), so it cannot be used by an orchestrator:
 * an unauthenticated probe gets 401 and a healthy container is marked down.
 * This route answers the only question a liveness check may ask — "is this
 * process serving HTTP?" — and nothing else.
 *
 * It deliberately does NOT touch the database. A liveness probe that fails when
 * the database is slow restarts a perfectly good process and makes an outage
 * worse; dependency checks belong in readiness.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { status: "live", uptimeSeconds: Math.round(process.uptime()) },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
