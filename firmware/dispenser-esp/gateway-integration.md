# FGMP IoT Bridge — Dispenser Telemetry & Command Routing

This document describes how telemetry from a fuel dispenser connected to an
ESP (running the firmware in this package) flows through the FGMP IoT bridge
into the platform, and how commands flow back from the platform to the ESP. It
also includes a worked end-to-end sequence diagram of a complete fueling
transaction.

## 1. Components in the path

```
                       ┌─────────────────────┐
                       │   Fuel Dispenser    │
                       │  (Modbus RTU slave) │
                       └──────────┬──────────┘
                                  │ RS485 (A/B)
                                  │
                       ┌──────────▼──────────┐
                       │   ESP32 / ESP8266   │
                       │  (this firmware)    │
                       │  Modbus RTU master  │
                       └──────────┬──────────┘
                                  │ HTTPS (HTTPS-JSON)
                                  │   x-api-key auth
                                  ▼
   ┌────────────────────────────────────────────────────────────┐
   │  FGMP Next.js app  (port 3000)                              │
   │                                                              │
   │   /api/fgmp/iot/ingest              (POST telemetry)         │
   │   /api/fgmp/iot/dispenser/commands  (GET pending commands)   │
   │   /api/fgmp/iot/dispenser/commands/ack (POST ACK)            │
   │   /api/fgmp/iot                    (PATCH OTA / reboot)      │
   │                                                              │
   │   engine.ts (in-memory state)     SensorReading (Prisma)     │
   │   realtime-emitter.ts  ──►  socket.io to browsers            │
   └────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ optional (edge buffering)
                                  │
                       ┌──────────┴──────────┐
                       │  mini-services/      │
                       │  iot-bridge (Node)   │  ← simulator in dev;
                       │                      │    hardened edge gateway in prod
                       └─────────────────────┘
```

### 1.1 The `mini-services/iot-bridge/index.ts` mini-service

In development this service **simulates** the edge-gateway role: every
10 seconds it picks 3–7 random sites, fabricates a realistic telemetry
reading per site, and POSTs to `/api/fgmp/iot/ingest` with the
`x-api-key` header. It also emits `telemetry:new` to the realtime
service so browsers see per-site updates faster than the 5 s
`state:tick` snapshot.

In production the same Node process is hardened into an **edge gateway**
that:

- Talks the local fieldbus (Modbus RTU, MQTT, OPC-UA, …) to on-site
  devices, including the ESPs that run this firmware.
- Buffers telemetry to disk when the WAN link is down and replays it
  when connectivity returns.
- Provides a single authenticated egress channel (one `x-api-key`
  instead of N per-device keys).
- Aggregates many low-rate dispensers into a smaller number of HTTP
  POSTs to reduce cloud ingress load.

The ESP firmware in this package is designed to talk directly to the
Next.js ingest endpoint when the site has reliable internet, **or** to
hand telemetry to the on-site iot-bridge process when the site is
behind a NAT'd field LAN. The choice is purely a `SERVER_URL`
configuration difference (the platform endpoint vs. the bridge
endpoint, both of which speak the same `iotIngestSchema` JSON).

## 2. Telemetry ingest path

### 2.1 HTTP request

```
POST  <SERVER_URL>/api/fgmp/iot/ingest
Headers:
  content-type : application/json
  x-api-key    : <IOT_API_KEY>           # default dev: fgmp-iot-dev-key
Body (iotIngestSchema + dispenser extras):
  {
    "siteId":      "SITE-ADEN-CENTRAL",
    "dispenserId": "DISP-0007",           // future: enables dispenser write-path
    "espDeviceId": "ESP-DISP-0007",       // future: enables IotDevice.lastSeenAt
    "readings": {
      "tankLevel": 12.45,                  // current_volume_l, litres
      "temp":      31                       // temperature_c, °C
    },
    "dispenser": {                          // forward-compatible extras
      "status":           "DISPENSING",
      "flowRateLpm":      38.7,
      "nozzleState":      1,
      "presetVolumeL":    50,
      "totalizerLitres":  184237.5,
      "transactionCount": 9241,
      "errorCode":        0,
      "firmwareVersion":  259
    },
    "ts": 1730000000000
  }
```

### 2.2 Server-side processing (see `src/app/api/fgmp/iot/ingest/route.ts`)

1. **Auth** — the `x-api-key` header is compared against `process.env.IOT_API_KEY`
   (or the dev default `fgmp-iot-dev-key`). A mismatch returns `401 { error:
   "unauthorized" }`.
2. **Schema validation** — the body is parsed through `IngestBodySchema`
   (a Zod schema mirroring `iotIngestSchema` in `src/lib/fgmp/schemas.ts`).
   Unknown top-level keys (`dispenserId`, `espDeviceId`, `dispenser`, `ts`)
   are silently stripped by Zod's default non-strict behaviour. A validation
   failure returns `400 { error: "validation failed", issues: [...] }`.
3. **In-memory engine update** — for each reading field present:
   - `tankLevel` updates the matching `engine.tanks[*]` row (level, status,
     history, lastReadingAt).
   - `genStatus` / `genLoad` updates the matching `engine.generators[*]` row.
   - `battVoltage` / `battSoc` updates the matching `engine.batteries[*]` row.
   - `temp` is logged at site level (no engine object — just a SensorReading).
4. **Persistence** — a `SensorReading` row is inserted per metric (best-effort;
   `Promise.allSettled` so a DB hiccup never blocks the response).
5. **Realtime fan-out** — `emitToRealtime("telemetry:new", { siteId, readings,
   applied, ts }, "site:" + siteId)` pushes the update to every browser
   currently subscribed to the site via the FGMP realtime service.
6. **Response** — `200 { ok: true, applied: { tank?, generator?, battery? },
   ts: <ms> }`.

### 2.3 Mapping dispenser telemetry to the existing ingest schema

The current ingest endpoint is tank/generator/battery-centric because that
is what the original platform simulated. Dispenser telemetry is mapped onto
those fields as follows until the dedicated dispenser endpoint (Task 34-B)
lands:

| Dispenser field                  | Mapped to                 | Why                                                    |
|----------------------------------|---------------------------|--------------------------------------------------------|
| `current_volume_l` (40002)       | `readings.tankLevel`      | Volume in litres — the dispenser's "current tank activity" maps to the tank-level metric for the dispenser's tank. The dashboard's fuel view picks this up immediately. |
| `temperature_c` (40030)          | `readings.temp`           | Site-level ambient / fluid temperature.                |
| `device_status`, `flow_rate_lpm`, `nozzle_state`, `preset_volume_l`, `totalizer_litres`, `transaction_count`, `error_code`, `firmware_version` | `dispenser.*` (extras) | Forward-compatible: the next-gen dispenser endpoint will hydrate the `FuelDispenser` live fields directly from these. |

### 2.4 Mapping to the FuelDispenser live fields (future, Task 34-B)

The `FuelDispenser` model (added by the concurrent Task 34-B agent) holds the
"live" per-dispenser state. Once the dedicated `/api/fgmp/iot/dispenser/ingest`
route is wired, the mapping becomes a straight 1:1 write:

| `dispenser.*` field in body  | FuelDispenser column         |
|------------------------------|------------------------------|
| `status`                     | `status` (enum)              |
| `flowRateLpm`                | `flowRateLpm`                |
| `nozzleState`                | `nozzleState` (enum)         |
| `presetVolumeL`              | `presetVolumeL`              |
| `totalizerLitres`            | `totalizerLitres`            |
| `transactionCount`           | `transactionCount`           |
| `errorCode`                  | `errorCode`                  |
| `firmwareVersion`            | `firmwareVersion`            |
| (derived) `current_volume_l` | `currentVolumeL`             |

Until that route exists, the platform only sees the tank-level + temperature
projections; the full dispenser context is still visible in the raw request
body if the operator turns on request logging or proxies the ESP through the
edge iot-bridge.

## 3. Command path

### 3.1 ESP polls for pending commands

Every 3 seconds the ESP issues:

```
GET  <SERVER_URL>/api/fgmp/iot/dispenser/commands?deviceId=<ESP_DEVICE_ID>
Headers:
  x-api-key: <IOT_API_KEY>
```

The endpoint returns the next ≤ 16 queued commands for this device:

```json
{
  "commands": [
    {
      "id":        "cmd_01J9KQ…",
      "action":    "authorize",      // authorize | stop | reset | ota
      "presetL":   50,               // only present for authorize
      "targetFw":  "1.4.0",          // only present for ota
      "url":       "https://…",      // only present for ota
      "createdAt": "2024-10-01T09:14:22Z",
      "expiresAt": "2024-10-01T09:24:22Z"
    }
  ]
}
```

### 3.2 ESP executes and ACKs

The ESP writes the appropriate Modbus register(s) and then POSTs an ACK:

```
POST <SERVER_URL>/api/fgmp/iot/dispenser/commands/ack
Headers:
  content-type : application/json
  x-api-key    : <IOT_API_KEY>
Body:
  {
    "commandId": "cmd_01J9KQ…",
    "status":    "applied",            // applied | failed | unsupported
    "appliedAt": 1730000000000,
    "error":     "modbus timeout"      // optional, only when status=failed
  }
```

The platform marks the command as `APPLIED` (visible in the command audit
log) or `FAILED` (auto-creates a maintenance ticket of type `CORRECTIVE`
with the dispenser + ESP as the asset reference).

### 3.3 Fallback: legacy generator control path

When `/api/fgmp/iot/dispenser/commands` is not yet deployed (404), the ESP
firmware throttles the warning to once per 60 s and silently continues
polling. Field engineers who need authorize/stop/reset before the
dispenser-specific route ships can fall back to the existing generator
control endpoint:

```
POST /api/fgmp/generators/<id>/control
Body: { "command": "START" | "STOP" | "EMERGENCY_STOP" | "RESET", "reason": "..." }
```

mapped onto dispenser actions as:

| Generator command  | Dispenser action | Modbus register written |
|--------------------|------------------|-------------------------|
| START              | authorize        | 40020 = 1               |
| STOP               | stop             | 40021 = 1               |
| EMERGENCY_STOP     | stop             | 40021 = 1               |
| RESET              | reset            | 40022 = 1               |

This is intentionally a stopgap; once the dispenser route ships, retire the
generator mapping and use the native dispenser command set.

## 4. Error handling matrix

| Layer                              | Failure mode                       | Detection                                       | Recovery                                                                                |
|------------------------------------|------------------------------------|-------------------------------------------------|-----------------------------------------------------------------------------------------|
| ESP → dispenser (RS485)            | Cable cut / powered-off dispenser  | Modbus response timeout (500 ms) for 3 polls    | ESP marks `device_status=OFFLINE`; LED goes to triple-pulse pattern; telemetry keeps reporting OFFLINE so the platform sees the outage. |
| ESP → dispenser (RS485)            | CRC error / colliding master       | CRC mismatch on response                        | Single retry on the same poll cycle; if still bad, log `[mb] crc fail` and skip the cycle. |
| Dispenser internal                 | `error_code` bits set              | Bitmask in register 40040                       | ESP forwards `errorCode` in telemetry; platform auto-opens a `CORRECTIVE` ticket if any of bits 0–7 set. |
| ESP WiFi                           | AP down / bad credentials          | `WiFi.status() != WL_CONNECTED` for 20 s        | Auto-reconnect every 5 s; LED fast-blinks; telemetry + command polls are skipped (no network) but Modbus polling continues so the ESP still knows the dispenser's local state. |
| ESP → platform HTTP                | 5xx / network error                | `http.POST()` / `http.GET()` return code ≤ 0    | Logged; retried on the next 5 s / 3 s cycle. No backoff yet — keep the design simple.   |
| ESP → platform HTTP                | 401 unauthorized                   | HTTP 401 from ingest                            | Log `[http] 401` and stop posting until next reboot (avoid burning through bad-key retries). |
| ESP → platform HTTP                | 404 on `/dispenser/commands`       | HTTP 404                                        | Throttled warning every 60 s; falls back to legacy generator endpoint if configured.    |
| Platform ingest                    | Schema validation failure          | Zod `safeParse()` returns false                 | `400 { error: "validation failed", issues: [...] }`; ESP logs the response body.        |
| Platform ingest                    | Unknown siteId                     | Engine lookup returns no matching tank/gen/batt | `200 { ok: true, applied: {} }` (no writes); ESP cannot distinguish from success — the platform operator must monitor the `applied` object. |
| Platform ingest                    | DB write error                     | `Promise.allSettled` rejection                  | Logged server-side; response is still 200 (best-effort persistence).                    |
| Platform realtime fan-out          | Realtime service down              | `emitToRealtime` swallows the error             | Browser clients fall back to 5 s `state:tick` polling.                                  |
| ESP panic / hang                   | Infinite loop / unhandled exc      | Hardware watchdog (8 s ESP32 / 30 s ESP8266)    | Auto-reboot. Crash is recorded in the boot banner on next start.                       |
| Platform OTA                       | Binary download fails / corrupt    | `Update.write()` returns false / size mismatch  | `Update.abort()`; current partition is untouched; ESP reboots into the previous firmware and ACKs the OTA as `failed`. |

## 5. Sequence diagram — complete fueling transaction

A complete authorize → dispense → complete → record flow, with the ESP, the
dispenser, the FGMP Next.js API, and the operator's browser all participating.

```
   Operator            Browser              Next.js API           ESP (firmware)       Dispenser
   (FGMP UI)            (React)            (/api/fgmp/iot/*)      (this package)       (Modbus slave)
       │                   │                       │                    │                    │
       │ Click "Authorize │                       │                    │                    │
       │ 50 L" on DISP-07 │                       │                    │                    │
       ├──────────────────►│                       │                    │                    │
       │                   │ POST                  │                    │                    │
       │                   │ /api/fgmp/iot/        │                    │                    │
       │                   │  dispenser/commands   │                    │                    │
       │                   ├──────────────────────►│                    │                    │
       │                   │                       │ enqueue cmd:       │                    │
       │                   │                       │  {action:authorize,│                    │
       │                   │                       │   presetL:50}      │                    │
       │                   │  200 {queued}         │                    │                    │
       │                   │◄──────────────────────┤                    │                    │
       │                   │                       │                    │                    │
       │                   │                       │ ◄──── next 3 s poll (GET commands) ────┤
       │                   │                       ├───────────────────►│                    │
       │                   │                       │ 200 {commands:[...]}│                   │
       │                   │                       │◄───────────────────┤                    │
       │                   │                       │                    │                    │
       │                   │                       │            ESP writes 40004 (preset=50 L)│
       │                   │                       │                    ├───────────────────►│
       │                   │                       │                    │  Modbus 0x06 echo  │
       │                   │                       │                    │◄───────────────────┤
       │                   │                       │            ESP writes 40020 = 1          │
       │                   │                       │                    ├───────────────────►│ (authorize)
       │                   │                       │                    │  Modbus 0x06 echo  │
       │                   │                       │                    │◄───────────────────┤
       │                   │                       │            Dispenser → AUTHORIZED        │
       │                   │                       │                    │                    │
       │                   │                       │ POST /ack {status:applied}               │
       │                   │                       │◄───────────────────┤                    │
       │                   │                       │ 200                │                    │
       │                   │                       ├───────────────────►│                    │
       │                   │  realtime push        │                    │                    │
       │                   │  cmd_state:applied    │                    │                    │
       │                   │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤                    │                    │
       │ "Authorizing…"   │                       │                    │                    │
       │◄──────────────────┤                       │                    │                    │
       │                   │                       │                    │                    │
       │ Lift nozzle, squeeze trigger             │                    │                    │
       │ (at the pump)    │                       │                    │                    │
       │                   │                       │            Dispenser → DISPENSING        │
       │                   │                       │                    │                    │
       │                   │                       │ ◄──── 2 s poll (Modbus read 0x03) ──────┤
       │                   │                       │                    │  status=DISPENSING │
       │                   │                       │                    │  current_volume=2.4│
       │                   │                       │                    │  flow_rate=38.7    │
       │                   │                       │                    │◄───────────────────┤
       │                   │                       │                    │                    │
       │                   │                       │ ◄──── 5 s POST /iot/ingest ─────────────┤
       │                   │                       │  {tankLevel:2.4,   │                    │
       │                   │                       │   dispenser:{…}}   │                    │
       │                   │                       ├───────────────────►│                    │
       │                   │                       │ 200 {applied:{tank}}│                   │
       │                   │                       │◄───────────────────┤                    │
       │                   │  realtime push        │                    │                    │
       │                   │  telemetry:new        │                    │                    │
       │                   │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤                    │                    │
       │ UI: "DISP-07:    │                       │                    │                    │
       │  2.4 L @ 38.7 L/m"│                       │                    │                    │
       │◄──────────────────┤                       │                    │                    │
       │                   │                       │                    │                    │
   (… repeat every 5 s; current_volume grows from 2.4 → 12.5 → 24.8 → 38.1 → 50.0 L …)        │
       │                   │                       │                    │                    │
       │                   │                       │ ◄──── 2 s poll ─────────────────────────┤
       │                   │                       │                    │ status=COMPLETED   │
       │                   │                       │                    │ current_volume=50.0│
       │                   │                       │                    │ tx_count=9242      │
       │                   │                       │                    │◄───────────────────┤
       │                   │                       │ ◄──── 5 s POST /iot/ingest ─────────────┤
       │                   │                       │  {tankLevel:50.0,  │                    │
       │                   │                       │   dispenser:{status:│                   │
       │                   │                       │    COMPLETED, ...}}│                    │
       │                   │                       ├───────────────────►│                    │
       │                   │                       │ 200 {applied:{tank}}│                   │
       │                   │                       │◄───────────────────┤                    │
       │                   │  realtime push        │                    │                    │
       │                   │  telemetry:new        │                    │                    │
       │                   │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤                    │                    │
       │                   │                       │                    │                    │
       │                   │                       │ Platform detects    │                    │
       │                   │                       │ status: COMPLETED   │                    │
       │                   │                       │ + current_volume    │                    │
       │                   │                       │   reached preset    │                    │
       │                   │                       │ → INSERT            │                    │
       │                   │                       │   FuelTransaction   │                    │
       │                   │                       │   (via Task 34-B)   │                    │
       │                   │                       │ → INSERT AuditLog   │                    │
       │                   │                       │ → emitToRealtime    │                    │
       │                   │                       │   "transaction:new" │                    │
       │                   │  realtime push        │                    │                    │
       │                   │  transaction:new      │                    │                    │
       │                   │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤                    │                    │
       │ UI toast:         │                       │                    │                    │
       │ "DISP-07 completed│                       │                    │                    │
       │  50.0 L — logged" │                       │                    │                    │
       │◄──────────────────┤                       │                    │                    │
       │                   │                       │                    │                    │
       │                   │                       │            ESP writes 40022 = 1 (reset)  │
       │                   │                       │                    ├───────────────────►│ (reset)
       │                   │                       │                    │  Modbus 0x06 echo  │
       │                   │                       │                    │◄───────────────────┤
       │                   │                       │            Dispenser → IDLE             │
       │                   │                       │                    │                    │
       │                   │                       │ ◄──── next 2 s poll: status=IDLE, cur=0 ─┤
       │                   │                       │ ◄──── next 5 s POST: tankLevel=0, etc. ──┤
       │                   │                       │ 200 {applied:{tank}}│                   │
       │                   │                       │◄───────────────────┤                    │
       │                   │  realtime push        │                    │                    │
       │                   │  telemetry:new        │                    │                    │
       │                   │◄ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤                    │                    │
       │                   │                       │                    │                    │
       │            System returns to quiescent IDLE; ready for next authorize.                │
```

### 5.1 Transaction-recording rules (platform side)

A `FuelTransaction` row is inserted when the platform observes the
following **transition** in consecutive telemetry packets from the same
dispenser:

- Previous `dispenser.status` = `DISPENSING`
- Current `dispenser.status` = `COMPLETED`
- AND `current_volume_l` ≥ `preset_volume_l × 0.98` (tolerance for
  slow-stop overrun; bit 5 of `error_code` is set if the tolerance is
  breached — that still records a transaction but flags it as
  `preset_mismatch`).

The recorded transaction captures:

| Field              | Source                                          |
|--------------------|-------------------------------------------------|
| `dispenserId`      | telemetry `dispenserId`                         |
| `siteId`           | telemetry `siteId`                              |
| `volumeLitres`     | final `current_volume_l` (register 40002)       |
| `presetLitres`     | `preset_volume_l` (register 40004)              |
| `flowRateAvgLpm`   | mean of `flow_rate_lpm` across DISPENSING window|
| `temperatureC`     | `temperature_c` at completion                   |
| `startedAt`        | timestamp of first DISPENSING telemetry packet  |
| `endedAt`          | timestamp of COMPLETED telemetry packet         |
| `espDeviceId`      | telemetry `espDeviceId`                         |
| `errorFlags`       | `errorCode` bitmask at completion               |
| `auditUserId`      | the operator who issued the authorize command   |

## 6. Related code reference

| File                                              | Role in this flow                                            |
|---------------------------------------------------|--------------------------------------------------------------|
| `firmware/dispenser-esp/dispenser_esp32.ino`      | ESP32 firmware — produces the JSON telemetry + polls commands. |
| `firmware/dispenser-esp/dispenser_esp8266.ino`    | ESP8266 variant (SoftwareSerial).                            |
| `mini-services/iot-bridge/index.ts`               | Edge gateway simulator in dev; hardened gateway in prod.    |
| `src/app/api/fgmp/iot/ingest/route.ts`            | Next.js ingest endpoint (auth + Zod + engine + persist + RT).|
| `src/app/api/fgmp/iot/route.ts`                   | IoT device list + OTA / reboot actions.                      |
| `src/lib/fgmp/schemas.ts`                         | `iotIngestSchema`, `iotReadingSchema`, `iotActionSchema`.    |
| `src/lib/fgmp/realtime-emitter.ts`                | `emitToRealtime()` — pushes events to the socket.io service. |
| `src/lib/fgmp/engine.ts`                          | In-memory engine state (tanks, generators, batteries).       |
| `prisma/schema.prisma`                            | `IotDevice` (ESP metadata) + `FuelDispenser` (Task 34-B).    |
