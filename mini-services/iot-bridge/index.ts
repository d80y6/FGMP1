/**
 * FGMP IoT Bridge Mini-Service
 * ─────────────────────────────────────────────────────────────────────────
 * Simulates the "edge gateway" layer that, in production, would subscribe to
 * MQTT/Modbus topics from on-site telemetry sensors and forward normalized
 * readings to the central FGMP platform.
 *
 * This service:
 *   1. Connects to the FGMP realtime service (port 3003) as a trusted
 *      server-client (auth: role="server" + token).
 *   2. Every 10 seconds, picks a random subset of sites (3–7) and generates
 *      a realistic telemetry reading per site:
 *        - Fuel tank level (litres) — small decrement
 *        - Generator status + load (kW)
 *        - Battery voltage + state of charge (%)
 *        - Ambient temperature (°C)
 *   3. POSTs each reading to `/api/fgmp/iot/ingest` (with the `x-api-key`
 *      header) so the Next.js API can persist a SensorReading row and push
 *      the update into the in-memory engine.
 *   4. Emits a `telemetry:new` event to the realtime service so connected
 *      browser clients receive per-site telemetry immediately (in addition
 *      to the 5s `state:tick` snapshot polling).
 *
 * Env vars (all optional, sensible dev defaults):
 *   NEXT_API_BASE             (default http://localhost:3000)
 *   REALTIME_URL              (default http://localhost:3003)
 *   IOT_API_KEY               (default fgmp-iot-dev-key)
 *   REALTIME_SERVER_SECRET    (default fgmp-realtime-dev-secret)
 *   INGEST_INTERVAL_MS        (default 10000)
 *   SITE_REFRESH_INTERVAL_MS  (default 300000)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Fuel Dispenser RS485 Register Map (Task 34-B)
 * ─────────────────────────────────────────────────────────────────────────
 * Each ESP32/ESP8266 controller exposes a Modbus RTU slave on the site's
 * RS485 bus at unit address 1–247 (configurable per dispenser). The
 * platform polls the following Modbus holding registers every 5–10s to
 * update the in-memory engine state. Writes (registers 40020+) are sent
 * from the cloud → ESP32 to authorize/stop/lock a fueling session.
 *
 * Holding Registers (function code 0x03 read / 0x10 write):
 *
 *   Addr  | Name                | Type    | R/W | Description
 *   ------+---------------------+---------+-----+------------------------------
 *   40001 | STATUS              | UINT16  | R   | 0=IDLE 1=AUTHORIZED 2=DISPENSING
 *         |                     |         |     | 3=STOPPED 4=FAULT 5=MAINTENANCE 6=OFFLINE
 *   40002 | CURRENT_VOLUME_L    | FLOAT32 | R   | Volume of in-progress txn (litres, ×10 fixed-point)
 *   40003 | FLOW_RATE_LPM       | UINT16  | R   | Flow rate (litres/min, ×10)
 *   40004 | PRESET_VOLUME_L     | UINT16  | R/W | Optional preset limit (litres, ×10); 0 = none
 *   40005 | NOZZLE_ACTIVE       | UINT16  | R   | Which nozzle (1..nozzleCount) is currently lifted
 *   40006 | TEMP_C              | INT16   | R   | Controller board temperature (°C, ×10)
 *   40007 | WIFI_RSSI           | INT16   | R   | WiFi signal (dBm, negative)
 *   40010 | TOTALIZER_L         | UINT32  | R   | Cumulative lifetime volume (litres, ×10, two registers)
 *   40012 | LAST_TXN_VOLUME_L   | UINT16  | R   | Volume of last completed txn (litres, ×10)
 *   40013 | LAST_TXN_AMOUNT_YER | UINT32  | R   | Amount of last txn (YER, two registers)
 *   40014 | LAST_TXN_DURATION_S | UINT16  | R   | Duration of last txn (seconds)
 *   40015 | LAST_TXN_TS         | UINT32  | R   | Unix epoch of last txn completion (two registers)
 *   40020 | AUTHORIZE_CMD       | UINT16  | W   | Write 1 → authorize a new session
 *   40021 | STOP_CMD            | UINT16  | W   | Write 1 → halt in-progress dispensing
 *   40022 | RESET_CMD           | UINT16  | W   | Write 1 → clear FAULT state
 *   40023 | LOCK_CMD            | UINT16  | W   | Write 1 → mode=LOCKED
 *   40024 | UNLOCK_CMD          | UINT16  | W   | Write 1 → mode=AUTO
 *   40025 | SET_PRESET_L        | UINT16  | W   | Write preset volume (litres, ×10); 0 = no preset
 *   40030 | MODE                | UINT16  | R   | 0=AUTO 1=MANUAL 2=LOCKED
 *   40031 | ESP_DEVICE_ID       | STRING  | R   | 16-byte ASCII (8 registers)
 *   40039 | ESP_FIRMWARE        | STRING  | R   | 8-byte ASCII (4 registers, e.g. "v1.2.1\0\0")
 *
 * Coils (function code 0x01 read / 0x05 write single):
 *
 *   Addr  | Name              | Description
 *   ------+-------------------+---------------------------------------------
 *   10001 | NOZZLE_1_LIFTED   | 1 = nozzle 1 currently in use
 *   10002 | NOZZLE_2_LIFTED   | 1 = nozzle 2 (if nozzleCount ≥ 2)
 *   10003 | NOZZLE_3_LIFTED   | 1 = nozzle 3 (if nozzleCount ≥ 3)
 *   10004 | NOZZLE_4_LIFTED   | 1 = nozzle 4 (if nozzleCount ≥ 4)
 *   10010 | COMM_HEARTBEAT    | Toggles every 5s to prove ESP32 is alive
 *
 * The cloud-side engine tick (src/lib/fgmp/engine.ts) re-simulates this
 * poll cycle in-process; in a production deployment the iot-bridge would
 * translate the platform's HTTP control calls (POST /api/fgmp/dispensers/
 * [id]/control) into Modbus writes (registers 40020–40025) on the next
 * poll cycle. This comment block is here to document the register map so
 * the firmware agent implementing the ESP32 sketch can stay in sync.
 */

import { io as ioc, type Socket } from "socket.io-client";
import { mtlsFetch } from "./mtls";

const NEXT_API_BASE = process.env.NEXT_API_BASE ?? "http://localhost:3000";
const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:3003";
const IOT_API_KEY = process.env.IOT_API_KEY ?? "fgmp-iot-dev-key";
const SERVER_SECRET =
  process.env.REALTIME_SERVER_SECRET ?? "fgmp-realtime-dev-secret";
// Service token for the Next.js `/api/fgmp/realtime/snapshot` endpoint.
// Required because `/api/fgmp/state` is wrapped in NextAuth session auth
// (Task 31-A); the iot-bridge cannot obtain a browser session.
const SERVICE_TOKEN =
  process.env.REALTIME_SERVICE_TOKEN ?? "fgmp-realtime-dev-token";
const SNAPSHOT_PATH =
  process.env.REALTIME_POLL_PATH ?? "/api/fgmp/realtime/snapshot";
const INGEST_INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS ?? 10000);
const SITE_REFRESH_INTERVAL_MS = Number(
  process.env.SITE_REFRESH_INTERVAL_MS ?? 5 * 60 * 1000,
);

interface SiteInfo {
  id: string;
  name: string;
  region: string;
}

interface TelemetryReading {
  tankLevel?: number;
  genStatus?: "running" | "stopped" | "fault";
  genLoad?: number;
  battVoltage?: number;
  battSoc?: number;
  temp?: number;
}

interface IngestPayload {
  siteId: string;
  readings: TelemetryReading;
}

// ── Connect to realtime service (server-side, direct — gateway N/A) ───────
const rt: Socket = ioc(REALTIME_URL, {
  path: "/",
  auth: { role: "server", token: SERVER_SECRET },
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 2000,
  reconnectionDelayMax: 15000,
  timeout: 8000,
});

rt.on("connect", () =>
  console.log(`[iot-bridge] realtime connected (id=${rt.id})`),
);
rt.on("disconnect", (r: string) =>
  console.log(`[iot-bridge] realtime disconnected: ${r}`),
);
rt.on("connect_error", (e: Error) =>
  console.error(`[iot-bridge] realtime connect_error: ${e.message}`),
);

// ── Site list (fetched from /api/fgmp/state, refreshed periodically) ──────
let sites: SiteInfo[] = [];

async function refreshSites(): Promise<void> {
  try {
    const res = await mtlsFetch(`${NEXT_API_BASE}${SNAPSHOT_PATH}`, {
      headers: {
        accept: "application/json",
        "x-service-token": SERVICE_TOKEN,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = (await res.json()) as {
      sites?: Array<{ id: string; name: string; region: string }>;
    };
    sites = (snap.sites ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      region: s.region,
    }));
    console.log(`[iot-bridge] loaded ${sites.length} sites from API`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[iot-bridge] refreshSites failed: ${msg}`);
  }
}

// ── Realistic telemetry generator ────────────────────────────────────────
function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

function genReading(site: SiteInfo): IngestPayload {
  const r: TelemetryReading = {};

  // Fuel tank — small decrement from a random starting level (litres)
  if (Math.random() < 0.85) {
    const base = 200 + Math.random() * 4800;
    r.tankLevel = Math.max(0, Math.round(base - 5));
  }

  // Generator status + load
  if (Math.random() < 0.8) {
    const roll = Math.random();
    if (roll < 0.78) {
      r.genStatus = "running";
      r.genLoad = Math.round((5 + Math.random() * 45) * 10) / 10;
    } else if (roll < 0.92) {
      r.genStatus = "stopped";
      r.genLoad = 0;
    } else {
      r.genStatus = "fault";
      r.genLoad = 0;
    }
  }

  // Battery voltage + state of charge
  if (Math.random() < 0.8) {
    r.battVoltage = Math.round((46 + Math.random() * 4) * 100) / 100;
    r.battSoc = Math.round(40 + Math.random() * 60);
  }

  // Ambient temperature
  if (Math.random() < 0.7) {
    r.temp = Math.round((22 + Math.random() * 18) * 10) / 10;
  }

  return { siteId: site.id, readings: r };
}

// ── One ingestion cycle ──────────────────────────────────────────────────
async function ingestOnce(): Promise<void> {
  if (sites.length === 0) {
    await refreshSites();
    if (sites.length === 0) return;
  }

  const n = 3 + Math.floor(Math.random() * 5);
  const batch = pickRandom(sites, n);
  let okCount = 0;
  let pushCount = 0;

  for (const site of batch) {
    const payload = genReading(site);

    // 1. POST to Next.js ingest endpoint (persisted as SensorReading rows)
    try {
      const res = await mtlsFetch(`${NEXT_API_BASE}/api/fgmp/iot/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": IOT_API_KEY,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) okCount++;
      else {
        const txt = await res.text().catch(() => "");
        console.error(
          `[iot-bridge] ingest ${site.name} (${site.id}) HTTP ${res.status}: ${txt.slice(0, 200)}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[iot-bridge] ingest ${site.id} error: ${msg}`);
    }

    // 2. Emit telemetry:new to realtime (for immediate browser push)
    if (rt.connected) {
      rt.emit("internal:broadcast", {
        event: "telemetry:new",
        payload: { ...payload, siteName: site.name, region: site.region, ts: Date.now() },
        room: `site:${site.id}`,
      });
      pushCount++;
    }
  }

  console.log(
    `[iot-bridge] cycle complete: ${okCount}/${batch.length} ingested, ${pushCount}/${batch.length} pushed to realtime (${rt.connected ? "rt-up" : "rt-down"})`,
  );
}

// ── Boot ─────────────────────────────────────────────────────────────────
console.log("─────────────────────────────────────────────────────────");
console.log(" FGMP IoT bridge service (edge gateway simulator)");
console.log(`  Next.js API  : ${NEXT_API_BASE}`);
console.log(`  Realtime URL : ${REALTIME_URL}`);
console.log(`  API key      : ${IOT_API_KEY === "fgmp-iot-dev-key" ? "(dev default)" : "(set via env)"}`);
console.log(`  Ingest every : ${INGEST_INTERVAL_MS}ms`);
console.log(`  Site refresh : ${SITE_REFRESH_INTERVAL_MS}ms`);
console.log("─────────────────────────────────────────────────────────");

await refreshSites();
setInterval(() => void refreshSites(), SITE_REFRESH_INTERVAL_MS);

// Initial ingest + scheduled cycle
void ingestOnce();
setInterval(() => void ingestOnce(), INGEST_INTERVAL_MS);

// ── Graceful shutdown ────────────────────────────────────────────────────
function shutdown(signal: string): void {
  console.log(`[iot-bridge] ${signal} received — shutting down`);
  rt.disconnect();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
