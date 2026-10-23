# FGMP Fuel Dispenser — ESP32 / ESP8266 RS485 Gateway Firmware

This package contains a **reference firmware** and **integration guide** for
connecting a fuel dispenser (Modbus RTU over RS485) to the FGMP — Fuel &
Generator Monitoring Platform using an ESP32 or ESP8266 microcontroller.

The ESP acts as a **Modbus RTU master**, polls the dispenser every 2 seconds,
maintains a local transaction state machine, and pushes normalized telemetry to
the FGMP platform every 5 seconds over HTTPS. It also polls the platform every
3 seconds for authorize / stop / reset commands and writes them into the
dispenser's Modbus register map.

---

## 1. Hardware

### 1.1 Bill of materials

| # | Part                                  | Notes                                                          |
|---|---------------------------------------|----------------------------------------------------------------|
| 1 | ESP32 DevKit V1 (38-pin)              | Or ESP8266 NodeMCU 1.0 (ESP-12E). Both supported.              |
| 2 | MAX485 TTL-to-RS485 module            | 5 V tolerant; uses DI / RO / DE / RE pins.                     |
| 3 | 12 V → 5 V buck converter (3 A)       | Powers the ESP, the MAX485, and (optionally) the dispenser IO. |
| 4 | 120 Ω termination resistor            | Installed at each physical end of the RS485 bus.                |
| 5 | Dispenser with Modbus RTU slave port  | Default baud 9600, 8N1, unit address 1–247.                    |
| 6 | 2 × momentary push-buttons            | Optional: onboard FLASH / RESET for provisioning / factory wipe. |

### 1.2 Wiring — ESP32 + MAX485

The ESP32 sketch uses the **hardware `Serial2`** UART on GPIO 16 (RX) and
GPIO 17 (TX). Direction control (DE + RE tied together) is on GPIO 4. A logic
HIGH on GPIO 4 enables transmit; LOW enables receive.

```
   ESP32 DevKit                       MAX485 module
  ┌───────────────┐                  ┌──────────────┐
  │           GND ├──────────────────┤ GND          │
  │           5V0 ├──────────────────┤ VCC          │
  │               │                  │              │
  │   GPIO 17 (TX)├─────────────────►│ DI  (data in)│
  │   GPIO 16 (RX)│◄─────────────────┤ RO  (data out)│
  │   GPIO  4     ├──────────────────┤ DE  ┐        │
  │               │            ┌─────┤ RE  ┘ (DE+RE tied)
  │               │            │     │              │
  └───────────────┘            │     └──────┬───────┘
                               │            │
                          120 Ω term.       │ A (+) ──────► to dispenser A
                          (bus end only)    │ B (-) ──────► to dispenser B
                                           │
                                       Dispenser
                                       Modbus RTU slave
```

**Power:** Feed the buck converter from the dispenser's 12 V auxiliary rail
(or a separate 12 V PSU). The MAX485 module is powered from the ESP's 5 V pin.
Do **not** power the MAX485 from 3.3 V — many clones are unstable below 5 V.

**RS485 bus rules:**
- Twisted-pair cable (e.g. Belden 9841 or Cat5e with one pair used for A/B,
  another pair tied to GND at both ends as a drain).
- Maximum bus length: 1200 m at 9600 baud, derated for higher speeds.
- 120 Ω termination resistor **only at the two physical ends** of the trunk.
- Bias resistors (typically 390 Ω from A to 5 V and B to GND) are needed on
  one node if the dispenser does not provide fail-safe biasing internally.

### 1.3 Wiring — ESP8266 variant

The ESP8266 has only one usable hardware UART (Serial0, shared with the USB
debug port). The sketch uses `SoftwareSerial` on **D6 (RX)** and **D7 (TX)**,
with DE/RE control on **D5**. Pin numbering follows the NodeMCU "D" labels
(not the raw GPIO numbers).

```
   ESP8266 NodeMCU                    MAX485 module
  ┌───────────────┐                  ┌──────────────┐
  │           GND ├──────────────────┤ GND          │
  │           VIN ├──────────────────┤ VCC          │
  │               │                  │              │
  │   D7 (TX soft)├─────────────────►│ DI  (data in)│
  │   D6 (RX soft)│◄─────────────────┤ RO  (data out)│
  │   D5          ├──────────────────┤ DE  ┐        │
  │               │            ┌─────┤ RE  ┘ (DE+RE tied)
  └───────────────┘            │     └──────┬───────┘
                          120 Ω term.       │ A (+) ──────► dispenser A
                                           │ B (-) ──────► dispenser B
```

> Note: `SoftwareSerial` on the ESP8266 is reliable up to ~38400 baud. For
> dispensers that require 115200 baud, switch to the ESP32 build.

---

## 2. RS485 Modbus RTU register map

The dispenser exposes a Modbus RTU slave port. All registers below use the
**5-digit Modicon address** convention (offset +1 from the 0-based protocol
address). The "Addr (hex)" column is the value actually sent in the wire frame.

| Modicon | Addr (hex) | Type   | R/W | Unit   | Field                  | Description                                                       |
|---------|-----------|--------|-----|--------|------------------------|-------------------------------------------------------------------|
| 40001   | 0x0000    | u16    | R   | enum   | device_status          | 0=OFFLINE, 1=IDLE, 2=AUTHORIZED, 3=DISPENSING, 4=COMPLETED, 5=FAULT |
| 40002   | 0x0001    | u32    | R   | L      | current_volume_l       | Litres dispensed in the active transaction (high word first).     |
| 40003   | 0x0003    | float  | R   | L/min  | flow_rate_lpm          | Instantaneous flow rate (IEEE-754, 2 registers).                  |
| 40004   | 0x0005    | u32    | R/W | L      | preset_volume_l        | Authorized preset limit; 0 = no preset (unlimited).               |
| 40005   | 0x0007    | u16    | R   | enum   | nozzle_state           | 0=IN_HOLSTER, 1=OUT, 2=OUT_LOCKED                                |
| 40010   | 0x0009    | u32    | R   | L      | totalizer_litres       | Lifetime non-resettable total.                                    |
| 40011   | 0x000B    | u16    | R   | count  | transaction_count      | Cumulative transactions since manufacture.                        |
| 40020   | 0x0013    | u16    | R/W | enum   | authorize_command      | Write 1 to authorize a transaction (preset from 40004).           |
| 40021   | 0x0014    | u16    | R/W | enum   | stop_command           | Write 1 to halt the active transaction immediately.               |
| 40022   | 0x0015    | u16    | R/W | enum   | reset_command          | Write 1 to clear transaction state and return to IDLE.            |
| 40030   | 0x001D    | int16  | R   | °C     | temperature_c          | Fluid temperature at the nozzle.                                  |
| 40040   | 0x0027    | u16    | R   | bitmap | error_code             | Bitfield: bit0=flow_fault, bit1=nozzle_fault, bit2=comm_fault, ... |
| 40050   | 0x0031    | u16    | R   | BCD    | firmware_version       | e.g. 0x0103 = 1.03.                                               |

See **`modbus-register-map.md`** for the standalone register table, byte-level
Modbus frame examples (function 0x03 read, 0x06 write-single), and CRC-16
calculation notes.

---

## 3. FGMP platform integration

### 3.1 Telemetry ingestion

The ESP posts a JSON body every 5 seconds to:

```
POST  <SERVER_URL>/api/fgmp/iot/ingest
Headers:
  content-type: application/json
  x-api-key:    <TENANT_WRITE_API_KEY>  # tenant API key with write scope
```

The body conforms to the platform's `iotIngestSchema`
(see `src/lib/fgmp/schemas.ts`):

```json
{
  "siteId":   "SITE-ADEN-CENTRAL",
  "readings": {
    "tankLevel":  12.45,                // dispenser current_volume_l  (litres)
    "temp":       31.2,                 // dispenser temperature_c     (°C)
    "genLoad":    0,                    // reserved — 0 if no generator on this ESP
    "genStatus":  "running",            // reserved — omit if N/A
    "battVoltage": 0,                   // reserved — omit if N/A
    "battSoc":    0                     // reserved — omit if N/A
  }
}
```

Field mapping (dispenser register → iotIngestSchema):

| Dispenser register        | iotIngestSchema field | Notes                                                       |
|---------------------------|-----------------------|-------------------------------------------------------------|
| 40002 current_volume_l    | `readings.tankLevel`  | Active transaction volume in litres. Maps to the FGMP tank-level field for the dispenser's tank. |
| 40030 temperature_c       | `readings.temp`       | Fluid temperature.                                          |

The dispenser-specific fields that do **not** fit the current ingest schema
(`flow_rate_lpm`, `nozzle_state`, `device_status`, `transaction_count`,
`totalizer_litres`) are sent as **additional top-level fields** on the JSON
body. They are silently stripped by Zod (default non-strict behaviour) but are
visible to a future `/api/fgmp/iot/dispenser/ingest` endpoint and to any
logging layer in front of the route.

```json
{
  "siteId":   "SITE-ADEN-CENTRAL",
  "dispenserId":  "DISP-0007",
  "espDeviceId":  "ESP-DISP-0007",
  "readings": {
    "tankLevel":  12.45,
    "temp":       31.2
  },
  "dispenser": {
    "status":           "DISPENSING",
    "flowRateLpm":      38.7,
    "nozzleState":      "OUT",
    "presetVolumeL":    50,
    "totalizerLitres":  184237.5,
    "transactionCount": 9241,
    "errorCode":        0,
    "firmwareVersion":  259
  },
  "ts": 1730000000000
}
```

### 3.2 Command polling

Every 3 seconds the ESP issues:

```
GET  <SERVER_URL>/api/fgmp/iot/dispenser/commands?deviceId=<ESP_DEVICE_ID>
Headers:
  x-api-key:  <TENANT_WRITE_API_KEY>
```

A 200 response with one or more queued commands looks like:

```json
{
  "commands": [
    {
      "id":        "cmd_01HXYZ...",
      "action":    "authorize",          // authorize | stop | reset
      "presetL":   50,                   // optional — only on authorize
      "createdAt": "2024-10-01T09:14:22Z"
    }
  ]
}
```

The ESP writes the corresponding Modbus register (40020 / 40021 / 40022),
optionally writes 40004 (preset) for `authorize`, then ACKs the command:

```
POST <SERVER_URL>/api/fgmp/iot/dispenser/commands/ack
Headers:
  content-type: application/json
  x-api-key:    <TENANT_WRITE_API_KEY>
Body:
  { "commandId": "cmd_01HXYZ...", "status": "applied", "appliedAt": 1730000000000 }
```

> **Note on the command endpoints:** `/api/fgmp/iot/dispenser/commands` and the
> `/ack` companion are added by the FuelDispenser schema task (Task 34-B). The
> firmware is forward-compatible: if these routes are not yet deployed, the ESP
> logs a 404 once and falls back to the legacy control-command flow via
> `/api/fgmp/generators/<id>/control` (used for legacy generators). See
> `gateway-integration.md` for the full routing table.

### 3.3 WiFi provisioning

WiFi credentials and per-device configuration are stored in a single config
block at the top of the `.ino` file. For field deployment without recompilation,
the firmware also exposes a **captive portal** mode:

1. On first boot (or after a factory reset triggered by holding the FLASH
   button for 10 seconds), the ESP starts an open AP named
   `FGMP-DISP-XXXXXX` (last 6 of MAC).
2. Connecting to it triggers a captive portal at `http://192.168.4.1/`.
3. The operator enters SSID, password, server URL, dispenser ID, and ESP device
   ID via a small HTML form.
4. On submit, the values are written to NVS (ESP32) / LittleFS (ESP8266) and
   the ESP reboots into station mode.

The `Config` struct in the sketch mirrors the NVS layout so the two paths
(hard-coded `#define` defaults vs. NVS overrides) coexist cleanly.

### 3.4 OTA firmware update

The sketch includes the standard `ArduinoOTA` library. After first flash over
USB, future updates can be pushed:

- **Arduino IDE:** Tools → Port → Network Ports → `dispenser-esp-0007.local`.
- **PlatformIO:** `pio run -t upload --upload-port dispenser-esp-0007.local`.
- **Headless (CI):** `ota-flash.sh <host> <binary>` using `curl` against the
  ArduinoOTA UDP protocol (port 8266 / 3232).

The platform itself can also queue an OTA via the IotDevice OTA fields
(`otaTargetFw`, `otaStatus`). When the ESP polls commands and sees
`{ "action": "ota", "url": "https://...", "targetFw": "1.4.0" }`, it downloads
the binary over HTTPS and writes it to the OTA partition using the
`Update` library, then reboots. A brown-out guard ensures a failed download
never corrupts the running partition.

---

## 4. Field deployment checklist

Run through every item before leaving the site.

### 4.1 Pre-deployment (bench)

- [ ] Latest firmware flashed; boot banner shows correct `FIRMWARE_VERSION`.
- [ ] `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_URL`, `DISPENSER_ID`,
      `ESP_DEVICE_ID`, `RS485_ADDR`, `BAUDRATE` all set correctly.
- [ ] IotDevice row created in FGMP (`/api/fgmp/iot` admin view) with
      `serialNo` = ESP_DEVICE_ID and `firmware` = FIRMWARE_VERSION.
- [ ] FuelDispenser row created with `espDeviceId` pointing at the IotDevice.
- [ ] Modbus loop-back test: ESP + MAX485 + a Modbus slave simulator
      (e.g. `ModbusPal` or `diagslave`) → telemetry appears at
      `/api/fgmp/iot/ingest` and is reflected in the dashboard's
      dispenser widget.
- [ ] OTA smoke test: push a trivial firmware bump over the network.
- [ ] WiFi provisioning portal opens on factory reset.

### 4.2 Physical install

- [ ] 12 V auxiliary feed verified; buck converter output measures 5.0 ± 0.2 V
      under load.
- [ ] RS485 A/B wired with correct polarity (A to A, B to B). If the bus shows
      inverted signal levels, swap A/B at one node only.
- [ ] 120 Ω termination installed at the ESP end **and** at the dispenser end.
- [ ] Drain wire / shield grounded at one end only (typically the dispenser).
- [ ] ESP enclosure IP54+; antenna external if metal cabinet.
- [ ] Dispenser power-cycled; ESP reboots cleanly with the dispenser.

### 4.3 Network

- [ ] Site WiFi signal ≥ -70 dBm at the ESP mounting point.
- [ ] DHCP lease obtained; ESP reports a non-`0.0.0.0` IP in the boot banner.
- [ ] DNS resolves the FGMP API hostname from the ESP
      (`ping <SERVER_URL host>` from a laptop on the same network).
- [ ] Firewall rule opened for outbound HTTPS to the FGMP API.
- [ ] First telemetry POST returns `200 { ok: true, applied: {...} }` in the
      ESP serial log.

### 4.4 Functional verification

- [ ] Authorize command from FGMP UI → ESP log shows `authorize_command=1`
      written to register 40020 → dispenser nozzle enables.
- [ ] Lift nozzle → register 40002 increments → FGMP telemetry updates within
      5 s.
- [ ] Hang up nozzle → dispenser transitions to COMPLETED → ESP sends a final
      telemetry packet with the transaction volume.
- [ ] Stop command from FGMP mid-dispense → flow halts within 2 s.
- [ ] Reset command → dispenser returns to IDLE; transaction counter increments.
- [ ] Power-cycle the ESP mid-transaction → on reboot it re-syncs state from
      the dispenser's own `device_status` register (no double-counting).

### 4.5 Hand-over

- [ ] Serial log captured for the first 5 minutes of operation.
- [ ] `IotDevice.lastSeenAt` in FGMP is fresh (< 60 s old).
- [ ] Maintenance ticket created for any `error_code` bits set in register 40040.
- [ ] Site manager shown how to read the ESP's diagnostic LED pattern (see
      table below) and how to trigger a factory reset.

### 4.6 Diagnostic LED patterns (onboard LED)

| Pattern            | Meaning                                            |
|--------------------|----------------------------------------------------|
| Off                | Booted, healthy, connected.                        |
| Solid on           | Boot / WiFi connect in progress.                   |
| Slow blink (1 Hz)  | WiFi disconnected, retrying.                       |
| Fast blink (5 Hz)  | Modbus communication failure (no response in 3 s). |
| Triple pulse every 2 s | OTA download in progress.                     |
| Fast pulse continuously | Panic / exception caught, watchdog will reboot. |

---

## 5. Files in this package

| File                         | Purpose                                                          |
|------------------------------|------------------------------------------------------------------|
| `README.md`                  | This document.                                                   |
| `dispenser_esp32.ino`        | Reference firmware — ESP32 + hardware Serial2.                   |
| `dispenser_esp8266.ino`      | Reference firmware — ESP8266 + SoftwareSerial.                   |
| `modbus-register-map.md`     | Standalone register map + Modbus frame examples.                 |
| `gateway-integration.md`     | How the iot-bridge routes telemetry & commands; sequence diagram.|

## 6. Related platform code

- `mini-services/iot-bridge/index.ts` — Edge gateway simulator; production
  deployments install a hardened variant of this service on-site to buffer
  telemetry when the WAN link is down.
- `src/app/api/fgmp/iot/ingest/route.ts` — Next.js ingest endpoint that the ESP
  posts to. Auth via `x-api-key` header.
- `src/lib/fgmp/schemas.ts` — `iotIngestSchema` (Zod) — wire contract for the
  ingest payload.
- `prisma/schema.prisma` — `IotDevice` model (ESP metadata) and the new
  `FuelDispenser` model (added by Task 34-B) which holds the live fields the
  ESP writes to.
