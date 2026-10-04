/**
 * Server-side realtime emitter — used by Next.js API routes to push
 * event notifications to connected browser clients through the FGMP
 * realtime mini-service (socket.io on port 3003).
 *
 * Usage (server-side only):
 *   import { emitToRealtime } from "@/lib/fgmp/realtime-emitter";
 *   emitToRealtime("alarm:new", { id, type, message, severity });
 *   emitToRealtime("delivery:update", { deliveryId, status }, `site:${siteId}`);
 *
 * Architecture:
 *   - A single lazily-initialized socket.io-client connection is shared
 *     across all API route invocations (process-wide singleton).
 *   - The connection authenticates with `role: "server"` + a shared secret
 *     so the realtime service treats it as a trusted emitter.
 *   - The emitter sends `internal:broadcast` events; the realtime service
 *     then fans them out to browsers (optionally to a specific room).
 *   - If the realtime service is unreachable, emits are silently dropped —
 *     the realtime service's 5s state-polling loop still keeps browsers
 *     up-to-date with the latest snapshot, so the system degrades
 *     gracefully (polling fallback) rather than failing.
 *
 * Browser clients MUST NOT import this module. It is server-only and
 * connects directly to `http://localhost:3003` (bypassing the Caddy
 * gateway), which is only permitted server-side. Browser connections go
 * through the gateway via `io("/?XTransformPort=3003")`.
 */

import { io as ioc, type Socket } from "socket.io-client";

const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:3003";

/**
 * Shared secret for server-to-server emits. Fails closed — the previous
 * fallback (`fgmp-realtime-dev-secret`) was committed to the repo and was the
 * compose default, so a deployment that forgot to set it accepted emits from
 * anyone who read the source. Emits are now simply dropped when unset: the
 * realtime service's polling loop keeps browsers fresh regardless.
 */
const SERVER_SECRET = (() => {
  const v = process.env.REALTIME_SERVER_SECRET;
  if (!v || v.length < 16) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[realtime-emitter] REALTIME_SERVER_SECRET unset — server→browser emits are DISABLED.",
      );
    }
    return null;
  }
  return v;
})();

// Module-level singleton (one connection per Node.js process).
let socket: Socket | null = null;
let connecting: Promise<Socket> | null = null;

/**
 * Lazily connect (or reuse) the singleton server-side socket.io client.
 * Resolves with a connected-or-connecting socket; never throws — if the
 * realtime service is down, the returned socket is still usable (it will
 * buffer emissions until the connection is established, or drop them on
 * the floor if `connected === false`).
 */
function getSocket(): Promise<Socket> {
  // No secret configured — don't even dial. Polling fallback keeps the UI live.
  if (!SERVER_SECRET) return Promise.reject(new Error("realtime disabled"));
  if (socket && (socket.connected || socket.active)) {
    return Promise.resolve(socket);
  }
  if (connecting) return connecting;

  connecting = new Promise<Socket>((resolve) => {
    const s = ioc(REALTIME_URL, {
      path: "/",
      auth: { role: "server", token: SERVER_SECRET },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      timeout: 4000,
      autoConnect: true,
    });

    s.on("connect", () => {
      console.log("[realtime-emitter] connected to realtime service");
    });
    s.on("disconnect", (reason: string) => {
      console.log(`[realtime-emitter] disconnected: ${reason}`);
    });
    s.on("connect_error", (err: Error) => {
      // Suppress verbose errors — they fire repeatedly while the realtime
      // service is down. The state-polling fallback keeps the UI live.
      if (process.env.NODE_ENV !== "production") {
        console.error(`[realtime-emitter] connect_error: ${err.message}`);
      }
    });

    socket = s;

    // Resolve immediately so callers don't block; emissions are buffered
    // by socket.io-client until the connection is up (or dropped if it
    // never connects within the buffer window).
    resolve(s);
  });

  // Allow subsequent callers to reuse the same connection.
  void connecting.then(() => {
    connecting = null;
  });

  return connecting;
}

// Kick off the connection at module load on the server.
if (typeof window === "undefined") {
  void getSocket().catch(() => {});
}

/**
 * Push an event to all connected browser clients (or to a specific room
 * if `room` is provided). No-op if called from the browser or if the
 * realtime service is unreachable.
 *
 * @param event   The browser-facing event name (e.g. "alarm:new")
 * @param payload Arbitrary JSON-serializable payload
 * @param room    Optional room name (e.g. "site:<id>" or "region:<name>")
 */
export function emitToRealtime(
  event: string,
  payload?: unknown,
  room?: string,
): void {
  if (typeof window !== "undefined") return; // server-only guard
  void getSocket()
    .then((s) => {
      if (!s.connected) return; // drop — polling fallback covers freshness
      s.emit(
        "internal:broadcast",
        { event, payload, room },
        () => {
          /* ack received — no-op */
        },
      );
    })
    .catch(() => {
      /* realtime disabled or unreachable — polling fallback covers freshness */
    });
}

/**
 * Convenience helpers for the most common FGMP realtime events.
 */
export const realtime = {
  alarmNew: (alarm: {
    id: string;
    type: string;
    severity: string;
    message: string;
    siteId: string;
  }) => emitToRealtime("alarm:new", alarm, `site:${alarm.siteId}`),

  alarmAck: (alarmId: string, siteId: string) =>
    emitToRealtime("alarm:ack", { alarmId }, `site:${siteId}`),

  alarmResolve: (alarmId: string, siteId: string) =>
    emitToRealtime("alarm:resolve", { alarmId }, `site:${siteId}`),

  commandStatus: (cmd: {
    generatorId: string;
    command: string;
    status: string;
    siteId?: string;
  }) => {
    const room = cmd.siteId ? `site:${cmd.siteId}` : undefined;
    emitToRealtime("command:status", cmd, room);
  },

  deliveryUpdate: (delivery: {
    id: string;
    siteId: string;
    status: string;
  }) => emitToRealtime("delivery:update", delivery, `site:${delivery.siteId}`),

  telemetry: (reading: { siteId: string; readings: unknown }) =>
    emitToRealtime("telemetry:new", reading, `site:${reading.siteId}`),
};
