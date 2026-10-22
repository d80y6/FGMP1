"use client";

/**
 * FGMP Realtime Client Hook — Apinator.io hosted channels
 * ─────────────────────────────────────────────────────────────────────────
 * Connects the browser to Apinator.io, a hosted Pusher-style realtime
 * service. This replaces the old self-hosted socket.io mini-service
 * (port 3003 behind the Caddy gateway) AND the `state:tick` snapshot push
 * it used to carry.
 *
 * FULLY EVENT-DRIVEN ARCHITECTURE (read this before "fixing" anything):
 *   There is NO `state:tick` anymore — the server never pushes whole
 *   snapshots. The AppShell's 5-second poll is the ONLY state refresher.
 *   What realtime adds is latency, not data: every tenant event is an
 *   instant "refresh now" trigger that re-fetches /api/fgmp/state so the
 *   operator does not wait out the poll. A missed or dropped event is
 *   harmless — the poll reconciles the store within 5s regardless, which
 *   is why none of the handlers below apply payloads to the store
 *   directly (the old `state:tick` did exactly that, and it is gone).
 *
 * CHANNEL DISCOVERY: `GET /api/fgmp/realtime/channel` (same-origin, so the
 * NextAuth session cookie rides along) returns
 * `{ channel: "private-tenant-<tenantId>" }` for tenant members, or
 * `{ channel: null }` for SUPERADMIN — a cross-tenant operator must not
 * pin a single tenant's event stream. ANY !ok response (stale session 401,
 * the 403 emitted while MFA is still pending, 5xx, gateway hiccup) is
 * treated as "stay disconnected quietly": no retry storm, no console
 * noise. Polling keeps the UI live either way.
 *
 * NO ENV → NO CONNECTION (no dev fallbacks, by design): if
 * NEXT_PUBLIC_APINATOR_APP_KEY or NEXT_PUBLIC_APINATOR_CLUSTER ("eu"/"us")
 * is unset the hook never dials anything and reports `connected: false`
 * forever. The previous socket.io setup implicitly "worked" in dev because
 * the mini-service ran on localhost; hosted channels make realtime a
 * deployment concern, and a missing config must degrade to polling, not
 * to a half-configured client throwing on every render.
 *
 * CHANNEL AUTH: private channels require per-subscription authorization.
 * The client hands the SDK `authEndpoint: "/api/fgmp/realtime/auth"`,
 * which it POSTs `{ socket_id, channel_name }` (JSON) with the same-origin
 * session cookie. The old signed-token handshake existed ONLY because the
 * socket.io mini-service was a separate process that could not read the
 * NextAuth cookie — hosting the channels behind a route that CAN read it
 * removes the entire token minting/carrying layer.
 *
 * Provides:
 *   - `connected`: true when the Apinator connection is live (drives the
 *     header indicator + footer badge). The interface deliberately SHRANK:
 *     `lastTick` died with `state:tick`, and the room pub/sub helpers
 *     (`subscribeToSite`/`unsubscribeFromSite`/`subscribeToRegion`) died
 *     with the mini-service's rooms — events now fan out tenant-wide on
 *     the single channel the server assigns. Grep confirmed AppShell was
 *     the only consumer of this hook and only read `connected`.
 *
 * Tenant channel events handled (each is a "refresh now" trigger):
 *   - `alarm:new`          : toast + refresh (alarm list reconciles from API)
 *   - `alarm:ack`          : refresh
 *   - `alarm:resolve`      : refresh
 *   - `command:status`     : refresh (generator states reconciled)
 *   - `delivery:update`    : refresh (delivery status reconciled)
 *   - `telemetry:new`      : refresh (snapshot reconciled)
 *   - `maintenance:update` : refresh
 *
 * Resilience: the SDK auto-reconnects and re-authorizes + resubscribes
 * every channel after a drop (its own state machine goes
 * connecting→connected and replays subscriptions), so there is no manual
 * resubscribe logic here. Pass `{ enabled: false }` to suspend the
 * connection entirely (e.g. "Pause live", or while the session is
 * loading) — the hook tears the client down; re-enabling rebuilds it
 * from scratch, including a fresh channel-discovery fetch.
 */

import { useEffect, useRef, useState } from "react";
import { Apinator, type Channel, type ConnectionState } from "@apinator/client";
import { toast } from "sonner";
import { useFgmp } from "@/lib/fgmp/store";
import { useLanguage } from "@/lib/fgmp/use-language";
import { translate } from "@/lib/fgmp/i18n";

// NEXT_PUBLIC_* vars are inlined by Next.js at build time, so reading them
// into module-level constants is safe AND keeps the effect body free of
// per-run config parsing. There is deliberately no dev fallback: missing
// config means "realtime off", and the app-shell poll keeps the UI live.
const APINATOR_APP_KEY = process.env.NEXT_PUBLIC_APINATOR_APP_KEY;
const APINATOR_CLUSTER = process.env.NEXT_PUBLIC_APINATOR_CLUSTER;

// Same-origin Next.js routes: discovery decides IF/WHAT to subscribe to,
// auth (handed to the SDK below) proves THIS socket may join the channel.
const CHANNEL_ENDPOINT = "/api/fgmp/realtime/channel";
const AUTH_ENDPOINT = "/api/fgmp/realtime/auth";

// Events the server emits on the tenant channel. alarm:new carries a
// payload worth toasting about; every event — alarm:new included — is a
// "refresh now" trigger. There is no state:tick in this list and none is
// coming back: the poll owns state freshness, events only accelerate it.
const TENANT_EVENTS = [
  "alarm:new",
  "alarm:ack",
  "alarm:resolve",
  "command:status",
  "delivery:update",
  "telemetry:new",
  "maintenance:update",
] as const;

export interface RealtimeHook {
  connected: boolean;
}

interface AlarmPayload {
  id?: string;
  type?: string;
  severity?: string;
  message?: string;
  siteId?: string;
}

/**
 * The server serializes event payloads as JSON strings. The SDK tries to
 * `JSON.parse` them before invoking callbacks (and hands back the raw
 * string when parsing fails or the payload was never JSON), so a handler
 * may legitimately receive either shape — normalize here before reading
 * fields off a payload. Non-JSON strings flow through untouched; the
 * optional chaining in the callers copes with whatever remains.
 */
function parsePayload(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

export function useRealtime(opts?: { enabled?: boolean }): RealtimeHook {
  const enabled = opts?.enabled ?? true;
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<Apinator | null>(null);
  const channelRef = useRef<Channel | null>(null);

  useEffect(() => {
    // When disabled, drop any existing connection and stop pushing updates.
    // unbind → disconnect → null the refs, in that order: the handlers must
    // be dead before disconnect() runs so a late SDK state transition can
    // not flip `connected` behind React's back.
    if (!enabled) {
      if (channelRef.current) {
        channelRef.current.unbindAll();
        channelRef.current = null;
      }
      if (clientRef.current) {
        clientRef.current.unbind("state_change");
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnected(false);
      return;
    }

    // The channel-discovery fetch below is async, so `enabled` may flip or
    // the component may unmount while it is in flight. `cancelled` makes a
    // late resolution a no-op — once cleanup has run, no client may be
    // built, connected to, or subscribed with. (Checked after every await;
    // the build-connect-subscribe tail is synchronous, so no further guard
    // is needed inside it.)
    let cancelled = false;

    void (async () => {
      // Missing env → realtime is off entirely. Do not even hit discovery;
      // `connected` stays false (nothing ever set it true) and polling
      // keeps the dashboard live. No dev fallbacks.
      if (!APINATOR_APP_KEY || !APINATOR_CLUSTER) return;

      try {
        const res = await fetch(CHANNEL_ENDPOINT, { credentials: "same-origin" });
        if (cancelled) return;
        // Any !ok (401 stale session, 403 while MFA is pending, 5xx …)
        // means "stay disconnected quietly" — see the header note. The
        // poll keeps the UI live; the SDK's own reconnect logic does not
        // apply here because we never built a client.
        if (!res.ok) return;
        const discovered = (await res.json()) as { channel?: string | null };
        if (cancelled) return;
        // SUPERADMIN gets `channel: null`: a cross-tenant operator must
        // not pin one tenant's event stream, so they simply never
        // subscribe (and the badge honestly shows disconnected).
        if (!discovered.channel) return;

        const client = new Apinator({
          appKey: APINATOR_APP_KEY,
          cluster: APINATOR_CLUSTER,
          authEndpoint: AUTH_ENDPOINT,
        });
        clientRef.current = client;

        // Bind state BEFORE connect() so the very first transition to
        // "connected" is observed, not just later reconnects. The SDK
        // fires this global binding with { previous, current } on every
        // state machine move; "connected" is the only state that means
        // the badge may turn green.
        client.bind("state_change", (data) => {
          const change = parsePayload(data) as {
            previous?: ConnectionState;
            current?: ConnectionState;
          } | null;
          setConnected(change?.current === "connected");
        });

        client.connect();

        // One tenant channel, assigned by the server. Private channels
        // make the SDK POST { socket_id, channel_name } to AUTH_ENDPOINT
        // (same-origin cookies) — a rejected auth fails closed.
        const channel = client.subscribe(discovered.channel);
        channelRef.current = channel;

        for (const event of TENANT_EVENTS) {
          channel.bind(event, (raw: unknown) => {
            if (event === "alarm:new") {
              const alarm = parsePayload(raw) as AlarmPayload | null;
              const lang = useLanguage.getState().lang;
              const typeKey = alarm?.type ? `alarm.${alarm.type}` : "alarm.new";
              const translated = translate(typeKey, lang);
              const title =
                translated === typeKey ? translate("alarm.new", lang) : translated;
              const desc = alarm?.message;
              const sev = alarm?.severity;
              if (sev === "L3") toast.error(title, { description: desc });
              else if (sev === "L2") toast.warning(title, { description: desc });
              else toast.info(title, { description: desc });
            }
            // Realtime carries intent ("something changed"), never data.
            // Reconcile the store from /api/fgmp/state immediately — that
            // is the whole point of the event — and let the 5s poll cover
            // anything this push missed.
            void useFgmp.getState().refresh();
          });
        }
      } catch {
        // Discovery failed (offline, gateway hiccup, malformed body) →
        // stay disconnected quietly. No retry loop here on purpose: the
        // next `enabled` flip rebuilds everything, and polling keeps the
        // UI live in the meantime.
      }
    })();

    return () => {
      cancelled = true;
      if (channelRef.current) {
        channelRef.current.unbindAll();
        channelRef.current = null;
      }
      if (clientRef.current) {
        clientRef.current.unbind("state_change");
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}
