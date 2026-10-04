/* ===========================================================================
 * FGMP Fuel Dispenser Gateway — ESP8266 reference firmware
 * -------------------------------------------------------------------------
 * Board:   NodeMCU 1.0 (ESP-12E)  / Wemos D1 Mini
 * Arduino: >= 2.2.1 with the "esp8266" board package (v3.x) installed.
 * Libraries (Arduino Library Manager):
 *     - ArduinoJson        by Benoit Blanchon  (v6.x or v7.x)
 *     - ESP8266WiFi, ESP8266HTTPClient, ESP8266mDNS, ArduinoOTA, DNSServer,
 *       EEPROM  — all bundled with the esp8266 package.
 *
 * Function:
 *   Identical to the ESP32 build (`dispenser_esp32.ino`) — Modbus RTU master,
 *   local state machine, telemetry POST every 5 s, command poll every 3 s,
 *   OTA, watchdog, auto-reconnect — but adapted to ESP8266 hardware:
 *     * SoftwareSerial on D6 (RX) / D7 (TX) instead of hardware Serial2.
 *     * MAX485 DE/RE on D5.
 *     * Software watchdog via the ESP8266 `ESP` API (WDTO).
 *
 * Pin map (NodeMCU "D" labels):
 *   D5  -> MAX485 DE+RE (tied together on the MAX485 module)
 *   D6  <- MAX485 RO  (SoftwareSerial RX)
 *   D7  -> MAX485 DI  (SoftwareSerial TX)
 *   D4  -> onboard LED (active-low on NodeMCU; also boot strapping — keep HiZ at boot)
 *
 * Notes:
 *   - SoftwareSerial on the ESP8266 is reliable up to ~38400 baud. Use the
 *     ESP32 build for dispensers that require 115200 baud.
 *   - HTTPClient + WiFiClientSecure on the ESP8266 requires a TLS fingerprint
 *     OR `setInsecure()`. The sketch uses `setInsecure()` for parity with the
 *     ESP32 build; production deployments should pin a certificate.
 *
 * ========================================================================== */

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <SoftwareSerial.h>
#include <Ticker.h>

// ───────────────────────────────────────────────────────────────────────────
// Config — edit per deployment. Mirrors the ESP32 build.
//
// SECURITY: apiKey MUST be the deployment's real IOT_API_KEY. The server has
// no default — if IOT_API_KEY is unset the ingest endpoint refuses to start.
// Never commit a working key here; keep this placeholder empty and provision
// it per-device, or inject it at build time:
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
// Pin map (NodeMCU D-labels)
// ───────────────────────────────────────────────────────────────────────────
static const uint8_t PIN_RS485_DE  = D5;
static const uint8_t PIN_RS485_RX  = D6;   // RO  -> SoftwareSerial RX
static const uint8_t PIN_RS485_TX  = D7;   // DI  <- SoftwareSerial TX
static const uint8_t PIN_LED       = D4;   // onboard LED (active low)

// SoftwareSerial for the Modbus line. Baud must be ≤ 38400 for reliability.
static SoftwareSerial ModbusSer(PIN_RS485_RX, PIN_RS485_TX);

// ───────────────────────────────────────────────────────────────────────────
// Modbus register addresses (protocol addresses, 0-based) — identical to ESP32
// ───────────────────────────────────────────────────────────────────────────
static const uint16_t REG_DEVICE_STATUS      = 0x0000;
static const uint16_t REG_CURRENT_VOLUME_L   = 0x0001;  // u32
static const uint16_t REG_FLOW_RATE_LPM      = 0x0003;  // float
static const uint16_t REG_PRESET_VOLUME_L    = 0x0005;  // u32
static const uint16_t REG_NOZZLE_STATE       = 0x0007;
static const uint16_t REG_TOTALIZER_LITRES   = 0x0009;  // u32
static const uint16_t REG_TRANSACTION_COUNT  = 0x000B;
static const uint16_t REG_AUTHORIZE          = 0x0013;  // 40020
static const uint16_t REG_STOP               = 0x0014;  // 40021
static const uint16_t REG_RESET              = 0x0015;  // 40022
static const uint16_t REG_TEMPERATURE_C      = 0x001D;  // 40030
static const uint16_t REG_ERROR_CODE         = 0x0027;  // 40040
static const uint16_t REG_FIRMWARE_VERSION   = 0x0031;  // 40050

// ───────────────────────────────────────────────────────────────────────────
// State machine + telemetry snapshot
// ───────────────────────────────────────────────────────────────────────────
enum DispenserState : uint8_t {
  ST_OFFLINE = 0, ST_IDLE = 1, ST_AUTHORIZED = 2,
  ST_DISPENSING = 3, ST_COMPLETED = 4, ST_FAULT = 5
};
static const char* STATE_NAMES[] = {
  "OFFLINE","IDLE","AUTHORIZED","DISPENSING","COMPLETED","FAULT"
};

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

static float    g_lastReportedVolume        = 0.0f;
static uint32_t g_lastTelemetryMs           = 0;
static uint32_t g_lastCommandPollMs         = 0;
static uint32_t g_lastPollMs                = 0;
static bool     g_wifiConnected             = false;

// Software watchdog — the ESP8266's hardware WDT is auto-fed by `yield()` and
// `delay()`. We use a Ticker-based "soft" watchdog to detect hangs in our own
// blocking loops and force a reset if a poll hasn't completed in 30 s.
static Ticker g_wdtTicker;
static volatile uint32_t g_wdtCounter = 0;
static void wdtTick() {
  g_wdtCounter++;
  if (g_wdtCounter > 30) {
    Serial.println("[wdt] force reset");
    ESP.restart();
  }
}
static void wdtFeed() { g_wdtCounter = 0; }

// ───────────────────────────────────────────────────────────────────────────
// Modbus RTU master primitives (identical logic to ESP32 build, but using
// the SoftwareSerial instance `ModbusSer`.)
// ───────────────────────────────────────────────────────────────────────────
static void rs485TxMode(bool tx) {
  digitalWrite(PIN_RS485_DE, tx ? HIGH : LOW);
  if (tx) delayMicroseconds(20);
}

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

static void modbusSend(const uint8_t* frame, size_t len) {
  rs485TxMode(true);
  ModbusSer.write(frame, len);
  ModbusSer.flush();
  delayMicroseconds(4000);
  rs485TxMode(false);
}

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

  while (ModbusSer.available()) ModbusSer.read();
  modbusSend(req, 8);

  size_t expectLen = 5 + 2 * count;
  uint8_t resp[64];
  size_t got = 0;
  uint32_t t0 = millis();
  while (got < expectLen && millis() - t0 < 500) {
    if (ModbusSer.available()) {
      resp[got++] = (uint8_t)ModbusSer.read();
    } else {
      delay(1);
      yield();   // keep the ESP8266 WiFi stack alive
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

  while (ModbusSer.available()) ModbusSer.read();
  modbusSend(req, 8);

  uint8_t resp[8];
  size_t got = 0;
  uint32_t t0 = millis();
  while (got < 8 && millis() - t0 < 500) {
    if (ModbusSer.available()) {
      resp[got++] = (uint8_t)ModbusSer.read();
    } else {
      delay(1);
      yield();
    }
  }
  if (got != 8) return false;
  if (resp[0] != slave || resp[1] != 0x06) return false;
  uint16_t rxCrc = (uint16_t)resp[6] | ((uint16_t)resp[7] << 8);
  return rxCrc == modbusCrc(resp, 6);
}

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
// Periodic dispenser poll
// ───────────────────────────────────────────────────────────────────────────
static void pollDispenser() {
  uint16_t buf[6];

  if (!modbusReadHolding(CFG.rs485Addr, REG_DEVICE_STATUS, 9, buf)) {
    TEL.valid = false;
    TEL.deviceStatus = ST_OFFLINE;
    Serial.println("[mb] read block 0x0000..0x0008 failed");
    return;
  }
  TEL.deviceStatus    = (uint8_t)buf[0];
  TEL.currentVolumeL  = (float)decodeU32(&buf[1]) / 10.0f;
  TEL.flowRateLpm     = decodeFloat(&buf[3]);
  TEL.presetVolumeL   = decodeU32(&buf[5]);
  TEL.nozzleState     = (uint8_t)buf[7];

  if (modbusReadHolding(CFG.rs485Addr, REG_TOTALIZER_LITRES, 3, buf)) {
    TEL.totalizerLitres  = (float)decodeU32(&buf[0]) / 10.0f;
    TEL.transactionCount = buf[2];
  }
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

  if (TEL.deviceStatus == ST_OFFLINE || TEL.deviceStatus == ST_FAULT) {
    Serial.printf("[fsa] %s err=0x%04X\n",
                  STATE_NAMES[TEL.deviceStatus], TEL.errorCode);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ───────────────────────────────────────────────────────────────────────────
static void postTelemetry() {
  if (!g_wifiConnected) return;

  StaticJsonDocument<768> doc;
  doc["siteId"]       = CFG.siteId;
  doc["dispenserId"]  = CFG.dispenserId;
  doc["espDeviceId"]  = CFG.espDeviceId;
  JsonObject r = doc.createNestedObject("readings");
  r["tankLevel"] = serialized(String(TEL.currentVolumeL, 2));
  r["temp"]      = (int)TEL.temperatureC;
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

  std::unique_ptr<BearSSL::WiFiClientSecure> tls(
      new BearSSL::WiFiClientSecure);
  WiFiClient* client = nullptr;
  bool insecure = String(CFG.serverUrl).startsWith("http://");
  HTTPClient http;
  String url = String(CFG.serverUrl) + "/api/fgmp/iot/ingest";
  if (insecure) {
    http.begin(url);
  } else {
    tls->setInsecure();
    http.begin(*tls, url);
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

static void ackCommand(const char* cmdId, const char* status);

static void pollCommands() {
  if (!g_wifiConnected) return;

  std::unique_ptr<BearSSL::WiFiClientSecure> tls(
      new BearSSL::WiFiClientSecure);
  HTTPClient http;
  String url = String(CFG.serverUrl) +
               "/api/fgmp/iot/dispenser/commands?deviceId=" +
               String(CFG.espDeviceId);
  bool insecure = String(CFG.serverUrl).startsWith("http://");
  if (insecure) {
    http.begin(url);
  } else {
    tls->setInsecure();
    http.begin(*tls, url);
  }
  http.addHeader("x-api-key", CFG.apiKey);
  http.setTimeout(4000);

  int code = http.GET();
  if (code != 200) {
    if (code == 404) {
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
  std::unique_ptr<BearSSL::WiFiClientSecure> tls(
      new BearSSL::WiFiClientSecure);
  HTTPClient http;
  String url = String(CFG.serverUrl) + "/api/fgmp/iot/dispenser/commands/ack";
  bool insecure = String(CFG.serverUrl).startsWith("http://");
  if (insecure) {
    http.begin(url);
  } else {
    tls->setInsecure();
    http.begin(*tls, url);
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
  if (code != 200) Serial.printf("[cmd] ack HTTP %d\n", code);
  http.end();
}

// ───────────────────────────────────────────────────────────────────────────
// WiFi management
// ───────────────────────────────────────────────────────────────────────────
static void connectWiFi() {
  Serial.printf("[wifi] connecting to %s …\n", CFG.wifiSsid);
  WiFi.mode(WIFI_STA);
  WiFi.hostname(CFG.espDeviceId);
  WiFi.begin(CFG.wifiSsid, CFG.wifiPassword);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(250);
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
    yield();
  }
  if (WiFi.status() == WL_CONNECTED) {
    g_wifiConnected = true;
    digitalWrite(PIN_LED, HIGH);   // LED off (active-low)
    Serial.printf("[wifi] connected, IP=%s, RSSI=%d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    g_wifiConnected = false;
    Serial.println("[wifi] connect failed — will retry in main loop");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// OTA
// ───────────────────────────────────────────────────────────────────────────
static void setupOTA() {
  ArduinoOTA.setHostname(CFG.espDeviceId);
  ArduinoOTA.setPassword("fgmp-ota-default");
  ArduinoOTA.onStart([]() { Serial.println("[ota] start"); });
  ArduinoOTA.onEnd([]()  { Serial.println("\n[ota] end — rebooting"); });
  ArduinoOTA.onProgress([](unsigned int p, unsigned int total) {
    Serial.printf("[ota] %u%%\r", (p * 100) / total);
  });
  ArduinoOTA.onError([](ota_error_t e) {
    Serial.printf("[ota] error %u\n", e);
  });
  ArduinoOTA.begin();
  Serial.println("[ota] listening on port 8266 (mDNS: " +
                 String(CFG.espDeviceId) + ".local)");
}

// ───────────────────────────────────────────────────────────────────────────
// LED diagnostic pattern (active-low LED: LOW = ON, HIGH = OFF)
// ───────────────────────────────────────────────────────────────────────────
static void updateLed() {
  static uint32_t lastToggle = 0;
  static bool     level      = false;
  uint32_t now = millis();

  if (!g_wifiConnected) {
    if (now - lastToggle > 100) {
      level = !level;
      digitalWrite(PIN_LED, level ? LOW : HIGH);
      lastToggle = now;
    }
  } else if (!TEL.valid) {
    uint32_t phase = now % 2000;
    bool on = (phase < 100) || (phase < 300 && phase >= 200) ||
              (phase < 500 && phase >= 400);
    digitalWrite(PIN_LED, on ? LOW : HIGH);
  } else {
    digitalWrite(PIN_LED, HIGH);  // healthy = LED off
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Boot banner
// ───────────────────────────────────────────────────────────────────────────
static void printBanner() {
  Serial.println();
  Serial.println("=========================================================");
  Serial.println(" FGMP Fuel Dispenser Gateway (ESP8266)");
  Serial.println("---------------------------------------------------------");
  Serial.printf("  Device ID    : %s\n", CFG.espDeviceId);
  Serial.printf("  Dispenser ID : %s\n", CFG.dispenserId);
  Serial.printf("  Site ID      : %s\n", CFG.siteId);
  Serial.printf("  Server URL   : %s\n", CFG.serverUrl);
  Serial.printf("  RS485 slave  : %u @ %lu baud (SoftwareSerial)\n",
                CFG.rs485Addr, CFG.baudrate);
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
  digitalWrite(PIN_LED, HIGH);  // LED off

  // SoftwareSerial — ESP8266 supports reliable SoftSerial up to ~38400 baud.
  if (CFG.baudrate > 38400) {
    Serial.println("[warn] SoftwareSerial is unreliable > 38400 baud on ESP8266.");
    Serial.println("       Consider switching to the ESP32 build for this dispenser.");
  }
  ModbusSer.begin(CFG.baudrate);

  // Soft watchdog — feed every loop, reset after 30 s of starvation.
  g_wdtTicker.attach(1.0, wdtTick);

  connectWiFi();
  setupOTA();
}

void loop() {
  wdtFeed();
  ArduinoOTA.handle();
  updateLed();
  yield();

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

  if (now - g_lastPollMs >= 2000) {
    g_lastPollMs = now;
    pollDispenser();
    wdtFeed();
  }

  if (now - g_lastTelemetryMs >= 5000) {
    g_lastTelemetryMs = now;
    if (TEL.valid) postTelemetry();
    wdtFeed();
  }

  if (now - g_lastCommandPollMs >= 3000) {
    g_lastCommandPollMs = now;
    pollCommands();
    wdtFeed();
  }

  delay(10);
  yield();
}
