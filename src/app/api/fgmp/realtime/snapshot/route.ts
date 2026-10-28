import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { errorResponse } from "@/lib/fgmp/api-error";
import {
  isRealtimeServiceTokenConfigured,
  matchesRealtimeServiceToken,
} from "@/lib/fgmp/service-token";

export const dynamic = "force-dynamic";

/**
 * FGMP Realtime Snapshot Endpoint (Task 31-B)
 * ─────────────────────────────────────────────────────────────────────────
 * Service-to-service variant of `/api/fgmp/state` for the IoT bridge
 * (mini-services/iot-bridge/index.ts).
 *
 * This service-to-service endpoint provides only the site/tenant IDs the IoT
 * bridge needs to choose a tenant-scoped API key. It does not return the global
 * operational snapshot (telemetry, alarms, transactions, or events). Browser
 * endpoints continue to use `/api/fgmp/state`, which returns a tenant-scoped
 * snapshot. The bridge authenticates with a dedicated service token, not a
 * NextAuth session.
 *
 * Authentication: requests MUST include the `x-service-token` header
 * matching the `REALTIME_SERVICE_TOKEN` env var. There is no default: missing
 * or invalid configuration fails closed, and the previously published
 * `fgmp-realtime-dev-token` is explicitly rejected even if configured. This
 * is NOT a browser-facing endpoint.
 *
 * Why a separate endpoint?
 *   Task 31-A wrapped `/api/fgmp/state` in `requireAuth()` (NextAuth
 *   session). The IoT bridge cannot easily obtain a browser session,
 *   so we expose this parallel endpoint that authenticates via a static
 *   service token instead. The token is supplied via env var.
 *
 * Returns `{ sites: Array<{ id, tenantId }> }` only; the `snapshot` path name
 * is retained for the bridge's existing polling URL.
 */

/**
 * Add an explicit cache boundary to every response: the service directory is
 * cross-tenant metadata and must never be stored by a shared proxy.
 */
function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}

export async function GET(req: NextRequest) {
  // ── Service-token auth (no session required) ──────────────────────────
  const expected = process.env.REALTIME_SERVICE_TOKEN;
  if (!isRealtimeServiceTokenConfigured(expected)) {
    return privateNoStore(
      NextResponse.json(
        { error: "snapshot endpoint not configured" },
        { status: 503 },
      ),
    );
  }
  const token = req.headers.get("x-service-token");
  if (!matchesRealtimeServiceToken(token, expected)) {
    return privateNoStore(
      NextResponse.json(
        { error: "unauthorized", code: "INVALID_SERVICE_TOKEN" },
        { status: 401 },
      ),
    );
  }

  try {
    // The bridge needs only site IDs and tenant IDs to choose a scoped ingest
    // key. Keep the service credential's data authority narrow; do not call
    // snapshot(), which serializes operational state for every tenant.
    const sites = await engine.bridgeSiteDirectory();
    return privateNoStore(NextResponse.json({ sites }));
  } catch (err) {
    return privateNoStore(errorResponse(err));
  }
}
