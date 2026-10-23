import { NextRequest, NextResponse } from "next/server";
import { isSuperAdminUser, requireAuth } from "@/lib/fgmp/auth-helpers";
import { tenantIdOrThrow } from "@/lib/fgmp/route-tenant";
import {
  apinatorServerConfig,
  tenantChannel,
} from "@/lib/fgmp/apinator-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/fgmp/realtime/channel — channel discovery for the browser
 * ─────────────────────────────────────────────────────────────────────────
 * Tells use-realtime.ts WHICH Apinator channel this session may subscribe
 * to, or that it may subscribe to none. Returns:
 *
 *   tenant member → { channel: "private-tenant-<tenantId>" }
 *   SUPERADMIN    → { channel: null }
 *
 * ── WHY SUPERADMIN GETS null (and not a platform-wide channel) ──────────────
 * A super-admin is deliberately NOT a member of any single tenant, so there
 * is no `private-tenant-` channel that is "theirs" — and building a
 * cross-tenant "all events" channel would pipe every tenant's alarm/command
 * activity into one browser connection, a cross-tenant information flow the
 * role model does not grant anywhere else (super-admin API reads are
 * explicit, per-view, and role-gated). A channel that says "everything,
 * always" would also fire unbounded refresh triggers: one noisy tenant
 * would keep the super-admin's dashboard permanently refreshing. Instead
 * the super-admin relies on POLLING — the AppShell's 5s poll is the only
 * state refresher in this architecture anyway, so a super-admin without a
 * socket simply uses the refresher everyone already has. The browser treats
 * `channel: null` as "never subscribe" and the connection badge honestly
 * shows disconnected.
 *
 * ── AUTH SHAPE (mirrors the deleted token route) ────────────────────────────
 * requireAuth → 401; the MFA gate (mfaPending || !role) → 403 BEFORE any
 * data is derived, because a PENDING MFA session carries no tenant by
 * design and must not be told anything about channels. Discovery alone is
 * harmless (a channel name, not a capability) — the actual capability check
 * lives in the channel-auth route, which re-derives the tenant from the
 * session and compares the requested channel exactly. This route returning
 * a channel name does not authorize anything by itself.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  // Same gate, same order as the channel-auth route: a PENDING MFA session
  // has no role AND no tenant by design, so it gets 403 rather than a
  // channel (even null — "no channel" is information about the session that
  // an unverified login should not receive).
  if (auth.user.mfaPending || !auth.user.role) {
    return NextResponse.json(
      {
        error:
          "Multi-factor authentication is required before realtime channel discovery.",
      },
      { status: 403 },
    );
  }

  // `NEXT_PUBLIC_*` values are baked into the browser bundle at build time,
  // while APINATOR_* credentials are runtime-only. If the server cannot sign a
  // private-channel authorization, do not hand the client a channel name that
  // will produce a connected WebSocket with no usable subscription.
  if (!apinatorServerConfig()) {
    return NextResponse.json({ enabled: false, channel: null });
  }

  // Super-admin: no tenant → no tenant channel. See the header note for why
  // (poll-only) is safer than a cross-tenant event stream.
  if (isSuperAdminUser(auth.user)) {
    return NextResponse.json({ enabled: true, channel: null });
  }

  // The tenant comes from the SESSION, exactly as the auth route will
  // re-derive it. tenantIdOrThrow cannot fire past the two gates above (a
  // role-holding non-superadmin always has a tenant), so this try is
  // defence in depth for a malformed session — fail closed at 403, the
  // status the gates themselves produce.
  try {
    const tenantId = tenantIdOrThrow(auth.user.tenantId);
    return NextResponse.json({ enabled: true, channel: tenantChannel(tenantId) });
  } catch {
    return NextResponse.json(
      { error: "This session is not scoped to a tenant." },
      { status: 403 },
    );
  }
}
