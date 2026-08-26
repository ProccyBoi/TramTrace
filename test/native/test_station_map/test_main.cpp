#include <cstring>

#include <unity.h>

#include "display_logic.h"
#include "ota_policy.h"
#include "station_map.h"

using namespace tramtrace;

void setUp() {}
void tearDown() {}

void test_hardware_constants_match_schematic() {
  TEST_ASSERT_EQUAL_UINT8(16, kStripPins[0]);
  TEST_ASSERT_EQUAL_UINT8(17, kStripPins[1]);
  TEST_ASSERT_EQUAL_UINT8(18, kStripPins[2]);
  TEST_ASSERT_EQUAL_UINT8(19, kStripPins[3]);
  TEST_ASSERT_EQUAL_UINT8(25, kStatusPin);
  TEST_ASSERT_EQUAL_UINT16(45, kStripLengths[0]);
  TEST_ASSERT_EQUAL_UINT16(8, kStripLengths[1]);
  TEST_ASSERT_EQUAL_UINT16(30, kStripLengths[2]);
  TEST_ASSERT_EQUAL_UINT16(32, kStripLengths[3]);
}

void test_route_srgb_colours_match_current_gtfs() {
  TEST_ASSERT_EQUAL_HEX32(0xBE1622, kRouteSrgbColours[0]);
  TEST_ASSERT_EQUAL_HEX32(0xDD1E25, kRouteSrgbColours[1]);
  TEST_ASSERT_EQUAL_HEX32(0x781140, kRouteSrgbColours[2]);
  TEST_ASSERT_EQUAL_HEX32(0xBB2043, kRouteSrgbColours[3]);
}

void test_route_led_colours_include_physical_diffuser_calibration() {
  TEST_ASSERT_EQUAL_HEX32(0xBE2000, kRouteLedColours[0]);
  TEST_ASSERT_EQUAL_HEX32(0xFF0000, kRouteLedColours[1]);
  TEST_ASSERT_EQUAL_HEX32(0x780000, kRouteLedColours[2]);
  TEST_ASSERT_EQUAL_HEX32(0xBB1030, kRouteLedColours[3]);

  TEST_ASSERT_EQUAL_HEX32(kRouteLedColours[0], routeColour("L1"));
  TEST_ASSERT_EQUAL_HEX32(kRouteLedColours[1], routeColour("L2"));
  TEST_ASSERT_EQUAL_HEX32(kRouteLedColours[2], routeColour("L3"));
  TEST_ASSERT_EQUAL_HEX32(kRouteLedColours[3], routeColour("L4"));
}

constexpr uint8_t scaledNeoPixelChannel(uint8_t channel, uint8_t brightness) {
  return static_cast<uint8_t>(
      (static_cast<uint16_t>(channel) * (brightness + 1U)) >> 8);
}

constexpr uint32_t scaledNeoPixelColour(uint32_t colour, uint8_t brightness) {
  return (static_cast<uint32_t>(scaledNeoPixelChannel(
              static_cast<uint8_t>(colour >> 16), brightness))
          << 16) |
         (static_cast<uint32_t>(scaledNeoPixelChannel(
              static_cast<uint8_t>(colour >> 8), brightness))
          << 8) |
         scaledNeoPixelChannel(static_cast<uint8_t>(colour), brightness);
}

void test_route_palette_survives_neopixel_brightness_quantisation() {
  // These are the RGB PWM bytes that actually reach the LEDs after
  // Adafruit_NeoPixel applies its integer brightness scale. Every route is
  // distinct even at the former 16/255 simulation brightness.
  TEST_ASSERT_EQUAL_HEX32(0x0C0200,
                          scaledNeoPixelColour(kRouteLedColours[0], 16));
  TEST_ASSERT_EQUAL_HEX32(0x100000,
                          scaledNeoPixelColour(kRouteLedColours[1], 16));
  TEST_ASSERT_EQUAL_HEX32(0x070000,
                          scaledNeoPixelColour(kRouteLedColours[2], 16));
  TEST_ASSERT_EQUAL_HEX32(0x0C0103,
                          scaledNeoPixelColour(kRouteLedColours[3], 16));

  TEST_ASSERT_EQUAL_HEX32(0x120300,
                          scaledNeoPixelColour(kRouteLedColours[0], 24));
  TEST_ASSERT_EQUAL_HEX32(0x180000,
                          scaledNeoPixelColour(kRouteLedColours[1], 24));
  TEST_ASSERT_EQUAL_HEX32(0x0B0000,
                          scaledNeoPixelColour(kRouteLedColours[2], 24));
  TEST_ASSERT_EQUAL_HEX32(0x120104,
                          scaledNeoPixelColour(kRouteLedColours[3], 24));

  TEST_ASSERT_EQUAL_HEX32(0x180400,
                          scaledNeoPixelColour(kRouteLedColours[0], 32));
  TEST_ASSERT_EQUAL_HEX32(0x200000,
                          scaledNeoPixelColour(kRouteLedColours[1], 32));
  TEST_ASSERT_EQUAL_HEX32(0x0F0000,
                          scaledNeoPixelColour(kRouteLedColours[2], 32));
  TEST_ASSERT_EQUAL_HEX32(0x180206,
                          scaledNeoPixelColour(kRouteLedColours[3], 32));

  TEST_ASSERT_EQUAL_HEX32(0x300800,
                          scaledNeoPixelColour(kRouteLedColours[0], 64));
  TEST_ASSERT_EQUAL_HEX32(0x400000,
                          scaledNeoPixelColour(kRouteLedColours[1], 64));
  TEST_ASSERT_EQUAL_HEX32(0x1E0000,
                          scaledNeoPixelColour(kRouteLedColours[2], 64));
  TEST_ASSERT_EQUAL_HEX32(0x2F040C,
                          scaledNeoPixelColour(kRouteLedColours[3], 64));
}

void test_every_active_distance_state_is_solid() {
  TEST_ASSERT_FALSE(stateIsVisible(0));
  TEST_ASSERT_TRUE(stateIsVisible(1));
  TEST_ASSERT_TRUE(stateIsVisible(2));
  TEST_ASSERT_TRUE(stateIsVisible(3));
}

void test_shared_pixel_ties_keep_a_stable_colour() {
  TEST_ASSERT_TRUE(shouldReplaceCandidate(0, 1));
  TEST_ASSERT_TRUE(shouldReplaceCandidate(1, 2));
  TEST_ASSERT_FALSE(shouldReplaceCandidate(2, 2));
  TEST_ASSERT_FALSE(shouldReplaceCandidate(3, 2));
}

void test_every_binding_is_in_bounds() {
  for (const auto &binding : kStationBindings) {
    const uint8_t strip = stripIndex(binding.pixels.strip);
    TEST_ASSERT_LESS_THAN_UINT8(stripIndex(Strip::Count), strip);
    TEST_ASSERT_LESS_THAN_UINT16(kStripLengths[strip],
                                binding.pixels.direction0);
    TEST_ASSERT_LESS_THAN_UINT16(kStripLengths[strip],
                                binding.pixels.direction1);
  }
}

void test_every_physical_route_pixel_is_bound() {
  bool seen[4][kMaximumStripLength] = {};

  for (const auto &binding : kStationBindings) {
    const uint8_t strip = stripIndex(binding.pixels.strip);
    seen[strip][binding.pixels.direction0] = true;
    seen[strip][binding.pixels.direction1] = true;
  }

  for (uint8_t strip = 0; strip < stripIndex(Strip::Count); ++strip) {
    for (uint16_t pixel = 0; pixel < kStripLengths[strip]; ++pixel) {
      TEST_ASSERT_TRUE_MESSAGE(seen[strip][pixel],
                               "Unbound physical station pixel");
    }
  }
}

void test_l2_shared_trunk_reuses_l3_pixels() {
  bool found = false;
  for (const auto &binding : kStationBindings) {
    if (std::strcmp(binding.route, "L2") == 0 &&
        std::strcmp(binding.station, "Circular Quay") == 0) {
      TEST_ASSERT_EQUAL_UINT8(stripIndex(Strip::L3),
                              stripIndex(binding.pixels.strip));
      TEST_ASSERT_EQUAL_UINT8(28, binding.pixels.direction0);
      TEST_ASSERT_EQUAL_UINT8(29, binding.pixels.direction1);
      found = true;
    }
  }
  TEST_ASSERT_TRUE(found);
}

void test_l1_central_merges_both_directions_to_single_pixel() {
  bool found = false;
  for (const auto &binding : kStationBindings) {
    if (std::strcmp(binding.route, "L1") == 0 &&
        std::strcmp(binding.station, "Central") == 0) {
      TEST_ASSERT_EQUAL_UINT8(44, binding.pixels.direction0);
      TEST_ASSERT_EQUAL_UINT8(44, binding.pixels.direction1);
      found = true;
    }
  }
  TEST_ASSERT_TRUE(found);
}

void test_ota_versions_are_strict_and_never_roll_back() {
  FirmwareVersion parsed;
  TEST_ASSERT_TRUE(parseFirmwareVersion("0.3.0", parsed));
  TEST_ASSERT_EQUAL_UINT32(0, parsed.major);
  TEST_ASSERT_EQUAL_UINT32(3, parsed.minor);
  TEST_ASSERT_EQUAL_UINT32(0, parsed.patch);

  TEST_ASSERT_FALSE(parseFirmwareVersion("v0.3.0", parsed));
  TEST_ASSERT_FALSE(parseFirmwareVersion("0.3", parsed));
  TEST_ASSERT_FALSE(parseFirmwareVersion("0.3.0-beta", parsed));
  TEST_ASSERT_TRUE(firmwareVersionIsNewer("0.3.1", "0.3.0"));
  TEST_ASSERT_TRUE(firmwareVersionIsNewer("1.0.0", "0.99.99"));
  TEST_ASSERT_FALSE(firmwareVersionIsNewer("0.3.0", "0.3.0"));
  TEST_ASSERT_FALSE(firmwareVersionIsNewer("0.2.9", "0.3.0"));
}

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_hardware_constants_match_schematic);
  RUN_TEST(test_route_srgb_colours_match_current_gtfs);
  RUN_TEST(test_route_led_colours_include_physical_diffuser_calibration);
  RUN_TEST(test_route_palette_survives_neopixel_brightness_quantisation);
  RUN_TEST(test_every_active_distance_state_is_solid);
  RUN_TEST(test_shared_pixel_ties_keep_a_stable_colour);
  RUN_TEST(test_every_binding_is_in_bounds);
  RUN_TEST(test_every_physical_route_pixel_is_bound);
  RUN_TEST(test_l2_shared_trunk_reuses_l3_pixels);
  RUN_TEST(test_l1_central_merges_both_directions_to_single_pixel);
  RUN_TEST(test_ota_versions_are_strict_and_never_roll_back);
  return UNITY_END();
}
