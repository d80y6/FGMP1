/**
 * FGMP IoT Bridge Mini-Service
 * ─────────────────────────────────────────────────────────────────────────
 * Simulates the "edge gateway" layer that, in production, would subscribe to
 * MQTT/Modbus topics from on-site telemetry sensors and forward normalized
 * readings to the central FGMP platform.
 *
 * This service:
 *   1. Every 10 seconds, picks a random subset of sites (3–7) and generates
 *      a realistic telemetry reading per site:
 *        - Fuel tank level (litres) — small decrement
 *        - Generator status + load (kW)
 *        - Battery voltage + state of charge (%)
 *        - Ambient temperature (°C)
 *   2. POSTs each reading to `/api/fgmp/iot/ingest` (with the `x-api-key`
 *      header) so the Next.js API can persist a SensorReading row. That
 *      ingest route pushes the update into Apinator (the hosted realtime
 *      provider) itself, so the bridge holds NO socket connection — realtime
 *      delivery is one HTTP hop: bridge → ingest → Apinator → browsers.
 *      (It used to also emit `internal:broadcast` over a socket.io connection
 *      to the retired self-hosted mini-service on :3003.)
 *   3. Polls `/api/fgmp/realtime/snapshot` with the REALTIME_SERVICE_TOKEN
 *      header to learn the site list (that endpoint stays because the bridge
 *      cannot obtain a NextAuth browser session).
 *
 * Env vars (service token required; other settings have development defaults):
 *   NEXT_API_BASE             (default http://localhost:3000)
 *   IOT_API_KEYS              (JSON object: tenantId -> tenant API key)
 *   REALTIME_SERVICE_TOKEN    (required secret, min 16 chars) — snapshot polling
 *   REALTIME_POLL_PATH        (default /api/fgmp/realtime/snapshot)
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

import { mtlsFetch } from "./mtls";
import { requireRealtimeServiceToken } from "./service-token";

const NEXT_API_BASE = process.env.NEXT_API_BASE ?? "http://localhost:3000";
const IOT_API_KEYS: Record<string, string> = (() => {
  const raw = process.env.IOT_API_KEYS;
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    const entries = Object.entries(value);
    if (entries.some(([tenantId, key]) => !tenantId || typeof key !== "string" || key.length < 16)) {
      throw new Error("each tenant entry needs a key of at least 16 characters");
    }
    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    console.error(`[iot-bridge] IOT_API_KEYS configuration invalid: ${message}`);
    return {};
  }
})();
// Service token for the Next.js `/api/fgmp/realtime/snapshot` endpoint.
// Required because `/api/fgmp/state` is wrapped in NextAuth session auth
// (Task 31-A); the iot-bridge cannot obtain a browser session.
const SERVICE_TOKEN = requireRealtimeServiceToken(
  process.env.REALTIME_SERVICE_TOKEN,
);
const SNAPSHOT_PATH =
  process.env.REALTIME_POLL_PATH ?? "/api/fgmp/realtime/snapshot";
const INGEST_INTERVAL_MS = Number(process.env.INGEST_INTERVAL_MS ?? 10000);
const SITE_REFRESH_INTERVAL_MS = Number(
  process.env.SITE_REFRESH_INTERVAL_MS ?? 5 * 60 * 1000,
);

interface SiteInfo {
  id: string;
  tenantId: string;
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

// ── No socket connection any more ─────────────────────────────────────────
// The bridge used to hold a persistent socket.io connection to the self-hosted
// realtime mini-service and emit `internal:broadcast` per reading. Realtime is
// hosted (Apinator) now and the ingest route triggers those events server-side
// after persisting the row, so a socket here would be a second, unauthenticated
// path to the same data — it was removed, not redirected.

// ── Site list (fetched from the service snapshot, refreshed periodically) ─
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
    const directory = (await res.json()) as {
      sites?: Array<{ id: string; tenantId: string }>;
    };
    sites = (directory.sites ?? []).map((site) => ({
      id: site.id,
      tenantId: site.tenantId,
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

  for (const site of batch) {
    const apiKey = IOT_API_KEYS[site.tenantId];
    if (!apiKey) {
      console.warn(`[iot-bridge] no write API key configured for tenant ${site.tenantId}; skipped site ${site.id}`);
      continue;
    }
    const payload = genReading(site);

    // POST to Next.js ingest endpoint (persisted as SensorReading rows; the
    // route then triggers the Apinator event that reaches browsers directly).
    try {
      const res = await mtlsFetch(`${NEXT_API_BASE}/api/fgmp/iot/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) okCount++;
      else {
        const txt = await res.text().catch(() => "");
        console.error(
          `[iot-bridge] ingest site ${site.id} HTTP ${res.status}: ${txt.slice(0, 200)}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[iot-bridge] ingest ${site.id} error: ${msg}`);
    }
  }

  console.log(
    `[iot-bridge] cycle complete: ${okCount}/${batch.length} ingested`,
  );
}

// ── Boot ─────────────────────────────────────────────────────────────────
console.log("─────────────────────────────────────────────────────────");
console.log(" FGMP IoT bridge service (edge gateway simulator)");
console.log(`  Next.js API  : ${NEXT_API_BASE}`);
console.log(`  Tenant keys  : ${Object.keys(IOT_API_KEYS).length} configured`);
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
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
