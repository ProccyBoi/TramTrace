#pragma once

#include <cstdint>

namespace tramtrace {

struct FirmwareVersion {
  uint32_t major = 0;
  uint32_t minor = 0;
  uint32_t patch = 0;
};

inline bool parseFirmwareVersion(const char *value, FirmwareVersion &version) {
  if (value == nullptr || *value == '\0') {
    return false;
  }

  uint32_t parts[3] = {};
  const char *cursor = value;
  for (uint8_t index = 0; index < 3; ++index) {
    if (*cursor < '0' || *cursor > '9') {
      return false;
    }

    uint32_t part = 0;
    while (*cursor >= '0' && *cursor <= '9') {
      const uint32_t digit = static_cast<uint32_t>(*cursor - '0');
      if (part > 1000000U ||
          (part == 1000000U && digit > 0U)) {
        return false;
      }
      part = part * 10U + digit;
      ++cursor;
    }
    parts[index] = part;

    if (index < 2) {
      if (*cursor != '.') {
        return false;
      }
      ++cursor;
    }
  }

  if (*cursor != '\0') {
    return false;
  }

  version = {parts[0], parts[1], parts[2]};
  return true;
}

inline bool firmwareVersionIsNewer(const char *candidate,
                                   const char *current) {
  FirmwareVersion candidateVersion;
  FirmwareVersion currentVersion;
  if (!parseFirmwareVersion(candidate, candidateVersion) ||
      !parseFirmwareVersion(current, currentVersion)) {
    return false;
  }

  if (candidateVersion.major != currentVersion.major) {
    return candidateVersion.major > currentVersion.major;
  }
  if (candidateVersion.minor != currentVersion.minor) {
    return candidateVersion.minor > currentVersion.minor;
  }
  return candidateVersion.patch > currentVersion.patch;
}

}  // namespace tramtrace
