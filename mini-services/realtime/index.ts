/**
 * FGMP Realtime Mini-Service
 * ─────────────────────────────────────────────────────────────────────────
 * Standalone Bun + Socket.io server that:
 *   1. Polls the Next.js FGMP API every 5s and broadcasts `state:tick` snapshots
 *      to all connected browser clients.
 *   2. Accepts authenticated server-to-server emits from Next.js API routes
 *      (and the iot-bridge service) via the `internal:broadcast` event — those
 *      are re-broadcast as `alarm:new`, `alarm:ack`, `alarm:resolve`,
 *      `command:status`, `delivery:update`, `telemetry:new` to browsers.
 *   3. Supports room-based subscriptions: `subscribe:site`/`subscribe:region`
 *      join rooms `site:<id>` and `region:<name>` so targeted emits only reach
 *      interested clients.
 *
 * Browser clients connect through the Caddy gateway at `/socket.io` and MUST
 * present a short-lived signed token minted by
 * `GET /api/fgmp/realtime/token` as `auth: { role: "client", token }`.
 * Each socket is placed in a `tenant:<tenantId>` room and receives only that
 * tenant's slice of the snapshot. Server clients (Next.js API, iot-bridge)
 * connect directly to `http://localhost:3003` with
 * `auth: { role: "server", token: SERVER_SECRET }`.
 *
 * Env vars:
 *   REALTIME_PORT            (default 3003)
 *   REALTIME_ORIGIN          (default http://localhost:3000)
 *   NEXT_API_BASE            (default http://localhost:3000)
 *   POLL_INTERVAL_MS         (default 5000)
 *   REALTIME_SERVER_SECRET   (REQUIRED — no default)
 *   REALTIME_SERVICE_TOKEN   (REQUIRED — no default)
 *   REALTIME_TOKEN_SECRET    (REQUIRED — no default; shared with the Next.js app)
 */

import { createServer } from "http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Server, type Socket as IOSocket } from "socket.io";

const PORT = Number(process.env.REALTIME_PORT ?? 3003);
const ALLOWED_ORIGIN = process.env.REALTIME_ORIGIN ?? "http://localhost:3000";
const NEXT_API_BASE = process.env.NEXT_API_BASE ?? "http://localhost:3000";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);

/**
 * Secrets are REQUIRED with no development fallback. Every previous default
 * (fgmp-realtime-dev-secret / fgmp-realtime-dev-token) was committed to the
 * repo and shipped in the firmware/compose defaults, so a deployment that
 * forgot to set them ran with publicly-known credentials. Fail fast instead.
 */
function requireSecret(name: string, minLen = 16): string {
  const value = process.env[name];
  if (!value || value.length < minLen) {
    throw new Error(
      `${name} is missing or too short (min ${minLen} chars). Refusing to start.`,
    );
  }
  return value;
}

const SERVER_SECRET = requireSecret("REALTIME_SERVER_SECRET");
// Service token for the Next.js `/api/fgmp/realtime/snapshot` endpoint.
const SERVICE_TOKEN = requireSecret("REALTIME_SERVICE_TOKEN");
// Shared with the Next.js app; used to verify browser socket tokens.
const TOKEN_SECRET = requireSecret("REALTIME_TOKEN_SECRET", 32);
// The path to poll. Defaults to the service-token endpoint; can be
// overridden to `/api/fgmp/state` if the deployment disables auth.
const POLL_PATH =
  process.env.REALTIME_POLL_PATH ?? "/api/fgmp/realtime/snapshot";

interface ServerAuth {
  token?: string;
  role?: string;
}

interface ClientTokenPayload {
  sub: string;
  tid: string;
  role: string;
  exp: number;
}

function isServerAuth(auth: unknown): auth is ServerAuth {
  const a = auth as ServerAuth | undefined;
  return !!a && a.role === "server" && a.token === SERVER_SECRET;
}

function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

/**
 * Verify a browser socket token minted by GET /api/fgmp/realtime/token.
 * Mirror of `verifyRealtimeToken()` in src/lib/fgmp/realtime-token.ts — kept
 * in sync manually because this service is a separate process with no access
 * to src/. The signature is checked BEFORE the payload is parsed.
 */
function verifyClientToken(token: unknown): ClientTokenPayload | null {
  if (typeof token !== "string" || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);

  const expected = createHmac("sha256", TOKEN_SECRET).update(body).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(token.slice(dot + 1));
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let payload: ClientTokenPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload?.sub !== "string" ||
    typeof payload?.tid !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp <= Date.now()) return null;
  return payload;
}

const httpServer = createServer((req, res) => {
  // Minimal HTTP health probe. Socket.io attaches its own request handler
  // for engine.io handshakes (URLs containing EIO= query param); other URLs
  // fall through to this handler.
  if (req.url && (req.url === "/health" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "fgmp-realtime",
        port: PORT,
        clients: io.engine.clientsCount,
        uptime: process.uptime(),
        ts: Date.now(),
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", hint: "use socket.io" }));
});

const io = new Server(httpServer, {
  // The Caddy gateway proxies `/socket.io/*` to this service, so the browser
  // and the service agree on the default socket.io path.
  path: "/socket.io",
  cors: { origin: ALLOWED_ORIGIN, methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 10000,
});

// Auth middleware.
//
// Every connection must present EITHER a valid server secret (Next.js API
// routes / iot-bridge) OR a valid signed browser token. There is no anonymous
// path — previously the middleware only rejected clients that *claimed* to be
// a server with a bad token, so omitting `auth` connected freely and received
// the global cross-tenant snapshot.
io.use((socket, next) => {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  if (auth?.role === "server") {
    if (isServerAuth(auth)) return next();
    return next(new Error("unauthorized: invalid server credentials"));
  }

  const payload = verifyClientToken(auth?.token);
  if (!payload) {
    return next(
      new Error(
        "unauthorized: missing or invalid realtime token — fetch one from /api/fgmp/realtime/token",
      ),
    );
  }
  // Carry the verified identity into the connection handler. The tenantId is
  // signature-bound, so a client cannot choose another tenant's room.
  socket.data.userId = payload.sub;
  socket.data.tenantId = payload.tid;
  socket.data.role = payload.role;
  socket.data.isServer = false;
  next();
});

io.on("connection", (socket: IOSocket) => {
  const isServer = socket.data.isServer === true;
  const tenantId = (socket.data.tenantId as string | undefined) ?? null;
  const label = isServer ? "server" : `client:${socket.data.userId}`;
  console.log(
    `[realtime] ${label} connected: ${socket.id} (total=${io.engine.clientsCount})`,
  );

  // Browser sockets are pinned to their tenant's room. `state:tick` is fanned
  // out per-tenant, so a socket only ever receives its own fleet.
  if (!isServer && tenantId) {
    socket.join(`tenant:${tenantId}`);
  }

  // ── Browser subscriptions ─────────────────────────────────────────────
  socket.on("subscribe:site", (siteId: unknown) => {
    if (typeof siteId !== "string" || !siteId) return;
    socket.join(`site:${siteId}`);
    socket.emit("subscribed", { room: `site:${siteId}` });
  });
  socket.on("unsubscribe:site", (siteId: unknown) => {
    if (typeof siteId !== "string" || !siteId) return;
    socket.leave(`site:${siteId}`);
  });
  socket.on("subscribe:region", (name: unknown) => {
    if (typeof name !== "string" || !name) return;
    socket.join(`region:${name}`);
    socket.emit("subscribed", { room: `region:${name}` });
  });
  socket.on("unsubscribe:region", (name: unknown) => {
    if (typeof name !== "string" || !name) return;
    socket.leave(`region:${name}`);
  });

  // ── Internal: server-to-server broadcast ──────────────────────────────
  // Trusted server clients (Next.js API routes, iot-bridge) emit
  // `internal:broadcast` with `{ event, payload?, room? }`.
  //
  // These payloads describe a specific site (alarm:new, delivery:update, …),
  // so they are resolved to that site's TENANT and delivered only to sockets
  // in `tenant:<tid>`. A broadcast whose tenant cannot be resolved is
  // REJECTED rather than fanned out globally — previously this fell through
  // to `io.emit`, which pushed one tenant's alarms to every other tenant's
  // browsers.
  type BroadcastMsg = {
    event: string;
    payload?: unknown;
    room?: string;
  };
  socket.on(
    "internal:broadcast",
    (msg: BroadcastMsg, ack?: (r: unknown) => void) => {
      if (!isServer) {
        if (ack) ack({ ok: false, error: "forbidden" });
        return;
      }
      if (!msg || typeof msg.event !== "string" || msg.event.length === 0) {
        if (ack) ack({ ok: false, error: "invalid message" });
        return;
      }

      const siteId =
        typeof msg.room === "string" && msg.room.startsWith("site:")
          ? msg.room.slice("site:".length)
          : typeof (msg.payload as { siteId?: string } | undefined)?.siteId ===
              "string"
            ? (msg.payload as { siteId: string }).siteId
            : null;

      const tenantId = siteId ? siteTenant.get(siteId) : undefined;
      if (!tenantId) {
        // Fail closed: an unresolvable target must not become a global emit.
        if (ack) ack({ ok: false, error: "unresolvable tenant for broadcast" });
        console.warn(
          `[realtime] rejected broadcast "${msg.event}" — no tenant for site ${siteId ?? "(none)"}`,
        );
        return;
      }

      io.to(`tenant:${tenantId}`).emit(msg.event, msg.payload);
      if (ack) ack({ ok: true });
    },
  );

  socket.on("disconnect", (reason: string) => {
    console.log(
      `[realtime] ${label} disconnected: ${socket.id} (${reason}) (total=${io.engine.clientsCount})`,
    );
  });
  socket.on("error", (err: unknown) => {
    console.error(`[realtime] socket error (${socket.id}):`, err);
  });
});

// ── State polling loop ───────────────────────────────────────────────────
// One global poll (cheap), fanned out per-tenant. Each socket is in exactly
// one `tenant:<id>` room, and receives a snapshot filtered to that tenant.
let lastSnapshotSig: string | null = null;
let pollErrors = 0;

/**
 * siteId → tenantId, rebuilt from every successful poll. Used to resolve an
 * `internal:broadcast` (which identifies a site) to the tenant room that may
 * legitimately receive it.
 */
const siteTenant = new Map<string, string>();

/** Collections that are scoped by `siteId` and must be filtered per tenant. */
const SITE_SCOPED_KEYS = [
  "tanks",
  "generators",
  "batteries",
  "dispensers",
  "iotDevices",
  "fuelTransactions",
  "events",
  "gateways",
] as const;

interface GlobalSnapshot {
  tickCount?: number;
  now?: number;
  sites?: Array<{ id: string; tenantId?: string }>;
  [key: string]: unknown;
}

/**
 * Narrow a global snapshot to a single tenant. Mirrors the filtering the app
 * itself performs in `engine.snapshotForTenant(tenantId)`, so a browser sees
 * the same slice it would get from the authenticated REST API.
 *
 * Scalar KPI fields are recomputed only where they are cheap and unambiguous
 * (totals over the tenant's assets); the per-tenant counts the app computes
 * from the DB are left as fetched — the client re-reconciles them from
 * /api/fgmp/state on the next poll.
 */
function sliceForTenant(snap: GlobalSnapshot, tenantId: string): unknown {
  const sites = (snap.sites ?? []).filter((s) => s.tenantId === tenantId);
  const siteIds = new Set(sites.map((s) => s.id));

  const out: Record<string, unknown> = { ...snap, sites };
  for (const key of SITE_SCOPED_KEYS) {
    const arr = snap[key];
    if (!Array.isArray(arr)) continue;
    out[key] = arr.filter((row: { siteId?: string }) => !!row?.siteId && siteIds.has(row.siteId));
  }

  // Recompute the obvious fuel total over the tenant's tanks so a tenant
  // dashboard does not display another tenant's litres.
  const tanks = out.tanks as Array<{ current?: number }> | undefined;
  if (Array.isArray(tanks)) {
    out.totalFuelLitres = tanks.reduce((a, t) => a + (t?.current ?? 0), 0);
  }
  return out;
}

async function pollState(): Promise<void> {
  try {
    const res = await fetch(`${NEXT_API_BASE}${POLL_PATH}`, {
      headers: {
        accept: "application/json",
        "x-service-token": SERVICE_TOKEN,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = (await res.json()) as GlobalSnapshot;
    const sig = `${snap.tickCount ?? "?"}:${snap.now ?? "?"}`;
    if (sig === lastSnapshotSig) {
      // unchanged — skip broadcast (clients already have this state)
      return;
    }
    lastSnapshotSig = sig;
    broadcastStateTick(snap);
    pollErrors = 0;
  } catch (e) {
    pollErrors++;
    const msg = e instanceof Error ? e.message : String(e);
    if (pollErrors <= 3 || pollErrors % 10 === 0) {
      console.error(
        `[realtime] pollState failed (#${pollErrors}): ${msg} — retrying in ${POLL_INTERVAL_MS}ms`,
      );
    }
  }
}

/** Send each connected tenant its own slice; super-admin rooms get the rest. */
function broadcastStateTick(snap: GlobalSnapshot): void {
  const tenantIds = new Set<string>();
  const nextSiteTenant = new Map<string, string>();
  for (const s of snap.sites ?? []) {
    if (s?.tenantId) tenantIds.add(s.tenantId);
    if (s?.id && s?.tenantId) nextSiteTenant.set(s.id, s.tenantId);
  }
  // Replace wholesale so a deleted site stops resolving to a stale tenant.
  siteTenant.clear();
  for (const [k, v] of nextSiteTenant) siteTenant.set(k, v);

  let delivered = 0;
  for (const tenantId of tenantIds) {
    const room = io.sockets.adapter.rooms.get(`tenant:${tenantId}`);
    if (!room || room.size === 0) continue;
    io.to(`tenant:${tenantId}`).emit("state:tick", sliceForTenant(snap, tenantId));
    delivered += room.size;
  }

  // A SUPERADMIN's tenant has no sites of its own, so it is not in the
  // tenantId set derived above. Serve those rooms the full snapshot.
  for (const roomName of io.sockets.adapter.rooms.keys()) {
    if (!roomName.startsWith("tenant:")) continue;
    const tenantId = roomName.slice("tenant:".length);
    if (tenantIds.has(tenantId)) continue;
    io.to(roomName).emit("state:tick", snap);
    const room = io.sockets.adapter.rooms.get(roomName);
    delivered += room?.size ?? 0;
  }

  if (delivered > 0) {
    console.log(
      `[realtime] state:tick → ${delivered} client(s) (tick=${snap.tickCount ?? "?"})`,
    );
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log("─────────────────────────────────────────────────────────");
  console.log(`[realtime] listening    : http://0.0.0.0:${PORT}`);
  console.log(`[realtime] socket.io    : path=/socket.io (browser → /socket.io via gateway)`);
  console.log(`[realtime] CORS origin  : ${ALLOWED_ORIGIN}`);
  console.log(`[realtime] poll target  : ${NEXT_API_BASE}${POLL_PATH}`);
  console.log(`[realtime] poll every   : ${POLL_INTERVAL_MS}ms`);
  console.log("[realtime] auth         : server-secret + signed browser tokens (fail-closed)");
  console.log("─────────────────────────────────────────────────────────");
  // Immediate poll, then schedule.
  void pollState();
  setInterval(() => void pollState(), POLL_INTERVAL_MS);
});

// ── Graceful shutdown ────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`[realtime] ${signal} received — shutting down`);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Force-exit if close hangs
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
