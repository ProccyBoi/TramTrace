#include <cstring>

#include <unity.h>

#include "display_logic.h"
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

void test_route_colours_match_current_gtfs() {
  TEST_ASSERT_EQUAL_HEX32(0xBE1622, kRouteColours[0]);
  TEST_ASSERT_EQUAL_HEX32(0xDD1E25, kRouteColours[1]);
  TEST_ASSERT_EQUAL_HEX32(0x781140, kRouteColours[2]);
  TEST_ASSERT_EQUAL_HEX32(0xBB2043, kRouteColours[3]);
}

void test_distance_states_preserve_exact_route_colour() {
  constexpr uint32_t l1 = 0xBE1622;
  TEST_ASSERT_TRUE(stateIsVisible(1, 0));
  TEST_ASSERT_FALSE(stateIsVisible(1, kFarOnMs));
  TEST_ASSERT_TRUE(stateIsVisible(2, 0));
  TEST_ASSERT_FALSE(stateIsVisible(2, kApproachingOnMs));
  TEST_ASSERT_TRUE(stateIsVisible(3, 799));
  TEST_ASSERT_EQUAL_HEX32(l1, selectExactColour(l1, 0, 0));
  TEST_ASSERT_EQUAL_HEX32(l1, selectExactColour(l1, 0, 700));
}

void test_shared_l2_l3_pixel_alternates_without_blending() {
  constexpr uint32_t l2 = 0xDD1E25;
  constexpr uint32_t l3 = 0x781140;
  TEST_ASSERT_EQUAL_HEX32(l2, selectExactColour(l2, l3, 0));
  TEST_ASSERT_EQUAL_HEX32(l3,
                          selectExactColour(l2, l3, kSharedColourSlotMs));
  TEST_ASSERT_EQUAL_HEX32(l2,
                          selectExactColour(l2, l3, 2 * kSharedColourSlotMs));
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

int main(int, char **) {
  UNITY_BEGIN();
  RUN_TEST(test_hardware_constants_match_schematic);
  RUN_TEST(test_route_colours_match_current_gtfs);
  RUN_TEST(test_distance_states_preserve_exact_route_colour);
  RUN_TEST(test_shared_l2_l3_pixel_alternates_without_blending);
  RUN_TEST(test_every_binding_is_in_bounds);
  RUN_TEST(test_every_physical_route_pixel_is_bound);
  RUN_TEST(test_l2_shared_trunk_reuses_l3_pixels);
  RUN_TEST(test_l1_central_merges_both_directions_to_single_pixel);
  return UNITY_END();
}
