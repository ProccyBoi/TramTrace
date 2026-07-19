#pragma once

#include <cstdint>

namespace tramtrace {

// The display is intentionally binary: every active distance state is solid,
// and state zero is off. The route RGB value is never amplitude-modulated.
constexpr bool stateIsVisible(uint8_t state) {
  return state > 0;
}

// Shared L2/L3 pixels keep their existing colour on an equal-state tie. This
// makes the result deterministic and solid instead of blinking between routes.
constexpr bool shouldReplaceCandidate(uint8_t currentState,
                                      uint8_t nextState) {
  return nextState > currentState;
}

}  // namespace tramtrace
