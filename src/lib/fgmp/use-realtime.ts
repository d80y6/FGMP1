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
 *   snapshots. Tenant events trigger immediate /api/fgmp/state reconciliation;
 *   a slow watchdog refresh remains to cover dropped events. Realtime carries
 *   intent, not state, so handlers never apply event payloads to the store.
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

    // Channel discovery can be interrupted by a navigation or a session
    // change. Any network / gateway failure gets a bounded retry, rather than
    // silently leaving realtime disabled for the rest of the mounted session.
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const retryDiscovery = () => {
      if (cancelled || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void discover();
      }, 15_000);
    };

    const discover = async () => {
      // Missing build-time config means no browser client can be constructed.
      // This is an operator configuration issue, not something to retry.
      if (!APINATOR_APP_KEY || !APINATOR_CLUSTER) return;

      try {
        const res = await fetch(CHANNEL_ENDPOINT, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          // Auth failures are not helped by a retry loop. Gateway/server
          // failures can be transient, so retry those at a quiet cadence.
          if (res.status >= 500) retryDiscovery();
          return;
        }
        const discovered = (await res.json()) as {
          enabled?: boolean;
          channel?: string | null;
        };
        if (cancelled || discovered.enabled === false) return;
        // SUPERADMIN gets `channel: null`: a cross-tenant operator must not
        // pin one tenant's event stream, so they use the ordinary reconciler.
        if (!discovered.channel) return;

        const client = new Apinator({
          appKey: APINATOR_APP_KEY,
          cluster: APINATOR_CLUSTER,
          authEndpoint: AUTH_ENDPOINT,
        });
        clientRef.current = client;

        // A live transport is not enough: show connected only after the
        // private channel has completed its server-side authorization.
        client.bind("state_change", (data) => {
          const change = parsePayload(data) as {
            previous?: ConnectionState;
            current?: ConnectionState;
          } | null;
          setConnected(
            change?.current === "connected" &&
              (channelRef.current?.subscribed ?? false),
          );
        });

        client.connect();

        // Private channel subscription POSTs { socket_id, channel_name } to
        // AUTH_ENDPOINT with same-origin cookies. A failed signature must
        // never show a false-green realtime badge.
        const channel = client.subscribe(discovered.channel);
        channelRef.current = channel;
        channel.bind("realtime:subscription_succeeded", () => setConnected(true));
        channel.bind("realtime:subscription_error", () => setConnected(false));

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
            // is the whole point of the event — and let the slower watchdog
            // reconciliation cover anything this push missed.
            void useFgmp.getState().refresh();
          });
        }
      } catch {
        // Offline, gateway error, or malformed response: keep polling as the
        // safe fallback and retry discovery after a quiet 15 seconds.
        retryDiscovery();
      }
    };

    void discover();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
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
