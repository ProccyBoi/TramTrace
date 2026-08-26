# Security policy

## Supported versions

Only the latest published firmware and the current `main` branch receive
security fixes. Older firmware should be updated through the signed OTA channel
or reflashed over USB.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use
[GitHub private vulnerability reporting](https://github.com/ProccyBoi/TramTrace/security/advisories/new)
and include:

- the affected firmware, endpoint or commit;
- reproduction steps and expected impact;
- whether credentials or a physical board are required; and
- any suggested mitigation, if known.

Do not include real Wi-Fi passwords, Transport for NSW tokens, board access
keys or OTA private keys in reports or test fixtures. The maintainer will
coordinate remediation and public disclosure after a fix is available.

## Security boundaries

- Wi-Fi credentials and board access keys are stored in ESP32 NVS and are not
  printed or repopulated into the captive portal.
- The hosted board feed is protected by a bearer access key; Transport for NSW
  credentials remain server-side.
- HTTPS certificate validation protects live and OTA transport. Firmware OTA
  authenticity additionally requires the compiled ECDSA public key and a
  matching SHA-256 digest.
- Public firmware manifests and binaries contain no service credentials.
- Physical access to an ESP32 is outside the remote threat model. ESP32 secure
  boot and flash encryption are not currently provisioned.
