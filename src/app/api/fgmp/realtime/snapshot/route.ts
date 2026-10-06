import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/fgmp";
import { errorResponse } from "@/lib/fgmp/api-error";

export const dynamic = "force-dynamic";

/**
 * FGMP Realtime Snapshot Endpoint (Task 31-B)
 * ─────────────────────────────────────────────────────────────────────────
 * Service-to-service variant of `/api/fgmp/state` for use by the realtime
 * mini-service (mini-services/realtime/index.ts) and the IoT bridge
 * (mini-services/iot-bridge/index.ts).
 *
 * NOTE: This endpoint returns the GLOBAL cross-tenant snapshot and is
 * therefore strictly service-to-service. It is authenticated by a static
 * service token (not a NextAuth session) and consumed only by the realtime
 * mini-service and the IoT bridge. The realtime service partitions this
 * snapshot per tenant and pushes each socket only its own slice over
 * `tenant:<id>` rooms. Browser-facing endpoints use /api/fgmp/state, which
 * calls engine.snapshotForTenant(user.tenantId) for proper isolation.
 *
 * Authentication: requests MUST include the `x-service-token` header
 * matching the `REALTIME_SERVICE_TOKEN` env var. There is no default — the
 * previous fallback (`fgmp-realtime-dev-token`) was committed to the repo, so
 * an unset value exposed the whole platform to anyone who guessed it. This
 * is NOT a browser-facing endpoint.
 *
 * Why a separate endpoint?
 *   Task 31-A wrapped `/api/fgmp/state` in `requireAuth()` (NextAuth
 *   session). The realtime service cannot easily obtain a browser session,
 *   so we expose this parallel endpoint that authenticates via a static
 *   service token instead. The token is supplied via env var.
 *
 * Returns the same Snapshot shape as `/api/fgmp/state`.
 */

/**
 * Service token for the realtime mini-service. There is deliberately no
 * committed default — the previous fallback (`fgmp-realtime-dev-token`) was in
 * this file and was the compose default, so an unset value handed the entire
 * cross-tenant snapshot to anyone who guessed the header.
 *
 * Read lazily: `next build` imports route modules to collect page data, where
 * runtime secrets do not exist yet. The handler below fails closed instead.
 */
function realtimeServiceToken(): string {
  const v = process.env.REALTIME_SERVICE_TOKEN;
  if (!v || v.length < 16) {
    throw new Error(
      "REALTIME_SERVICE_TOKEN is missing or too short (min 16 chars) — refusing to serve snapshots.",
    );
  }
  return v;
}

export async function GET(req: NextRequest) {
  // ── Service-token auth (no session required) ──────────────────────────
  let expected: string;
  try {
    expected = realtimeServiceToken();
  } catch (err) {
    return NextResponse.json(
      {
        error: "snapshot endpoint not configured",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
  const token = req.headers.get("x-service-token");
  if (!token || token !== expected) {
    return NextResponse.json(
      { error: "unauthorized", code: "INVALID_SERVICE_TOKEN" },
      { status: 401 },
    );
  }

  try {
    // Initialise the engine WITHOUT bootstrap(). bootstrap() resolves the
    // authenticated user and throws when there is no NextAuth session — but
    // this endpoint authenticates with a static service token and is called by
    // the realtime and iot-bridge mini-services, which have no session. The
    // call therefore threw for every request and the realtime push channel had
    // been dead since Phase 0.
    //
    // engine.snapshot() is deliberately GLOBAL: this is the service-to-service
    // endpoint, and the realtime service partitions the payload per tenant
    // before pushing each socket only its own slice. See the header note.
    await engine.ensureInit();
    const snap = await engine.snapshot();
    return NextResponse.json(snap);
  } catch (err) {
    return errorResponse(err);
  }
}
