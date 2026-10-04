import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/fgmp/auth-helpers";
import { issueRealtimeToken, REALTIME_TOKEN_TTL_MS } from "@/lib/fgmp/realtime-token";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/realtime/token
 *
 * Mints a short-lived signed token that the browser presents to the realtime
 * mini-service during the socket.io handshake. The realtime service is a
 * separate process and cannot read the NextAuth session cookie, so this is how
 * a browser proves who it is.
 *
 * Requires an authenticated session. The token carries the caller's real
 * tenantId, which is what the service uses to decide which slice of the
 * snapshot that socket is allowed to receive — so a token cannot be used to
 * subscribe to another tenant's fleet.
 *
 * The token is signed, not merely opaque: the client cannot forge or alter it.
 */
export async function GET() {
  const auth = await requireAuth();
  if ("error" in auth) return auth.error;

  try {
    const token = issueRealtimeToken({
      id: auth.user.id,
      role: auth.user.role,
      tenantId: auth.user.tenantId,
    });
    return NextResponse.json({
      token,
      expiresInMs: REALTIME_TOKEN_TTL_MS,
    });
  } catch (err) {
    // Misconfigured deployment (REALTIME_TOKEN_SECRET unset) — surface it
    // rather than handing the client an unauthenticated socket.
    return NextResponse.json(
      {
        error: "Realtime token unavailable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
