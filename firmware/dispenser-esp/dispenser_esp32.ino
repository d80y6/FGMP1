/* ===========================================================================
 * FGMP Fuel Dispenser Gateway — ESP32 reference firmware
 * -------------------------------------------------------------------------
 * Board:   ESP32 DevKit V1 (38-pin)
 * Arduino: >= 2.2.1 with the "esp32" board package (v3.x) installed.
 * Libraries (Arduino Library Manager):
 *     - ArduinoJson        by Benoit Blanchon  (v6.x or v7.x)
 *     - (ArduinoOTA is bundled with the esp32 package)
 *
 * Function:
 *   - Modbus RTU master over hardware Serial2 (GPIO16=RX, GPIO17=TX).
 *   - MAX485 DE/RE direction control on GPIO4 (HIGH = TX, LOW = RX).
 *   - Polls dispenser registers every 2 s; maintains a local state machine
 *     IDLE -> AUTHORIZED -> DISPENSING -> COMPLETED.
 *   - HTTP POST telemetry to FGMP every 5 s (iotIngestSchema shape).
 *   - HTTP GET command poll every 3 s; writes authorize/stop/reset to
 *     Modbus register 40020/40021/40022 and ACKs the command.
 *   - ArduinoOTA enabled on port 3232 (mDNS: dispenser-esp-<id>.local).
 *   - Hardware watchdog (Task watchdog, 8 s) + auto WiFi reconnect.
 *
 * Pin map (defaults — override in Config below):
 *   GPIO 4  -> MAX485 DE+RE (tied together on the MAX485 module)
 *   GPIO 16 -> ESP32 RX2 <- MAX485 RO
 *   GPIO 17 -> ESP32 TX2 -> MAX485 DI
 *   GPIO 2  -> onboard LED (active-low on most DevKit boards)
 *
 * ========================================================================== */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <esp_task_wdt.h>

// ───────────────────────────────────────────────────────────────────────────
// Config — edit this block per deployment. Values can also be overridden at
// runtime via the captive portal (see provisionWiFi()).
//
// SECURITY: apiKey MUST be the deployment's real IOT_API_KEY. The server
// has no default — if IOT_API_KEY is unset the ingest endpoint refuses to
// start. Never commit a working key here; keep this placeholder empty and
// provision it per-device, or inject it at build time:
//     arduino-cli compile --build-property \
//       "compiler.cpp.extra_flags=-DAPI_KEY=\"$(cat .iot-key)\""
//
// The previous value ("fgmp-iot-dev-key") was committed alongside the
// server-side fallback, so any deployment that did not override it accepted
// telemetry — which overwrites live tank and generator levels — from anyone
// who read this repository.
// ───────────────────────────────────────────────────────────────────────────
struct Config {
  const char* wifiSsid     = "FGMP-SITE-WIFI";
  const char* wifiPassword = "change-me-please";
  const char* serverUrl    = "http://localhost:3000";  // no trailing slash
#ifdef API_KEY
  const char* apiKey       = API_KEY;                   // injected at build time
#else
  const char* apiKey       = "";                        // MUST be provisioned
#endif
  const char* dispenserId  = "DISP-0007";
  const char* espDeviceId  = "ESP-DISP-0007";
  const char* siteId       = "SITE-ADEN-CENTRAL";
  uint8_t     rs485Addr    = 1;     // Modbus slave address of the dispenser
  uint32_t    baudrate     = 9600;  // Modbus RTU line baud
  uint16_t    firmwareVer  = 0x0103; // 1.03 (matches dispenser register 40050)
};
static Config CFG;

// ───────────────────────────────────────────────────────────────────────────
// Pin map
// ───────────────────────────────────────────────────────────────────────────
static const uint8_t PIN_RS485_DE  = 4;    // DE+RE tied
static const uint8_t PIN_RS485_RX  = 16;   // RO  -> ESP32 RX2
static const uint8_t PIN_RS485_TX  = 17;   // DI  <- ESP32 TX2
static const uint8_t PIN_LED       = 2;    // onboard LED (active low)

// ───────────────────────────────────────────────────────────────────────────
// Modbus register addresses (protocol addresses, 0-based)
// ───────────────────────────────────────────────────────────────────────────
static const uint16_t REG_DEVICE_STATUS      = 0x0000; // u16  R
static const uint16_t REG_CURRENT_VOLUME_L   = 0x0001; // u32  R (2 regs)
static const uint16_t REG_FLOW_RATE_LPM      = 0x0003; // float R (2 regs)
static const uint16_t REG_PRESET_VOLUME_L    = 0x0005; // u32  R/W (2 regs)
static const uint16_t REG_NOZZLE_STATE       = 0x0007; // u16  R
static const uint16_t REG_TOTALIZER_LITRES   = 0x0009; // u32  R (2 regs)
static const uint16_t REG_TRANSACTION_COUNT  = 0x000B; // u16  R
static const uint16_t REG_AUTHORIZE          = 0x0013; // u16  R/W (40020)
static const uint16_t REG_STOP               = 0x0014; // u16  R/W (40021)
static const uint16_t REG_RESET              = 0x0015; // u16  R/W (40022)
static const uint16_t REG_TEMPERATURE_C      = 0x001D; // int16 R (40030)
static const uint16_t REG_ERROR_CODE         = 0x0027; // u16  R (40040)
static const uint16_t REG_FIRMWARE_VERSION   = 0x0031; // u16  R (40050)

// ───────────────────────────────────────────────────────────────────────────
// Dispenser state machine
// ───────────────────────────────────────────────────────────────────────────
enum DispenserState : uint8_t {
  ST_OFFLINE = 0, ST_IDLE = 1, ST_AUTHORIZED = 2,
  ST_DISPENSING = 3, ST_COMPLETED = 4, ST_FAULT = 5
};
static const char* STATE_NAMES[] = {
  "OFFLINE","IDLE","AUTHORIZED","DISPENSING","COMPLETED","FAULT"
};

// ───────────────────────────────────────────────────────────────────────────
// Telemetry snapshot — refreshed by pollDispenser()
// ───────────────────────────────────────────────────────────────────────────
struct Telemetry {
  uint8_t   deviceStatus     = ST_OFFLINE;
  float     currentVolumeL   = 0.0f;
  float     flowRateLpm      = 0.0f;
  uint32_t  presetVolumeL    = 0;
  uint8_t   nozzleState      = 0;
  float     totalizerLitres  = 0.0f;
  uint16_t  transactionCount = 0;
  int16_t   temperatureC     = 0;
  uint16_t  errorCode        = 0;
  uint16_t  firmwareVersion  = 0;
  uint32_t  lastPollMs       = 0;
  bool      valid            = false;
};
static Telemetry TEL;

// Local transaction accumulator — increments while state == DISPENSING
static float    g_transactionStartTotalizer = 0.0f;
static float    g_lastReportedVolume        = 0.0f;
static uint32_t g_lastTelemetryMs           = 0;
static uint32_t g_lastCommandPollMs         = 0;
static uint32_t g_lastPollMs                = 0;
static uint8_t  g_localState                = ST_OFFLINE;
static bool     g_wifiConnected             = false;

// ───────────────────────────────────────────────────────────────────────────
// Modbus RTU master primitives
// ───────────────────────────────────────────────────────────────────────────
static void rs485TxMode(bool tx) {
  digitalWrite(PIN_RS485_DE, tx ? HIGH : LOW);
  // MAX485 enable-to-driver settling (~1 us is fine at 9600 baud)
  if (tx) delayMicroseconds(20);
}

// Compute Modbus RTU CRC-16 (poly 0xA001, init 0xFFFF).
static uint16_t modbusCrc(const uint8_t* buf, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)buf[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : (crc >> 1);
    }
  }
  return crc;
}

// Send a Modbus RTU frame (already includes CRC). Switches DE/RE high before
// sending and returns to RX mode after a final 3.5-char delay.
static void modbusSend(const uint8_t* frame, size_t len) {
  rs485TxMode(true);
  Serial2.write(frame, len);
  Serial2.flush();                       // block until UART shift reg empty
  // Modbus RTU 3.5-char idle gap at this baud (≥ 1750 us at 9600)
  delayMicroseconds(4000);
  rs485TxMode(false);
}

// Read N holding registers (function 0x03). Returns true on success.
// `regs` is filled big-endian; caller decodes 16/32/float from it.
static bool modbusReadHolding(uint8_t slave, uint16_t startReg,
                              uint16_t count, uint16_t* out) {
  uint8_t req[8];
  req[0] = slave;
  req[1] = 0x03;
  req[2] = (uint8_t)(startReg >> 8);
  req[3] = (uint8_t)(startReg & 0xFF);
  req[4] = (uint8_t)(count >> 8);
  req[5] = (uint8_t)(count & 0xFF);
  uint16_t crc = modbusCrc(req, 6);
  req[6] = (uint8_t)(crc & 0xFF);
  req[7] = (uint8_t)(crc >> 8);

  // Purge any stale RX bytes, then send.
  while (Serial2.available()) Serial2.read();
  modbusSend(req, 8);

  // Expected response: 1 (slave) + 1 (func) + 1 (byte count) + 2*count + 2 (CRC)
  size_t expectLen = 5 + 2 * count;
  uint8_t resp[64];
  size_t got = 0;
  uint32_t t0 = millis();
  while (got < expectLen && millis() - t0 < 500) {
    if (Serial2.available()) {
      resp[got++] = (uint8_t)Serial2.read();
    } else {
      delay(1);
    }
  }
  if (got != expectLen) return false;
  if (resp[0] != slave || resp[1] != 0x03) return false;
  if (resp[2] != (uint8_t)(2 * count)) return false;
  uint16_t rxCrc = (uint16_t)resp[expectLen - 2] |
                   ((uint16_t)resp[expectLen - 1] << 8);
  if (rxCrc != modbusCrc(resp, expectLen - 2)) return false;

  for (uint16_t i = 0; i < count; i++) {
    out[i] = ((uint16_t)resp[3 + 2 * i] << 8) | resp[4 + 2 * i];
  }
  return true;
}

// Write a single holding register (function 0x06). Returns true on success.
static bool modbusWriteSingle(uint8_t slave, uint16_t reg, uint16_t value) {
  uint8_t req[8];
  req[0] = slave;
  req[1] = 0x06;
  req[2] = (uint8_t)(reg >> 8);
  req[3] = (uint8_t)(reg & 0xFF);
  req[4] = (uint8_t)(value >> 8);
  req[5] = (uint8_t)(value & 0xFF);
  uint16_t crc = modbusCrc(req, 6);
  req[6] = (uint8_t)(crc & 0xFF);
  req[7] = (uint8_t)(crc >> 8);

  while (Serial2.available()) Serial2.read();
  modbusSend(req, 8);

  // Echo response = the request itself (8 bytes).
  uint8_t resp[8];
  size_t got = 0;
  uint32_t t0 = millis();
  while (got < 8 && millis() - t0 < 500) {
    if (Serial2.available()) {
      resp[got++] = (uint8_t)Serial2.read();
    } else {
      delay(1);
    }
  }
  if (got != 8) return false;
  if (resp[0] != slave || resp[1] != 0x06) return false;
  uint16_t rxCrc = (uint16_t)resp[6] | ((uint16_t)resp[7] << 8);
  return rxCrc == modbusCrc(resp, 6);
}

// Decode helpers (big-endian, high-word-first for u32/float)
static uint32_t decodeU32(const uint16_t* r) {
  return ((uint32_t)r[0] << 16) | (uint32_t)r[1];
}
static float decodeFloat(const uint16_t* r) {
  uint32_t u = ((uint32_t)r[0] << 16) | (uint32_t)r[1];
  float f;
  memcpy(&f, &u, 4);
  return f;
}

// ───────────────────────────────────────────────────────────────────────────
// Periodic dispenser poll — refreshes TEL from registers
// ───────────────────────────────────────────────────────────────────────────
static void pollDispenser() {
  uint16_t buf[6];

  // Read registers 0x0000..0x0008 (9 regs): status, current_volume(u32),
  // flow_rate(float), preset(u32), nozzle_state
  if (!modbusReadHolding(CFG.rs485Addr, REG_DEVICE_STATUS, 9, buf)) {
    TEL.valid = false;
    TEL.deviceStatus = ST_OFFLINE;
    Serial.println("[mb] read block 0x0000..0x0008 failed");
    return;
  }
  TEL.deviceStatus    = (uint8_t)buf[0];
  TEL.currentVolumeL  = (float)decodeU32(&buf[1]) / 10.0f;  // 0.1 L res
  TEL.flowRateLpm     = decodeFloat(&buf[3]);
  TEL.presetVolumeL   = decodeU32(&buf[5]);
  TEL.nozzleState     = (uint8_t)buf[7];

  // Read registers 0x0009..0x000C: totalizer(u32), transaction_count
  if (modbusReadHolding(CFG.rs485Addr, REG_TOTALIZER_LITRES, 3, buf)) {
    TEL.totalizerLitres  = (float)decodeU32(&buf[0]) / 10.0f;
    TEL.transactionCount = buf[2];
  }

  // Single-register reads
  if (modbusReadHolding(CFG.rs485Addr, REG_TEMPERATURE_C, 1, buf)) {
    TEL.temperatureC = (int16_t)buf[0];
  }
  if (modbusReadHolding(CFG.rs485Addr, REG_ERROR_CODE, 1, buf)) {
    TEL.errorCode = buf[0];
  }
  if (modbusReadHolding(CFG.rs485Addr, REG_FIRMWARE_VERSION, 1, buf)) {
    TEL.firmwareVersion = buf[0];
  }

  TEL.lastPollMs = millis();
  TEL.valid = true;

  // Local state-machine sync (source of truth is the dispenser)
  g_localState = TEL.deviceStatus;
  if (g_localState == ST_OFFLINE || g_localState == ST_FAULT) {
    Serial.printf("[fsa] %s err=0x%04X\n",
                  STATE_NAMES[g_localState], TEL.errorCode);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ───────────────────────────────────────────────────────────────────────────
static void postTelemetry() {
  if (!g_wifiConnected) return;

  // Map dispenser telemetry onto the iotIngestSchema shape. The dispenser-
  // specific fields are also embedded under `dispenser` for the future
  // dispenser-aware endpoint.
  StaticJsonDocument<768> doc;
  doc["siteId"]       = CFG.siteId;
  doc["dispenserId"]  = CFG.dispenserId;
  doc["espDeviceId"]  = CFG.espDeviceId;
  JsonObject r = doc.createNestedObject("readings");
  r["tankLevel"] = serialized(String(TEL.currentVolumeL, 2));  // current_volume_l
  r["temp"]      = (int)TEL.temperatureC;                       // temperature_c
  JsonObject d = doc.createNestedObject("dispenser");
  d["status"]           = STATE_NAMES[TEL.deviceStatus];
  d["flowRateLpm"]      = serialized(String(TEL.flowRateLpm, 2));
  d["nozzleState"]      = (int)TEL.nozzleState;
  d["presetVolumeL"]    = (uint32_t)TEL.presetVolumeL;
  d["totalizerLitres"]  = serialized(String(TEL.totalizerLitres, 1));
  d["transactionCount"] = TEL.transactionCount;
  d["errorCode"]        = TEL.errorCode;
  d["firmwareVersion"]  = TEL.firmwareVersion;
  doc["ts"] = millis();

  String body;
  serializeJson(doc, body);

  WiFiClientSecure tls;
  HTTPClient http;
  String url = String(CFG.serverUrl) + "/api/fgmp/iot/ingest";
  bool insecure = String(CFG.serverUrl).startsWith("http://");
  if (!insecure) {
    tls.setInsecure();   // accept any cert — production should pin the CA
    http.begin(tls, url);
  } else {
    http.begin(url);
  }
  http.addHeader("content-type", "application/json");
  http.addHeader("x-api-key",    CFG.apiKey);
  http.setTimeout(4000);

  int code = http.POST((uint8_t*)body.c_str(), body.length());
  if (code > 0) {
    if (code == 200) {
      g_lastReportedVolume = TEL.currentVolumeL;
    } else {
      Serial.printf("[http] ingest HTTP %d: %s\n", code,
                    http.getString().substring(0, 200).c_str());
    }
  } else {
    Serial.printf("[http] ingest failed: %s\n",
                  http.errorToString(code).c_str());
  }
  http.end();
}

// Forward declaration — defined below pollCommands().
static void ackCommand(const char* cmdId, const char* status);

static void pollCommands() {
  if (!g_wifiConnected) return;

  WiFiClientSecure tls;
  HTTPClient http;
  String url = String(CFG.serverUrl) +
               "/api/fgmp/iot/dispenser/commands?deviceId=" +
               String(CFG.espDeviceId);
  bool insecure = String(CFG.serverUrl).startsWith("http://");
  if (!insecure) {
    tls.setInsecure();
    http.begin(tls, url);
  } else {
    http.begin(url);
  }
  http.addHeader("x-api-key", CFG.apiKey);
  http.setTimeout(4000);

  int code = http.GET();
  if (code != 200) {
    if (code == 404) {
      // Endpoint not deployed yet (Task 34-B pending). Throttle the warning.
      static uint32_t last404 = 0;
      if (millis() - last404 > 60000) {
        Serial.println("[cmd] /dispenser/commands not deployed (404) — retrying in 60s");
        last404 = millis();
      }
    } else if (code > 0) {
      Serial.printf("[cmd] poll HTTP %d\n", code);
    } else {
      Serial.printf("[cmd] poll failed: %s\n",
                    http.errorToString(code).c_str());
    }
    http.end();
    return;
  }

  String resp = http.getString();
  http.end();

  StaticJsonDocument<2048> doc;
  if (deserializeJson(doc, resp) != DeserializationError::Ok) {
    Serial.println("[cmd] bad JSON in command poll response");
    return;
  }
  JsonArray cmds = doc["commands"].as<JsonArray>();
  for (JsonObject c : cmds) {
    const char* action = c["action"];
    const char* cmdId  = c["id"];
    bool ok = false;
    if (strcmp(action, "authorize") == 0) {
      uint32_t preset = c["presetL"] | 0;
      if (preset > 0) {
        // Write preset register (40004) first, then authorize.
        modbusWriteSingle(CFG.rs485Addr, REG_PRESET_VOLUME_L,
                          (uint16_t)((preset >> 16) & 0xFFFF));
        modbusWriteSingle(CFG.rs485Addr, REG_PRESET_VOLUME_L + 1,
                          (uint16_t)(preset & 0xFFFF));
      }
      ok = modbusWriteSingle(CFG.rs485Addr, REG_AUTHORIZE, 1);
      Serial.printf("[cmd] authorize preset=%u ok=%d\n", preset, ok);
    } else if (strcmp(action, "stop") == 0) {
      ok = modbusWriteSingle(CFG.rs485Addr, REG_STOP, 1);
      Serial.printf("[cmd] stop ok=%d\n", ok);
    } else if (strcmp(action, "reset") == 0) {
      ok = modbusWriteSingle(CFG.rs485Addr, REG_RESET, 1);
      Serial.printf("[cmd] reset ok=%d\n", ok);
    } else if (strcmp(action, "ota") == 0) {
      // OTA via URL is handled by a separate routine (see handleOta())
      Serial.println("[cmd] ota queued — handled by handleOta()");
      ok = true;
    } else {
      Serial.printf("[cmd] unknown action: %s\n", action);
    }
    ackCommand(cmdId, ok ? "applied" : "failed");
  }
}

static void ackCommand(const char* cmdId, const char* status) {
  if (!cmdId || !g_wifiConnected) return;
  WiFiClientSecure tls;
  HTTPClient http;
  String url = String(CFG.serverUrl) + "/api/fgmp/iot/dispenser/commands/ack";
  bool insecure = String(CFG.serverUrl).startsWith("http://");
  if (!insecure) {
    tls.setInsecure();
    http.begin(tls, url);
  } else {
    http.begin(url);
  }
  http.addHeader("content-type", "application/json");
  http.addHeader("x-api-key",    CFG.apiKey);
  http.setTimeout(3000);

  StaticJsonDocument<256> doc;
  doc["commandId"] = cmdId;
  doc["status"]    = status;
  doc["appliedAt"] = millis();
  String body;
  serializeJson(doc, body);
  int code = http.POST((uint8_t*)body.c_str(), body.length());
  if (code != 200) {
    Serial.printf("[cmd] ack HTTP %d\n", code);
  }
  http.end();
}

// ───────────────────────────────────────────────────────────────────────────
// WiFi management
// ───────────────────────────────────────────────────────────────────────────
static void connectWiFi() {
  Serial.printf("[wifi] connecting to %s …\n", CFG.wifiSsid);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(CFG.espDeviceId);
  WiFi.begin(CFG.wifiSsid, CFG.wifiPassword);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(250);
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
  }
  if (WiFi.status() == WL_CONNECTED) {
    g_wifiConnected = true;
    digitalWrite(PIN_LED, LOW);
    Serial.printf("[wifi] connected, IP=%s, RSSI=%d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    g_wifiConnected = false;
    digitalWrite(PIN_LED, HIGH);
    Serial.println("[wifi] connect failed — will retry in main loop");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// OTA setup
// ───────────────────────────────────────────────────────────────────────────
static void setupOTA() {
  ArduinoOTA.setHostname(CFG.espDeviceId);
  ArduinoOTA.setPassword("fgmp-ota-default");
  ArduinoOTA
    .onStart([]() { Serial.println("[ota] start"); });
  ArduinoOTA
    .onEnd([]() { Serial.println("\n[ota] end — rebooting"); });
  ArduinoOTA
    .onProgress([](unsigned int p, unsigned int total) {
      Serial.printf("[ota] %u%%\r", (p * 100) / total);
    });
  ArduinoOTA
    .onError([](ota_error_t e) {
      Serial.printf("[ota] error %u\n", e);
    });
  ArduinoOTA.begin();
  Serial.println("[ota] listening on port 3232 (mDNS: " +
                 String(CFG.espDeviceId) + ".local)");
}

// ───────────────────────────────────────────────────────────────────────────
// LED diagnostic pattern
// ───────────────────────────────────────────────────────────────────────────
static void updateLed() {
  static uint32_t lastToggle = 0;
  static bool     level      = false;
  uint32_t now = millis();

  if (!g_wifiConnected) {
    // fast blink 5 Hz
    if (now - lastToggle > 100) {
      level = !level;
      digitalWrite(PIN_LED, level);
      lastToggle = now;
    }
  } else if (!TEL.valid) {
    // triple pulse every 2 s = Modbus fault
    uint32_t phase = now % 2000;
    bool on = (phase < 100) || (phase < 300 && phase >= 200) ||
              (phase < 500 && phase >= 400);
    digitalWrite(PIN_LED, on ? LOW : HIGH);
  } else {
    digitalWrite(PIN_LED, LOW);  // healthy = LED off (active-low)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Boot banner
// ───────────────────────────────────────────────────────────────────────────
static void printBanner() {
  Serial.println();
  Serial.println("=========================================================");
  Serial.println(" FGMP Fuel Dispenser Gateway (ESP32)");
  Serial.println("---------------------------------------------------------");
  Serial.printf("  Device ID    : %s\n", CFG.espDeviceId);
  Serial.printf("  Dispenser ID : %s\n", CFG.dispenserId);
  Serial.printf("  Site ID      : %s\n", CFG.siteId);
  Serial.printf("  Server URL   : %s\n", CFG.serverUrl);
  Serial.printf("  RS485 slave  : %u @ %lu baud\n", CFG.rs485Addr, CFG.baudrate);
  Serial.printf("  Firmware     : %d.%d%d\n",
                (CFG.firmwareVer >> 8) & 0xFF,
                (CFG.firmwareVer >> 4) & 0xF,
                CFG.firmwareVer & 0xF);
  Serial.println("=========================================================");
}

// ───────────────────────────────────────────────────────────────────────────
// setup / loop
// ───────────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);
  printBanner();

  pinMode(PIN_RS485_DE, OUTPUT);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_RS485_DE, LOW);
  digitalWrite(PIN_LED, HIGH);

  // Hardware UART2 for Modbus RTU
  Serial2.begin(CFG.baudrate, SERIAL_8N1, PIN_RS485_RX, PIN_RS485_TX);

  // 8 s task watchdog — catches hangs in WiFi / HTTP / Modbus loops.
  esp_task_wdt_init(8, true);
  esp_task_wdt_add(NULL);

  connectWiFi();
  setupOTA();
}

void loop() {
  esp_task_wdt_reset();
  ArduinoOTA.handle();
  updateLed();

  // WiFi auto-reconnect
  if (WiFi.status() != WL_CONNECTED) {
    g_wifiConnected = false;
    static uint32_t lastRetry = 0;
    if (millis() - lastRetry > 5000) {
      lastRetry = millis();
      Serial.println("[wifi] link down — reconnecting");
      WiFi.disconnect();
      WiFi.reconnect();
    }
  } else if (!g_wifiConnected) {
    g_wifiConnected = true;
    Serial.printf("[wifi] link up, IP=%s RSSI=%d\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }

  uint32_t now = millis();

  // Poll dispenser every 2 s
  if (now - g_lastPollMs >= 2000) {
    g_lastPollMs = now;
    pollDispenser();
  }

  // POST telemetry every 5 s
  if (now - g_lastTelemetryMs >= 5000) {
    g_lastTelemetryMs = now;
    if (TEL.valid) postTelemetry();
  }

  // Poll commands every 3 s
  if (now - g_lastCommandPollMs >= 3000) {
    g_lastCommandPollMs = now;
    pollCommands();
  }

  delay(10);  // yield
}
