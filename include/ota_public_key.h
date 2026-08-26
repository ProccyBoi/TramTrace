#pragma once

namespace tramtrace {

// ECDSA P-256 public key used to verify GitHub Actions firmware releases.
// The corresponding private key exists only as the OTA_SIGNING_KEY_B64
// repository secret.
constexpr char kOtaSigningPublicKey[] = R"KEY(-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEuRuvFimTrL5IoOHDrwVXyA99qVbq
vsz+Q4hLzv/CMVEVIMbjConxkY60DseW7G4YhMPfIOsXFFw2MtuPw4dBIA==
-----END PUBLIC KEY-----
)KEY";

}  // namespace tramtrace
