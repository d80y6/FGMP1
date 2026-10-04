"use client";

/**
 * FGMP Realtime Client Hook
 * ─────────────────────────────────────────────────────────────────────────
 * Connects the browser to the FGMP realtime mini-service (socket.io on
 * port 3003) through the Caddy gateway at the fixed `/socket.io` path.
 *
 * AUTHENTICATION: the realtime service is a separate process and cannot read
 * the NextAuth session cookie, so each connection mints a short-lived signed
 * token from `GET /api/fgmp/realtime/token` and presents it in the socket.io
 * handshake `auth`. The service pins the socket to a `tenant:<tenantId>`
 * room, so a browser only ever receives its own tenant's snapshot. A token
 * that is missing, forged, or expired is rejected — there is no anonymous
 * connection path.
 *
 * Provides:
 *   - `connected`    : true when the socket is live
 *   - `lastTick`     : epoch ms of the most recent `state:tick` push
 *   - `subscribeToSite(siteId)` / `unsubscribeFromSite(siteId)`
 *                      : room-based pub/sub for per-site events
 *
 * Server → browser events handled:
 *   - `state:tick`     : replaces the Zustand snapshot with the latest push
 *   - `alarm:new`      : toast + refresh (next tick reconciles alarm list)
 *   - `alarm:ack`      : refresh (alarm list reconciled from API)
 *   - `alarm:resolve`  : refresh
 *   - `command:status` : refresh (generator states reconciled)
 *   - `delivery:update`: refresh (delivery status reconciled)
 *   - `telemetry:new`  : per-site telemetry (refresh keeps snapshot fresh)
 *
 * Fallback: if the realtime service is unreachable, the connection
 * auto-reconnects (socket.io-client default), and the AppShell's polling
 * loop continues to refresh state every few seconds. The UI shows a
 * "Reconnecting…" badge while disconnected.
 *
 * Pass `{ enabled: false }` to suspend the socket (e.g. when "Pause live"
 * is toggled on). The hook will disconnect and stop pushing updates.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";
import { toast } from "sonner";
import { useFgmp } from "@/lib/fgmp/store";
import { useLanguage } from "@/lib/fgmp/use-language";
import { translate } from "@/lib/fgmp/i18n";
import type { Snapshot } from "@/lib/fgmp/types";

export interface RealtimeHook {
  connected: boolean;
  lastTick: number;
  subscribeToSite: (siteId: string) => void;
  unsubscribeFromSite: (siteId: string) => void;
  subscribeToRegion: (region: string) => void;
}

interface AlarmPayload {
  id?: string;
  type?: string;
  severity?: string;
  message?: string;
  siteId?: string;
}

export function useRealtime(opts?: { enabled?: boolean }): RealtimeHook {
  const enabled = opts?.enabled ?? true;
  const [connected, setConnected] = useState(false);
  const [lastTick, setLastTick] = useState(0);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // When disabled, drop any existing socket and stop pushing updates.
    if (!enabled) {
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConnected(false);
      return;
    }

    // Connect via Caddy gateway — NEVER a direct localhost URL. The gateway
    // proxies the fixed `/socket.io/*` path to the realtime service; there is
    // no longer a `?XTransformPort=` query parameter (that pattern let a
    // client name ANY localhost port — an open proxy).
    //
    // `auth` is a callback so socket.io re-runs it on every reconnect. The
    // token is short-lived, and it is what proves the session to the realtime
    // service, which cannot read the NextAuth cookie.
    const socket = io("/socket.io", {
      path: "/socket.io",
      auth: (cb: (auth: { role: string; token: string }) => void) => {
        fetch("/api/fgmp/realtime/token", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((d: { token?: string }) => {
            if (!d?.token) throw new Error("no token");
            cb({ role: "client", token: d.token });
          })
          .catch(() => {
            // Hand the service something it will reject, so the connection
            // fails closed rather than opening an anonymous socket.
            cb({ role: "client", token: "" });
          });
      },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 10000,
      timeout: 10000,
      autoConnect: true,
    });
    socketRef.current = socket;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    socket.on("state:tick", (snap: Snapshot) => {
      useFgmp.setState({
        snapshot: snap,
        lastTickAt: Date.now(),
        error: null,
      });
      setLastTick(Date.now());
    });

    socket.on("alarm:new", (alarm: AlarmPayload) => {
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
      // Reconcile the alarm list from the API so the alarms view reflects
      // the new entry immediately (without waiting for the next tick).
      void useFgmp.getState().refresh();
    });

    socket.on("alarm:ack", () => {
      void useFgmp.getState().refresh();
    });
    socket.on("alarm:resolve", () => {
      void useFgmp.getState().refresh();
    });
    socket.on("command:status", () => {
      void useFgmp.getState().refresh();
    });
    socket.on("delivery:update", () => {
      void useFgmp.getState().refresh();
    });
    socket.on("telemetry:new", () => {
      // Per-site telemetry was applied server-side; the next state:tick
      // (≤ 5s) will reconcile the snapshot. No immediate action needed
      // — but if the user is currently viewing the affected site, a
      // refresh gives them sub-second feedback.
      void useFgmp.getState().refresh();
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  const subscribeToSite = useCallback((siteId: string) => {
    socketRef.current?.emit("subscribe:site", siteId);
  }, []);
  const unsubscribeFromSite = useCallback((siteId: string) => {
    socketRef.current?.emit("unsubscribe:site", siteId);
  }, []);
  const subscribeToRegion = useCallback((region: string) => {
    socketRef.current?.emit("subscribe:region", region);
  }, []);

  return {
    connected,
    lastTick,
    subscribeToSite,
    unsubscribeFromSite,
    subscribeToRegion,
  };
}
