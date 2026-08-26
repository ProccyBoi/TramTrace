#pragma once

#include <cstdint>

namespace tramtrace {

// ESP.getEfuseMac() exposes the OUI in the low 24 bits on classic ESP32s.
// Use the device-specific upper half so neighbouring boards never advertise
// the same setup access-point name.
constexpr std::uint32_t setupSuffixFromEfuseMac(std::uint64_t efuseMac) {
  return static_cast<std::uint32_t>((efuseMac >> 24U) & 0xFFFFFFULL);
}

}  // namespace tramtrace
