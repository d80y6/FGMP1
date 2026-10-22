import { NextRequest, NextResponse } from "next/server";
import { isSuperAdminUser, requireAuth } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import {
  getApinatorServer,
  TENANT_CHANNEL_PREFIX,
  tenantChannel,
} from "@/lib/fgmp/apinator-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/fgmp/realtime/auth — Apinator private-channel authorization
 * ─────────────────────────────────────────────────────────────────────────
 * Apinator private channels require per-subscription authorization: before a
 * browser may subscribe to `private-tenant-<tenantId>`, the SDK POSTs
 * `{ socket_id, channel_name }` HERE (same-origin, so the NextAuth session
 * cookie rides along) and expects the HMAC `{ auth }` response back. The SDK
 * treats a non-2xx as a refused subscription — which is what makes the
 * authorization decision below an actual security boundary.
 *
 * WHY THIS ROUTE REPLACED THE SIGNED-TOKEN HANDSHAKE: the socket.io
 * mini-service was a separate process that could not read the NextAuth
 * session cookie, so the app minted short-lived HMAC tokens the service
 * verified (see the deleted realtime-token.ts). The channel auth now runs
 * INSIDE the Next.js app, where the session is directly available — the
 * token minting/carrying layer is gone, and with it the whole class of
 * "stale token on reconnect" failures. The authorization decision is the
 * same shape as before, just made in-process:
 *
 *   1. Authenticated session (requireAuth)                → else 401
 *   2. MFA gate: mfaPending || !role                      → else 403
 *   3. Tenant member with a resolvable tenant             → else 403
 *   4. channel_name === EXACTLY private-tenant-<own tid>  → else 403
 *
 * ── WHY THE CHANNEL MUST MATCH EXACTLY, NOT BY PREFIX ──────────────────────
 * A startsWith(TENANT_CHANNEL_PREFIX) check would authorize any channel that
 * BEGINS with the prefix — including `private-tenant-<someOtherTenantId>`,
 * which is a valid prefix match. The caller's tenant is taken from the
 * session (NEVER from the body — a client-controlled tenantId would make the
 * whole gate decorative), so the only acceptable channel is the string built
 * from that session tenant, compared with full equality. There is also
 * deliberately no superadmin path here: SUPERADMIN carries no single tenant
 * by design (see the channel discovery route), so there is no
 * `private-tenant-` channel that could be "theirs", and handing a
 * cross-tenant operator one tenant's event stream would be a downgrade of
 * their isolation, not a convenience.
 */

/**
 * Sanity bound on the two body fields. NOT a format assertion — the socket id
 * shape belongs to Apinator and must not be re-encoded here (a stricter
 * regex would fail closed but confusingly if Apinator ever changes format).
 * The bound only stops absurd payloads from reaching the HMAC and the
 * provider; the exact-match check is what actually authorizes.
 */
const MAX_FIELD_LENGTH = 256;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  // A PENDING MFA session has no role AND no tenant by design, so it must not
  // subscribe to any channel: the subscription would ride on authority the
  // caller does not yet hold. Same gate, same order as the token route this
  // replaces — refuse BEFORE touching the body, so an unverified session
  // cannot even probe the endpoint's shape.
  if (auth.user.mfaPending || !auth.user.role) {
    return NextResponse.json(
      {
        error:
          "Multi-factor authentication is required before a realtime channel can be authorized.",
      },
      { status: 403 },
    );
  }

  // SUPERADMIN has no single tenant by design → no channel to authorize.
  // Checked BEFORE tenantIdOrThrow because tenantIdOrThrow is built for the
  // "session should have a tenant" case and its error is a 500-shaped
  // throwable, while this condition is an authorization verdict (403).
  if (isSuperAdminUser(auth.user)) {
    return NextResponse.json(
      {
        error:
          "A super-admin has no single tenant and cannot subscribe to a tenant channel. " +
          "Super-admin views refresh by polling.",
      },
      { status: 403 },
    );
  }

  // The caller's tenant comes from the SESSION, never from the body — the
  // body is the client's claim about WHAT it wants; the session is the
  // server's fact about WHO is asking. tenantIdOrThrow cannot fire for a
  // superadmin (handled above) or an MFA-pending session (handled above),
  // so this try is defence in depth for a malformed session; it fails
  // closed at the same status the explicit checks produce.
  let tenantId: string;
  try {
    tenantId = tenantIdOrThrow(auth.user.tenantId);
  } catch {
    return NextResponse.json(
      { error: "This session is not scoped to a tenant." },
      { status: 403 },
    );
  }

  // ── Body: { socket_id, channel_name } ──────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON: { socket_id, channel_name }." },
      { status: 400 },
    );
  }
  const fields = (body ?? {}) as { socket_id?: unknown; channel_name?: unknown };
  const socketId = typeof fields.socket_id === "string" ? fields.socket_id : "";
  const channelName =
    typeof fields.channel_name === "string" ? fields.channel_name : "";
  if (
    socketId.trim() === "" ||
    channelName.trim() === "" ||
    socketId.length > MAX_FIELD_LENGTH ||
    channelName.length > MAX_FIELD_LENGTH
  ) {
    return NextResponse.json(
      { error: "socket_id and channel_name are required non-empty strings." },
      { status: 400 },
    );
  }

  // THE authorization decision: exact channel equality with the caller's own
  // tenant channel. Anything else — another tenant's channel, a presence or
  // cache variant, a made-up name — is 403. See the header note for why the
  // comparison is equality, not a prefix test.
  if (channelName !== tenantChannel(tenantId)) {
    return NextResponse.json(
      {
        error: `Only the channel "${TENANT_CHANNEL_PREFIX}<your tenant>" may be authorized for this session.`,
      },
      { status: 403 },
    );
  }

  // The deployment must be configured for Apinator before it can sign
  // anything — an unconfigured server 503s rather than signing with
  // placeholder credentials (there are none to fall back to; fail-closed
  // policy, see apinator-server.ts).
  const client = getApinatorServer();
  if (!client) {
    return NextResponse.json(
      {
        error: "Realtime channel authorization unavailable",
        detail:
          "Apinator server credentials are not configured (APINATOR_APP_ID, APINATOR_KEY, APINATOR_SECRET, APINATOR_CLUSTER).",
      },
      { status: 503 },
    );
  }

  // authenticateChannel is a synchronous HMAC over (socket_id, channel_name)
  // — no provider round-trip, so no retry/timeout concerns here. It cannot
  // realistically throw, but a failed signature is still better as a 500
  // than a crashed route.
  try {
    const channelAuth = client.authenticateChannel(socketId, channelName);
    return NextResponse.json(channelAuth);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Channel authorization failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
