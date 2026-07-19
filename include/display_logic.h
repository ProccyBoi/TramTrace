#pragma once

#include <cstdint>

namespace tramtrace {

// Distance states are encoded with on/off timing instead of RGB intensity.
// Every visible pulse therefore uses the route's unmodified official colour.
constexpr uint32_t kFarCycleMs = 1600;
constexpr uint32_t kFarOnMs = 220;
constexpr uint32_t kApproachingCycleMs = 800;
constexpr uint32_t kApproachingOnMs = 520;
constexpr uint32_t kSharedColourSlotMs = 500;

constexpr bool stateIsVisible(uint8_t state, uint32_t nowMs) {
  if (state == 1) {
    return nowMs % kFarCycleMs < kFarOnMs;
  }
  if (state == 2) {
    return nowMs % kApproachingCycleMs < kApproachingOnMs;
  }
  return state >= 3;
}

// L2 and L3 share physical pixels from Moore Park to Circular Quay. When
// equally important vehicles occupy the same direction pixel, alternate the
// two exact route colours instead of inventing a blended colour.
constexpr uint32_t selectExactColour(uint32_t primary,
                                     uint32_t alternate,
                                     uint32_t nowMs) {
  if (alternate == 0) {
    return primary;
  }
  return (nowMs / kSharedColourSlotMs) % 2 == 0 ? primary : alternate;
}

}  // namespace tramtrace
