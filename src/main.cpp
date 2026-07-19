#include <Arduino.h>

#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include <algorithm>
#include <cstring>

#include "display_logic.h"
#include "station_map.h"

#ifndef DEFAULT_WIFI_SSID
#define DEFAULT_WIFI_SSID ""
#endif

#ifndef DEFAULT_WIFI_PASS
#define DEFAULT_WIFI_PASS ""
#endif

#ifndef DEFAULT_API_URL
#define DEFAULT_API_URL ""
#endif

#ifndef DEFAULT_BOARD_ID
#define DEFAULT_BOARD_ID ""
#endif

namespace {

using tramtrace::Strip;

constexpr char kFirmwareVersion[] = "0.2.0";
constexpr uint8_t kDefaultBrightness = 20;
constexpr uint8_t kMaximumBrightness = 64;
constexpr uint8_t kStatusBrightness = 12;
constexpr uint8_t kGracePayloads = 1;
constexpr uint32_t kDefaultPollMs = 3000;
constexpr uint32_t kMinimumPollMs = 1000;
constexpr uint32_t kMaximumPollMs = 10000;
constexpr uint32_t kHttpTimeoutMs = 12000;
constexpr uint32_t kWifiStartupTimeoutMs = 30000;
constexpr uint32_t kWifiRetryIntervalMs = 10000;
constexpr uint32_t kClearAfterFailureMs = 60000;
constexpr uint32_t kRenderIntervalMs = 50;
constexpr uint32_t kMaximumAcceptedFeedAgeSec = 120;
constexpr size_t kJsonCapacity = 32768;

struct DeviceConfig {
  String ssid;
  String password;
  String apiUrl;
  String boardId;
  uint8_t brightness = kDefaultBrightness;

  bool isValid() const {
    return !ssid.isEmpty() &&
           (apiUrl.startsWith("http://") || apiUrl.startsWith("https://"));
  }
};

struct PixelValue {
  uint8_t state = 0;
  uint8_t grace = 0;
  uint32_t colour = 0;
  uint32_t alternateColour = 0;
};

struct CandidatePixel {
  uint8_t state = 0;
  uint32_t colour = 0;
  uint32_t alternateColour = 0;
};

enum class StatusCode : uint8_t {
  Booting,
  Connecting,
  Live,
  SetupPortal,
  WifiError,
  ApiError,
  Testing,
};

Preferences gPreferences;
DeviceConfig gConfig{DEFAULT_WIFI_SSID, DEFAULT_WIFI_PASS, DEFAULT_API_URL,
                     DEFAULT_BOARD_ID, kDefaultBrightness};
DNSServer gDnsServer;
WebServer gConfigServer(80);

Adafruit_NeoPixel gStrips[] = {
    Adafruit_NeoPixel(tramtrace::kStripLengths[0],
                      tramtrace::kStripPins[0], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(tramtrace::kStripLengths[1],
                      tramtrace::kStripPins[1], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(tramtrace::kStripLengths[2],
                      tramtrace::kStripPins[2], NEO_GRB + NEO_KHZ800),
    Adafruit_NeoPixel(tramtrace::kStripLengths[3],
                      tramtrace::kStripPins[3], NEO_GRB + NEO_KHZ800),
};
Adafruit_NeoPixel gStatusStrip(1, tramtrace::kStatusPin,
                               NEO_GRB + NEO_KHZ800);

PixelValue gPixels[4][tramtrace::kMaximumStripLength] = {};
CandidatePixel gCandidate[4][tramtrace::kMaximumStripLength] = {};

uint8_t gBrightness = kDefaultBrightness;
uint32_t gPollMs = kDefaultPollMs;
uint32_t gLastPollAttemptMs = 0;
uint32_t gLastGoodPayloadMs = 0;
uint32_t gLastWifiAttemptMs = 0;
uint32_t gLastRenderMs = 0;
uint16_t gConsecutiveApiErrors = 0;
bool gFrameIsClear = true;
bool gInSetupPortal = false;
bool gSimulationRunning = false;
bool gSimulationStopRequested = false;
String gSerialLine;

void processSerial();

uint8_t clampBrightness(int value) {
  return static_cast<uint8_t>(
      std::max(1, std::min<int>(value, kMaximumBrightness)));
}

uint8_t clampState(int value) {
  return static_cast<uint8_t>(std::max(0, std::min(value, 3)));
}

uint32_t rgb(uint8_t red, uint8_t green, uint8_t blue) {
  return (static_cast<uint32_t>(red) << 16) |
         (static_cast<uint32_t>(green) << 8) | blue;
}

void setStatus(StatusCode code) {
  uint32_t colour = 0;
  switch (code) {
    case StatusCode::Booting:
      colour = rgb(150, 150, 150);
      break;
    case StatusCode::Connecting:
      colour = rgb(220, 70, 0);
      break;
    case StatusCode::Live:
      colour = rgb(0, 180, 20);
      break;
    case StatusCode::SetupPortal:
      colour = rgb(40, 150, 255);
      break;
    case StatusCode::WifiError:
      colour = rgb(220, 0, 0);
      break;
    case StatusCode::ApiError:
      colour = rgb(220, 0, 120);
      break;
    case StatusCode::Testing:
      colour = rgb(150, 40, 220);
      break;
  }

  gStatusStrip.setBrightness(kStatusBrightness);
  gStatusStrip.setPixelColor(0, colour);
  gStatusStrip.show();
}

void clearPhysicalStrips() {
  for (auto &strip : gStrips) {
    strip.clear();
    strip.show();
  }
}

void beginLeds() {
  gStatusStrip.begin();
  gStatusStrip.clear();
  gStatusStrip.show();

  for (auto &strip : gStrips) {
    strip.begin();
    strip.setBrightness(gBrightness);
    strip.clear();
    strip.show();
  }
}

void saveHardwareTestComplete() {
  gPreferences.begin("tramtrace", false);
  gPreferences.putBool("hwtest", true);
  gPreferences.end();
}

bool hardwareTestHasRun() {
  gPreferences.begin("tramtrace", true);
  const bool complete = gPreferences.getBool("hwtest", false);
  gPreferences.end();
  return complete;
}

void saveSimulationLoopEnabled(bool enabled) {
  gPreferences.begin("tramtrace", false);
  gPreferences.putBool("simloop", enabled);
  gPreferences.end();
}

bool simulationLoopIsEnabled() {
  gPreferences.begin("tramtrace", true);
  const bool enabled = gPreferences.getBool("simloop", false);
  gPreferences.end();
  return enabled;
}

void runSafePixelChase(bool rememberResult) {
  Serial.println("[TEST] Safe one-pixel chase: L1, L2, L3, L4.");
  setStatus(StatusCode::Testing);
  clearPhysicalStrips();

  for (uint8_t stripIndex = 0;
       stripIndex < tramtrace::stripIndex(Strip::Count); ++stripIndex) {
    auto &strip = gStrips[stripIndex];
    strip.setBrightness(8);
    const uint32_t colour = tramtrace::kRouteColours[stripIndex];

    for (uint16_t pixel = 0;
         pixel < tramtrace::kStripLengths[stripIndex]; ++pixel) {
      strip.clear();
      strip.setPixelColor(pixel, colour);
      strip.show();
      delay(25);
    }
    strip.clear();
    strip.show();
    strip.setBrightness(gBrightness);
  }

  if (rememberResult) {
    saveHardwareTestComplete();
  }
  Serial.println("[TEST] Pixel chase complete.");
}

String htmlEscape(const String &input) {
  String output;
  output.reserve(input.length() + 16);
  for (size_t i = 0; i < input.length(); ++i) {
    switch (input[i]) {
      case '&':
        output += F("&amp;");
        break;
      case '<':
        output += F("&lt;");
        break;
      case '>':
        output += F("&gt;");
        break;
      case '"':
        output += F("&quot;");
        break;
      case '\'':
        output += F("&#39;");
        break;
      default:
        output += input[i];
        break;
    }
  }
  return output;
}

String urlEncode(const String &input) {
  String output;
  char encoded[4] = {};
  for (size_t i = 0; i < input.length(); ++i) {
    const unsigned char value = static_cast<unsigned char>(input[i]);
    const bool unreserved =
        (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
        (value >= '0' && value <= '9') || value == '-' || value == '_' ||
        value == '.' || value == '~';
    if (unreserved) {
      output += static_cast<char>(value);
    } else {
      snprintf(encoded, sizeof(encoded), "%%%02X", value);
      output += encoded;
    }
  }
  return output;
}

bool loadConfig() {
  gPreferences.begin("tramtrace", true);
  gConfig.ssid = gPreferences.getString("ssid", gConfig.ssid);
  gConfig.password = gPreferences.getString("pass", gConfig.password);
  gConfig.apiUrl = gPreferences.getString("api", gConfig.apiUrl);
  gConfig.boardId = gPreferences.getString("board", gConfig.boardId);
  gConfig.brightness =
      clampBrightness(gPreferences.getUChar("bright", kDefaultBrightness));
  gPreferences.end();

  gConfig.ssid.trim();
  gConfig.apiUrl.trim();
  gConfig.boardId.trim();
  gBrightness = gConfig.brightness;
  return gConfig.isValid();
}

void saveConfig(const DeviceConfig &config) {
  gPreferences.begin("tramtrace", false);
  gPreferences.putString("ssid", config.ssid);
  gPreferences.putString("pass", config.password);
  gPreferences.putString("api", config.apiUrl);
  gPreferences.putString("board", config.boardId);
  gPreferences.putUChar("bright", config.brightness);
  gPreferences.end();
}

String configPageHtml() {
  String html;
  html.reserve(4200);
  html += F(
      "<!doctype html><html><head><meta charset='utf-8'>"
      "<meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<title>TramTrace setup</title><style>"
      "body{font-family:system-ui,sans-serif;max-width:42rem;margin:2rem auto;"
      "padding:0 1rem;background:#f4f5f7;color:#15171a}"
      "form{background:white;padding:1.4rem;border-radius:.8rem;"
      "box-shadow:0 2px 16px #0001}label{display:block;margin:.9rem 0 .3rem}"
      "input{box-sizing:border-box;width:100%;padding:.72rem;border:1px solid "
      "#b8bec8;border-radius:.4rem;font:inherit}"
      "button{margin-top:1.2rem;padding:.8rem 1.1rem;border:0;border-radius:"
      ".4rem;background:#b7192d;color:white;font-weight:700}"
      "small{color:#59616c}</style></head><body><h1>TramTrace setup</h1>"
      "<p>Enter Wi-Fi and the direction-aware TramTrace API endpoint.</p>"
      "<form method='post' action='/save'><label for='ssid'>Wi-Fi SSID</label>"
      "<input id='ssid' name='ssid' required value='");
  html += htmlEscape(gConfig.ssid);
  html += F(
      "'><label for='pass'>Wi-Fi password</label>"
      "<input id='pass' name='pass' type='password' value='");
  html += htmlEscape(gConfig.password);
  html += F(
      "'><label for='api'>API URL</label>"
      "<input id='api' name='api' type='url' required placeholder='"
      "https://example.net/tramtrace_payload' value='");
  html += htmlEscape(gConfig.apiUrl);
  html += F(
      "'><small>An API base URL ending in / is also accepted.</small>"
      "<label for='board'>Board ID (optional)</label>"
      "<input id='board' name='board' value='");
  html += htmlEscape(gConfig.boardId);
  html += F(
      "'><label for='brightness'>Brightness (1-64)</label>"
      "<input id='brightness' name='brightness' type='number' min='1' max='64'"
      " value='");
  html += String(gConfig.brightness);
  html += F(
      "'><button type='submit'>Save and restart</button></form>"
      "<p><small>Firmware ");
  html += kFirmwareVersion;
  html += F("</small></p></body></html>");
  return html;
}

[[noreturn]] void startConfigPortal() {
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_AP);

  const uint32_t suffix =
      static_cast<uint32_t>(ESP.getEfuseMac() & 0xFFFFFFULL);
  String accessPoint = F("TramTrace-Setup-");
  accessPoint += String(suffix, HEX);
  accessPoint.toUpperCase();

  WiFi.softAP(accessPoint.c_str());
  const IPAddress address = WiFi.softAPIP();
  gDnsServer.start(53, "*", address);

  gConfigServer.on("/", HTTP_GET, []() {
    gConfigServer.send(200, "text/html; charset=utf-8", configPageHtml());
  });
  gConfigServer.on("/save", HTTP_POST, []() {
    DeviceConfig next = gConfig;
    next.ssid = gConfigServer.arg("ssid");
    next.password = gConfigServer.arg("pass");
    next.apiUrl = gConfigServer.arg("api");
    next.boardId = gConfigServer.arg("board");
    next.brightness =
        clampBrightness(gConfigServer.arg("brightness").toInt());
    next.ssid.trim();
    next.apiUrl.trim();
    next.boardId.trim();

    if (!next.isValid()) {
      gConfigServer.send(
          400, "text/plain; charset=utf-8",
          "A Wi-Fi SSID and an http(s) TramTrace API URL are required.");
      return;
    }

    saveConfig(next);
    gConfigServer.send(
        200, "text/html; charset=utf-8",
        "<!doctype html><meta name='viewport' "
        "content='width=device-width,initial-scale=1'><h1>Saved</h1>"
        "<p>TramTrace is restarting.</p>");
    delay(750);
    ESP.restart();
  });

  const auto redirectToRoot = []() {
    gConfigServer.sendHeader("Location", "/", true);
    gConfigServer.send(302, "text/plain", "");
  };
  gConfigServer.on("/generate_204", HTTP_GET, redirectToRoot);
  gConfigServer.on("/hotspot-detect.html", HTTP_GET, redirectToRoot);
  gConfigServer.on("/ncsi.txt", HTTP_GET, redirectToRoot);
  gConfigServer.on("/connecttest.txt", HTTP_GET, redirectToRoot);
  gConfigServer.onNotFound(redirectToRoot);
  gConfigServer.begin();

  gInSetupPortal = true;
  setStatus(StatusCode::SetupPortal);
  Serial.printf("[SETUP] Join \"%s\" and open http://%s/\n",
                accessPoint.c_str(), address.toString().c_str());
  for (;;) {
    gDnsServer.processNextRequest();
    gConfigServer.handleClient();
    processSerial();
    delay(10);
  }
}

bool connectWifi(uint32_t timeoutMs) {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setSleep(false);
  setStatus(StatusCode::Connecting);

  if (gConfig.password.isEmpty()) {
    WiFi.begin(gConfig.ssid.c_str());
  } else {
    WiFi.begin(gConfig.ssid.c_str(), gConfig.password.c_str());
  }

  Serial.printf("[WIFI] Connecting to \"%s\"", gConfig.ssid.c_str());
  const uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Connection failed.");
    setStatus(StatusCode::WifiError);
    return false;
  }

  Serial.printf("[WIFI] Connected: %s, RSSI %d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

String payloadUrl() {
  String url = gConfig.apiUrl;
  url.trim();

  if (url.endsWith("/")) {
    url += F("tramtrace_payload");
  } else {
    const int schemeEnd = url.indexOf(F("://"));
    const int firstPathSlash =
        schemeEnd >= 0 ? url.indexOf('/', schemeEnd + 3) : -1;
    if (firstPathSlash < 0) {
      url += F("/tramtrace_payload");
    }
  }

  if (!gConfig.boardId.isEmpty()) {
    url += url.indexOf('?') >= 0 ? '&' : '?';
    url += F("board_id=");
    url += urlEncode(gConfig.boardId);
  }
  return url;
}

void clearCandidateFrame() {
  std::memset(gCandidate, 0, sizeof(gCandidate));
}

void accumulateCandidate(Strip strip, uint8_t pixel, uint8_t state,
                         uint32_t colour) {
  const uint8_t stripNumber = tramtrace::stripIndex(strip);
  if (stripNumber >= tramtrace::stripIndex(Strip::Count) ||
      pixel >= tramtrace::kStripLengths[stripNumber] || state == 0) {
    return;
  }

  CandidatePixel &candidate = gCandidate[stripNumber][pixel];
  if (state > candidate.state) {
    candidate.state = state;
    candidate.colour = colour;
    candidate.alternateColour = 0;
  } else if (state == candidate.state && candidate.colour != colour &&
             candidate.alternateColour != colour) {
    candidate.alternateColour = colour;
  }
}

bool buildCandidateFrame(JsonObjectConst states) {
  clearCandidateFrame();
  size_t presentBindings = 0;

  for (const auto &binding : tramtrace::kStationBindings) {
    const JsonObjectConst routeStates =
        states[binding.route].as<JsonObjectConst>();
    if (routeStates.isNull()) {
      continue;
    }

    const JsonArrayConst directionStates =
        routeStates[binding.station].as<JsonArrayConst>();
    if (directionStates.size() < 2) {
      continue;
    }

    ++presentBindings;
    const uint32_t colour = tramtrace::routeColour(binding.route);
    accumulateCandidate(binding.pixels.strip, binding.pixels.direction0,
                        clampState(directionStates[0].as<int>()), colour);
    accumulateCandidate(binding.pixels.strip, binding.pixels.direction1,
                        clampState(directionStates[1].as<int>()), colour);
  }

  // Reject an accidentally wrong/empty schema instead of interpreting it as
  // a valid all-off update. A normal TramTrace payload contains all 68 keys.
  if (presentBindings < tramtrace::kStationBindingCount / 2) {
    Serial.printf("[API] Only %u/%u expected bindings were present.\n",
                  static_cast<unsigned>(presentBindings),
                  static_cast<unsigned>(tramtrace::kStationBindingCount));
    clearCandidateFrame();
    return false;
  }
  return true;
}

void applyCandidateFrame() {
  bool anyLit = false;
  for (uint8_t strip = 0; strip < tramtrace::stripIndex(Strip::Count);
       ++strip) {
    for (uint16_t pixel = 0; pixel < tramtrace::kStripLengths[strip];
         ++pixel) {
      PixelValue &current = gPixels[strip][pixel];
      const CandidatePixel &candidate = gCandidate[strip][pixel];

      if (candidate.state > 0) {
        current.state = candidate.state;
        current.colour = candidate.colour;
        current.alternateColour = candidate.alternateColour;
        current.grace = kGracePayloads;
      } else if (current.grace > 0) {
        --current.grace;
      } else {
        current.state = 0;
        current.colour = 0;
        current.alternateColour = 0;
      }
      anyLit = anyLit || current.state > 0;
    }
  }
  gFrameIsClear = !anyLit;
}

void clearLiveFrame() {
  std::memset(gPixels, 0, sizeof(gPixels));
  gFrameIsClear = true;
}

void renderFrame(bool force = false) {
  const uint32_t now = millis();
  if (!force && now - gLastRenderMs < kRenderIntervalMs) {
    return;
  }
  gLastRenderMs = now;

  for (uint8_t strip = 0; strip < tramtrace::stripIndex(Strip::Count);
       ++strip) {
    gStrips[strip].setBrightness(gBrightness);
    gStrips[strip].clear();
    for (uint16_t pixel = 0; pixel < tramtrace::kStripLengths[strip];
         ++pixel) {
      const PixelValue &value = gPixels[strip][pixel];
      if (value.state == 0 ||
          !tramtrace::stateIsVisible(value.state, now)) {
        continue;
      }
      gStrips[strip].setPixelColor(
          pixel, tramtrace::selectExactColour(
                     value.colour, value.alternateColour, now));
    }
    gStrips[strip].show();
  }
}

bool fetchPayload() {
  const String url = payloadUrl();
  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  secureClient.setInsecure();  // Matches Metroboard; see README security note.
  secureClient.setTimeout(kHttpTimeoutMs);
  secureClient.setHandshakeTimeout(kHttpTimeoutMs);

  bool began = false;
  if (url.startsWith("https://")) {
    began = http.begin(secureClient, url);
  } else {
    began = http.begin(plainClient, url);
  }
  if (!began) {
    Serial.println("[API] Could not initialise HTTP client.");
    return false;
  }

  http.setTimeout(kHttpTimeoutMs);
  http.setReuse(false);
  http.addHeader("Accept", "application/json");
  http.addHeader("Accept-Encoding", "identity");
  http.addHeader("Cache-Control", "no-cache");
  http.addHeader("Connection", "close");
  http.addHeader("User-Agent",
                 String(F("ESP32-TramTrace/")) + kFirmwareVersion);

  const int responseCode = http.GET();
  if (responseCode != HTTP_CODE_OK) {
    Serial.printf("[API] HTTP %d from %s\n", responseCode, url.c_str());
    http.end();
    return false;
  }

  DynamicJsonDocument document(kJsonCapacity);
  const DeserializationError error =
      deserializeJson(document, http.getStream());
  http.end();
  if (error) {
    Serial.printf("[API] JSON error: %s\n", error.c_str());
    return false;
  }

  const int schema = document["schema"] | 0;
  if (schema != 1) {
    Serial.printf("[API] Unsupported schema %d.\n", schema);
    return false;
  }

  const JsonVariantConst feedAgeValue = document["feed_age"];
  if (!feedAgeValue.isNull()) {
    const uint32_t feedAge = feedAgeValue.as<uint32_t>();
    if (feedAge > kMaximumAcceptedFeedAgeSec) {
      Serial.printf("[API] Feed is stale (%u seconds).\n",
                    static_cast<unsigned>(feedAge));
      return false;
    }
  }

  const JsonObjectConst states = document["states"].as<JsonObjectConst>();
  if (states.isNull() || !buildCandidateFrame(states)) {
    Serial.println("[API] Missing or incomplete states object.");
    return false;
  }

  if (document["brightness"].is<int>()) {
    gBrightness = clampBrightness(document["brightness"].as<int>());
  } else {
    gBrightness = gConfig.brightness;
  }

  if (document["poll_seconds"].is<float>() ||
      document["poll_seconds"].is<int>()) {
    const float seconds = document["poll_seconds"].as<float>();
    const uint32_t requestedMs =
        seconds <= 0 ? kDefaultPollMs
                     : static_cast<uint32_t>(seconds * 1000.0F);
    gPollMs = std::max(kMinimumPollMs,
                       std::min(requestedMs, kMaximumPollMs));
  }

  applyCandidateFrame();
  gLastGoodPayloadMs = millis();
  gConsecutiveApiErrors = 0;
  setStatus(StatusCode::Live);
  renderFrame(true);
  Serial.printf("[API] Applied live payload; poll=%u ms, brightness=%u.\n",
                static_cast<unsigned>(gPollMs), gBrightness);
  return true;
}

void handlePayloadFailure() {
  ++gConsecutiveApiErrors;
  setStatus(StatusCode::ApiError);
  if (gLastGoodPayloadMs != 0 &&
      millis() - gLastGoodPayloadMs >= kClearAfterFailureMs &&
      !gFrameIsClear) {
    Serial.println("[API] Last good data expired; clearing route LEDs.");
    clearLiveFrame();
    renderFrame(true);
  }
}

void printDeviceInfo() {
  Serial.println();
  Serial.printf("TramTrace firmware %s\n", kFirmwareVersion);
  Serial.printf("ESP32 MAC: %s\n", WiFi.macAddress().c_str());
  Serial.printf("Flash: %u bytes; heap: %u bytes\n",
                static_cast<unsigned>(ESP.getFlashChipSize()),
                static_cast<unsigned>(ESP.getFreeHeap()));
  Serial.printf("Wi-Fi: %s (%s)\n", gConfig.ssid.c_str(),
                WiFi.status() == WL_CONNECTED ? "connected" : "offline");
  Serial.printf("API: %s (board authentication %s)\n",
                gConfig.apiUrl.c_str(),
                gConfig.boardId.isEmpty() ? "disabled" : "configured");
  Serial.printf("Bindings: %u; physical route pixels: 115 + status\n",
                static_cast<unsigned>(tramtrace::kStationBindingCount));
  Serial.println(
      "Commands: info, test, test-pairs, simulate, simulate-loop, stop, map, "
      "config, provision|ssid|password|api|board|brightness, factory-reset");
}

struct SimulationRoute {
  size_t bindingOffset;
  uint8_t stationCount;
  bool direction0Ascending;
};

constexpr SimulationRoute kSimulationRoutes[] = {
    {0, 23, false},   // L1 binding order: Dulwich Hill -> Central.
    {23, 14, false},  // L2 binding order: Randwick -> Circular Quay.
    {37, 15, false},  // L3 binding order: Juniors Kingsford -> Circular Quay.
    {52, 16, true},   // L4 binding order: Carlingford -> Westmead.
};

static_assert(
    kSimulationRoutes[3].bindingOffset +
            kSimulationRoutes[3].stationCount ==
        tramtrace::kStationBindingCount,
    "Simulation routes must cover every station binding");

void placeSimulationTram(const tramtrace::StationBinding &binding,
                         uint8_t direction, uint8_t state) {
  const uint8_t strip = tramtrace::stripIndex(binding.pixels.strip);
  const uint8_t pixel =
      direction == 0 ? binding.pixels.direction0 : binding.pixels.direction1;
  PixelValue &value = gPixels[strip][pixel];
  const uint32_t colour = tramtrace::routeColour(binding.route);

  if (state > value.state) {
    value.state = state;
    value.colour = colour;
    value.alternateColour = 0;
  } else if (state == value.state && value.colour != colour &&
             value.alternateColour != colour) {
    // L2 and L3 physically share their Moore Park-Circular Quay pixels.
    value.alternateColour = colour;
  }
  value.grace = 0;
  gFrameIsClear = false;
}

bool holdSimulationFrame(uint32_t durationMs) {
  const uint32_t started = millis();
  while (millis() - started < durationMs) {
    if (gInSetupPortal) {
      gDnsServer.processNextRequest();
      gConfigServer.handleClient();
    }
    processSerial();
    if (gSimulationStopRequested) {
      return false;
    }
    renderFrame();
    delay(15);
  }
  return true;
}

void runLiveSimulation(bool repeat) {
  constexpr uint8_t kSimulationSteps = 23;
  constexpr uint8_t kPhaseStates[] = {1, 2, 3};
  constexpr uint16_t kPhaseDurationsMs[] = {150, 300, 200};

  gSimulationRunning = true;
  gSimulationStopRequested = false;
  if (repeat) {
    saveSimulationLoopEnabled(true);
  }

  Serial.println("[SIM] Starting bidirectional L1-L4 light-rail simulation.");
  Serial.println(
      "[SIM] GTFS colours: L1=#BE1622 L2=#DD1E25 "
      "L3=#781140 L4=#BB2043");
  Serial.println(
      "[SIM] State sequence at each stop: in-range, approaching, stopped.");
  if (repeat) {
    Serial.println(
        "[SIM] Persistent replay enabled; send \"stop\" to leave replay mode.");
  }
  setStatus(StatusCode::Testing);

  const uint8_t savedBrightness = gBrightness;
  gBrightness = std::min<uint8_t>(savedBrightness, 16);
  clearLiveFrame();
  renderFrame(true);

  uint32_t replay = 0;
  do {
    ++replay;
    Serial.printf("[SIM] Replay %u.\n", static_cast<unsigned>(replay));
    for (uint8_t step = 0;
         step < kSimulationSteps && !gSimulationStopRequested; ++step) {
      size_t direction0Bindings[4] = {};
      size_t direction1Bindings[4] = {};

      Serial.printf("[SIM] Step %u/%u", static_cast<unsigned>(step + 1),
                    static_cast<unsigned>(kSimulationSteps));
      for (uint8_t routeIndex = 0; routeIndex < 4; ++routeIndex) {
        const SimulationRoute &route = kSimulationRoutes[routeIndex];
        const uint8_t direction0Base =
            static_cast<uint8_t>((step + routeIndex * 3U) % route.stationCount);
        const uint8_t direction1Base = static_cast<uint8_t>(
            (step + routeIndex * 3U + route.stationCount / 2U) %
            route.stationCount);
        const uint8_t direction0Station =
            route.direction0Ascending
                ? direction0Base
                : static_cast<uint8_t>(route.stationCount - 1U -
                                       direction0Base);
        const uint8_t direction1Station =
            route.direction0Ascending
                ? static_cast<uint8_t>(route.stationCount - 1U -
                                       direction1Base)
                : direction1Base;

        direction0Bindings[routeIndex] =
            route.bindingOffset + direction0Station;
        direction1Bindings[routeIndex] =
            route.bindingOffset + direction1Station;
        const auto &direction0Binding =
            tramtrace::kStationBindings[direction0Bindings[routeIndex]];
        const auto &direction1Binding =
            tramtrace::kStationBindings[direction1Bindings[routeIndex]];
        Serial.printf(" | %s d0=%s d1=%s", direction0Binding.route,
                      direction0Binding.station, direction1Binding.station);
      }
      Serial.println();

      for (uint8_t phase = 0;
           phase < 3 && !gSimulationStopRequested; ++phase) {
        clearLiveFrame();
        for (uint8_t routeIndex = 0; routeIndex < 4; ++routeIndex) {
          placeSimulationTram(
              tramtrace::kStationBindings[direction0Bindings[routeIndex]], 0,
              kPhaseStates[phase]);
          placeSimulationTram(
              tramtrace::kStationBindings[direction1Bindings[routeIndex]], 1,
              kPhaseStates[phase]);
        }
        renderFrame(true);
        holdSimulationFrame(kPhaseDurationsMs[phase]);
      }
    }
  } while (repeat && !gSimulationStopRequested);

  clearLiveFrame();
  gBrightness = savedBrightness;
  renderFrame(true);
  gSimulationRunning = false;
  setStatus(gInSetupPortal
                ? StatusCode::SetupPortal
                : WiFi.status() == WL_CONNECTED ? StatusCode::Live
                                                : StatusCode::WifiError);
  Serial.println(gSimulationStopRequested
                     ? "[SIM] Replay stopped; route LEDs cleared."
                     : "[SIM] Simulation complete; route LEDs cleared.");
}

void runPairTest() {
  Serial.println("[TEST] Direction pair test: direction 0 then direction 1.");
  setStatus(StatusCode::Testing);
  clearPhysicalStrips();

  for (const auto &binding : tramtrace::kStationBindings) {
    const uint8_t strip = tramtrace::stripIndex(binding.pixels.strip);
    const uint32_t colour = tramtrace::routeColour(binding.route);
    gStrips[strip].setBrightness(8);

    gStrips[strip].clear();
    gStrips[strip].setPixelColor(binding.pixels.direction0, colour);
    gStrips[strip].show();
    Serial.printf("[TEST] %s %-22s direction 0 pixel %u\n", binding.route,
                  binding.station, binding.pixels.direction0);
    delay(70);

    gStrips[strip].clear();
    gStrips[strip].setPixelColor(binding.pixels.direction1, colour);
    gStrips[strip].show();
    Serial.printf("[TEST] %s %-22s direction 1 pixel %u\n", binding.route,
                  binding.station, binding.pixels.direction1);
    delay(70);

    gStrips[strip].clear();
    gStrips[strip].show();
    gStrips[strip].setBrightness(gBrightness);
  }

  renderFrame(true);
  setStatus(gInSetupPortal
                ? StatusCode::SetupPortal
                : WiFi.status() == WL_CONNECTED ? StatusCode::Live
                                                : StatusCode::WifiError);
  Serial.println("[TEST] Direction pair test complete.");
}

void printMap() {
  for (const auto &binding : tramtrace::kStationBindings) {
    Serial.printf("%s | %-22s | strip %u | d0=%u d1=%u\n", binding.route,
                  binding.station,
                  tramtrace::stripIndex(binding.pixels.strip),
                  binding.pixels.direction0, binding.pixels.direction1);
  }
}

bool handleSerialProvision(const String &command) {
  const int firstSeparator = command.indexOf('|');
  if (firstSeparator < 0) {
    return false;
  }
  String verb = command.substring(0, firstSeparator);
  verb.toLowerCase();
  if (verb != "provision") {
    return false;
  }

  int separators[5] = {};
  int separatorCount = 0;
  int searchFrom = 0;
  while (separatorCount < 5) {
    const int separator = command.indexOf('|', searchFrom);
    if (separator < 0) {
      break;
    }
    separators[separatorCount++] = separator;
    searchFrom = separator + 1;
  }
  if (separatorCount != 5 || command.indexOf('|', searchFrom) >= 0) {
    Serial.println(
        "[CFG] Provision format: "
        "provision|ssid|password|api|board|brightness");
    return true;
  }

  DeviceConfig next = gConfig;
  next.ssid = command.substring(separators[0] + 1, separators[1]);
  next.password = command.substring(separators[1] + 1, separators[2]);
  next.apiUrl = command.substring(separators[2] + 1, separators[3]);
  next.boardId = command.substring(separators[3] + 1, separators[4]);
  next.brightness =
      clampBrightness(command.substring(separators[4] + 1).toInt());
  next.ssid.trim();
  next.apiUrl.trim();
  next.boardId.trim();

  if (!next.isValid()) {
    Serial.println(
        "[CFG] USB provisioning requires a Wi-Fi SSID and http(s) API URL.");
    return true;
  }

  saveConfig(next);
  saveSimulationLoopEnabled(false);
  Serial.println("[CFG] USB provisioning saved; restarting.");
  delay(300);
  ESP.restart();
  return true;
}

void handleSerialCommand(String command) {
  command.trim();
  if (handleSerialProvision(command)) {
    return;
  }
  command.toLowerCase();
  if (command.isEmpty()) {
    return;
  }

  if (gSimulationRunning) {
    if (command == "stop") {
      gSimulationStopRequested = true;
      saveSimulationLoopEnabled(false);
      Serial.println("[SIM] Stop requested.");
    } else {
      Serial.println("[SIM] Replay is active; send \"stop\" first.");
    }
    return;
  }

  if (command == "info" || command == "help") {
    printDeviceInfo();
  } else if (command == "test") {
    runSafePixelChase(false);
    renderFrame(true);
    setStatus(gInSetupPortal
                  ? StatusCode::SetupPortal
                  : WiFi.status() == WL_CONNECTED ? StatusCode::Live
                                                  : StatusCode::WifiError);
  } else if (command == "test-pairs") {
    runPairTest();
  } else if (command == "simulate") {
    runLiveSimulation(false);
  } else if (command == "simulate-loop") {
    runLiveSimulation(true);
  } else if (command == "stop") {
    saveSimulationLoopEnabled(false);
    Serial.println("[SIM] Replay mode is not running.");
  } else if (command == "map") {
    printMap();
  } else if (command == "config") {
    if (gInSetupPortal) {
      Serial.println("[CFG] Setup portal is already active.");
    } else {
      startConfigPortal();
    }
  } else if (command == "factory-reset") {
    Serial.println("[CFG] Erasing TramTrace preferences and restarting.");
    gPreferences.begin("tramtrace", false);
    gPreferences.clear();
    gPreferences.end();
    delay(300);
    ESP.restart();
  } else {
    Serial.println("[SERIAL] Unknown command. Type help.");
  }
}

void processSerial() {
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\r') {
      continue;
    }
    if (value == '\n') {
      handleSerialCommand(gSerialLine);
      gSerialLine = "";
      continue;
    }
    if (gSerialLine.length() < 512) {
      gSerialLine += value;
    }
  }
}

void maintainWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  const uint32_t now = millis();
  if (now - gLastWifiAttemptMs < kWifiRetryIntervalMs) {
    return;
  }
  gLastWifiAttemptMs = now;
  setStatus(StatusCode::Connecting);
  Serial.println("[WIFI] Reconnecting.");
  WiFi.disconnect(false, false);
  if (gConfig.password.isEmpty()) {
    WiFi.begin(gConfig.ssid.c_str());
  } else {
    WiFi.begin(gConfig.ssid.c_str(), gConfig.password.c_str());
  }
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.printf("TramTrace %s booting.\n", kFirmwareVersion);

  beginLeds();
  setStatus(StatusCode::Booting);

  if (!hardwareTestHasRun()) {
    runSafePixelChase(true);
    setStatus(StatusCode::Booting);
  }

  if (simulationLoopIsEnabled()) {
    Serial.println("[SIM] Resuming persistent replay from saved settings.");
    runLiveSimulation(true);
  }

  if (!loadConfig()) {
    Serial.println("[CFG] No complete saved configuration.");
    startConfigPortal();
  }

  gBrightness = gConfig.brightness;
  for (auto &strip : gStrips) {
    strip.setBrightness(gBrightness);
  }

  if (!connectWifi(kWifiStartupTimeoutMs)) {
    Serial.println("[CFG] Opening setup portal after startup Wi-Fi failure.");
    startConfigPortal();
  }

  printDeviceInfo();
  gLastPollAttemptMs = millis() - gPollMs;
}

void loop() {
  processSerial();
  maintainWifi();

  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED &&
      now - gLastPollAttemptMs >= gPollMs) {
    gLastPollAttemptMs = now;
    if (!fetchPayload()) {
      handlePayloadFailure();
    }
  }

  if (WiFi.status() != WL_CONNECTED && gLastGoodPayloadMs != 0 &&
      now - gLastGoodPayloadMs >= kClearAfterFailureMs && !gFrameIsClear) {
    clearLiveFrame();
    renderFrame(true);
    setStatus(StatusCode::WifiError);
  }

  renderFrame();
  delay(2);
}
