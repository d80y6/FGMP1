/**
 * Standalone Apinator demo server (replaces the retired socket.io demo).
 * ─────────────────────────────────────────────────────────────────────────────
 * The original demo ran a self-hosted socket.io server on :3003 that browsers
 * reached through the Caddy gateway's old `?XTransformPort=` open proxy — a
 * pattern this project removed for security (see the Caddyfile header). This
 * version shows the hosted pattern instead: there is no long-lived server
 * socket at all. The server only
 *
 *   1. authorizes private/presence channel subscriptions (POST /realtime/auth)
 *   2. publishes events via the signed REST API          (POST /send)
 *
 * and Apinator (ws-{cluster}.apinator.io) handles the WebSocket fan-out.
 * The production app implements the exact same two responsibilities inside
 * Next.js — see src/app/api/fgmp/realtime/auth/route.ts and
 * src/lib/fgmp/realtime-emitter.ts.
 *
 * Run:  APINATOR_APP_ID=… APINATOR_KEY=… APINATOR_SECRET=… APINATOR_CLUSTER=eu \
 *       bun examples/websocket/server.ts
 */

import { createServer } from "http";
import { Apinator } from "@apinator/server";

const APP_ID = process.env.APINATOR_APP_ID;
const KEY = process.env.APINATOR_KEY;
const SECRET = process.env.APINATOR_SECRET;
const CLUSTER = process.env.APINATOR_CLUSTER ?? "eu";
const PORT = 3004;

if (!APP_ID || !KEY || !SECRET) {
  console.error("Set APINATOR_APP_ID, APINATOR_KEY, APINATOR_SECRET (and optionally APINATOR_CLUSTER).");
  process.exit(1);
}

const apinator = new Apinator({ appId: APP_ID, key: KEY, secret: SECRET, cluster: CLUSTER });

/** The demo's single channel. `presence-` = private + a live member roster. */
const CHANNEL = "presence-chat-demo";

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "POST" && req.url === "/realtime/auth") {
    // Channel authorization: the browser SDK POSTs { socket_id, channel_name }
    // (its authEndpoint defaults to /auth, so this path is passed explicitly).
    // In a real app the session — not a demo header — decides who may join.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { socket_id: socketId, channel_name: channelName, user_id: userId } = JSON.parse(body);
        if (typeof socketId !== "string" || typeof channelName !== "string") {
          return send(400, { error: "socket_id and channel_name are required" });
        }
        if (channelName !== CHANNEL) return send(403, { error: "unknown channel" });
        // Presence channels require channel_data identifying the member.
        const auth = apinator.authenticateChannel(
          socketId,
          channelName,
          JSON.stringify({ user_id: String(userId ?? "anonymous"), user_info: { name: String(userId ?? "anonymous") } }),
        );
        send(200, auth);
      } catch {
        send(400, { error: "invalid JSON body" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/send") {
    // Server-side publish: a signed REST call, no socket held by the server.
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { name, data } = JSON.parse(body);
        if (typeof name !== "string") return send(400, { error: "name is required" });
        await apinator.trigger({ name, channel: CHANNEL, data: JSON.stringify(data ?? null) });
        send(200, { ok: true });
      } catch (err) {
        send(502, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }

  send(404, { error: "not found", hint: "POST /realtime/auth or POST /send" });
});

server.listen(PORT, () => {
  console.log(`Apinator demo server on http://localhost:${PORT}`);
  console.log(`  auth  : POST /realtime/auth  ({ socket_id, channel_name, user_id })`);
  console.log(`  send  : POST /send           ({ name, data }) → channel "${CHANNEL}"`);
});
