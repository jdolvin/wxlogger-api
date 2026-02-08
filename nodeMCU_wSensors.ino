#include <Arduino.h>
#include <Wire.h>

#include <ESP8266WiFi.h>
#include <time.h>

#include <PubSubClient.h>

#include <Adafruit_AHTX0.h>
#include <Adafruit_BMP085.h> // BMP180 compatible

// -----------------------------
// Station identity / config
// -----------------------------
static const char* STATION_ID = "basement_outdoor_esp8266";

// Wi-Fi
static const char* WIFI_SSID     = "YOUR_WIFI_SSID";
static const char* WIFI_PASSWORD = "YOUR_WIFI_PW";

// MQTT
static const char* MQTT_HOST = "192.168.1.171";
static const uint16_t MQTT_PORT = 1883;
static const char* MQTT_USER = "espuser";
static const char* MQTT_PASS = ""; // <-- set this

// Topics
static char TOPIC_META[96];
static char TOPIC_STATE[96];
static char TOPIC_TELE[96];

// Altitude for sea-level pressure correction
static const float ALT_M = 275.3f;

// Publish cadence
static const unsigned long PUBLISH_INTERVAL_MS = 60UL * 1000UL;

// Time sync (UTC). Telemetry timestamps are canonical UTC epoch milliseconds.
static const char* NTP1 = "pool.ntp.org";
static const char* NTP2 = "time.nist.gov";
static const unsigned long NTP_TIMEOUT_MS = 15000UL;
static const unsigned long NTP_RESYNC_MS  = 24UL * 60UL * 60UL * 1000UL;

// Connectivity timeouts / retry pacing
static const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000UL;
static const unsigned long MQTT_RETRY_MS = 5000UL;
static const unsigned long NTP_RETRY_MS  = 30UL * 1000UL;

// Firmware identifier (for meta)
static const char* FW_VERSION = "0.3.0";

// -----------------------------
// Globals
// -----------------------------
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

Adafruit_AHTX0 aht;
Adafruit_BMP085 bmp;

bool ahtReady = false;
bool bmpReady = false;

// Sequencing / run identification
uint32_t seq = 0;
uint32_t boot_id = 0;

// Time quality
bool ntpValid = false;
unsigned long lastNtpAttemptMs = 0;
unsigned long lastNtpSyncMs = 0;
bool metaNtpPublished = false; // one-time retained meta update after first valid NTP

// Publish timing
unsigned long lastPublishMs = 0;
unsigned long lastMqttAttemptMs = 0;

// Latest readings (canonical units)
float t_c = NAN;
float rh = NAN;
int32_t p_sta_pa = 0;
int32_t p_slp_pa = 0;

// -----------------------------
// Helpers
// -----------------------------
static float round1(float v) { return floorf(v * 10.0f + 0.5f) / 10.0f; }

static void buildTopics() {
  snprintf(TOPIC_META,  sizeof(TOPIC_META),  "wx/%s/meta",  STATION_ID);
  snprintf(TOPIC_STATE, sizeof(TOPIC_STATE), "wx/%s/state", STATION_ID);
  snprintf(TOPIC_TELE,  sizeof(TOPIC_TELE),  "wx/%s/tele",  STATION_ID);
}

static bool wifiEnsureConnected() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
  }
  return (WiFi.status() == WL_CONNECTED);
}

static bool mqttEnsureConnected() {
  if (mqtt.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;

  const unsigned long now = millis();
  if (now - lastMqttAttemptMs < MQTT_RETRY_MS) return false;
  lastMqttAttemptMs = now;

  // Unique client ID per device+boot
  String clientId = String(STATION_ID) + "-" + String(ESP.getChipId(), HEX) + "-" + String(boot_id, HEX);

  // LWT: retained "offline" will be published by broker on unexpected disconnect
  bool ok = mqtt.connect(
    clientId.c_str(),
    MQTT_USER, MQTT_PASS,
    TOPIC_STATE, 1, true, "offline"
  );

  if (ok) {
    mqtt.publish(TOPIC_STATE, "online", true); // retained
  }
  return ok;
}

static bool ntpSyncAttempt() {
  lastNtpAttemptMs = millis();

  // UTC time
  configTime(0, 0, NTP1, NTP2);

  const unsigned long start = millis();
  time_t now = time(nullptr);
  while (now < 1700000000 && (millis() - start) < NTP_TIMEOUT_MS) {
    delay(500);
    now = time(nullptr);
  }

  if (now >= 1700000000) {
    ntpValid = true;
    lastNtpSyncMs = millis();
    return true;
  }

  ntpValid = false;
  return false;
}

static uint64_t unixMsUtc() {
  // Only call if ntpValid==true.
  time_t now = time(nullptr);
  return (uint64_t)now * 1000ULL;
}

static void readSensorsOnce() {
  // AHTx0: temp + RH
  if (ahtReady) {
    sensors_event_t h, t;
    if (aht.getEvent(&h, &t)) {
      t_c = round1(t.temperature);
      rh  = round1(h.relative_humidity);
    }
  }

  // BMP180: station pressure + sea-level pressure (Pa)
  if (bmpReady) {
    p_sta_pa = (int32_t)bmp.readPressure();
    p_slp_pa = (int32_t)bmp.readSealevelPressure(ALT_M);
  }
}

static void publishMetaRetained() {
  if (!mqttEnsureConnected()) return;

  // Retained metadata (stable). Add fields you want stable over long time.
  // We include boot_id (useful for correlating logs), and ntp_valid flag.
  char payload[320];
  snprintf(payload, sizeof(payload),
    "{"
      "\"station_id\":\"%s\","
      "\"fw\":\"%s\","
      "\"boot_id\":%lu,"
      "\"alt_m\":%.1f,"
      "\"sample_s\":%lu,"
      "\"sensors\":{\"temp_rh\":\"AHTx0\",\"pressure\":\"BMP180\"},"
      "\"ntp_valid\":%u"
    "}",
    STATION_ID,
    FW_VERSION,
    (unsigned long)boot_id,
    ALT_M,
    (unsigned long)(PUBLISH_INTERVAL_MS / 1000UL),
    ntpValid ? 1 : 0
  );

  mqtt.publish(TOPIC_META, payload, true);
}

static void publishTelemetry() {
  if (!mqttEnsureConnected()) return;

  const uint64_t ts_ms = ntpValid ? unixMsUtc() : 0ULL;
  const int rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;

  // Note: stable schema; ts_unix_ms=0 means time is untrusted. q.ntp indicates validity.
  char payload[360];
  snprintf(payload, sizeof(payload),
    "{"
      "\"ts_unix_ms\":%llu,"
      "\"uptime_ms\":%lu,"
      "\"boot_id\":%lu,"
      "\"seq\":%lu,"
      "\"env\":{"
        "\"t_c\":%.1f,"
        "\"rh\":%.1f,"
        "\"p_sta_pa\":%ld,"
        "\"p_slp_pa\":%ld"
      "},"
      "\"q\":{"
        "\"ntp\":%u,"
        "\"aht\":%u,"
        "\"bmp\":%u,"
        "\"rssi_dbm\":%d"
      "}"
    "}",
    (unsigned long long)ts_ms,
    (unsigned long)millis(),
    (unsigned long)boot_id,
    (unsigned long)seq,
    t_c, rh,
    (long)p_sta_pa,
    (long)p_slp_pa,
    ntpValid ? 1 : 0,
    ahtReady ? 1 : 0,
    bmpReady ? 1 : 0,
    rssi
  );

  mqtt.publish(TOPIC_TELE, payload, false);
  seq++;
}

// -----------------------------
// Setup / Loop
// -----------------------------
void setup() {
  buildTopics();

  // Generate a per-boot session id (sufficiently unique for warehousing sessions)
  boot_id = (uint32_t)(ESP.getChipId() ^ micros() ^ (uint32_t)millis());

  // I2C explicitly for NodeMCU: SDA=D2(GPIO4), SCL=D1(GPIO5)
  Wire.begin(D2, D1);

  ahtReady = aht.begin();
  bmpReady = bmp.begin();

  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);

  // Best-effort connectivity at boot
  wifiEnsureConnected();
  mqttEnsureConnected();

  // Publish meta immediately (retained), even if NTP isn't valid yet (ntp_valid=0).
  publishMetaRetained();

  // Best-effort NTP at boot (if WiFi)
  if (WiFi.status() == WL_CONNECTED) {
    if (ntpSyncAttempt()) {
      // One-time retained meta update after NTP first becomes valid
      publishMetaRetained();
      metaNtpPublished = true;
    }
  }

  // Publish first telemetry immediately
  lastPublishMs = millis() - PUBLISH_INTERVAL_MS;
}

void loop() {
  const unsigned long now = millis();

  // Keep WiFi up
  wifiEnsureConnected();

  // Keep MQTT up and service socket
  mqttEnsureConnected();
  mqtt.loop();

  // NTP retry logic:
  // - If invalid, retry every 30s (when WiFi is up).
  // - If valid, resync every 24h.
  if (WiFi.status() == WL_CONNECTED) {
    if (!ntpValid) {
      if (now - lastNtpAttemptMs >= NTP_RETRY_MS) {
        const bool ok = ntpSyncAttempt();
        if (ok && !metaNtpPublished) {
          // One-time retained meta update after NTP first becomes valid
          publishMetaRetained();
          metaNtpPublished = true;
        }
      }
    } else {
      if (now - lastNtpSyncMs >= NTP_RESYNC_MS) {
        ntpSyncAttempt();
        // Do NOT republish meta on periodic resync; only one-time after first valid.
      }
    }
  }

  // Publish cadence
  if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
    lastPublishMs = now;

    readSensorsOnce();

    // Telemetry publish
    if (mqtt.connected()) {
      publishTelemetry();
    }
  }

  delay(10);
}
