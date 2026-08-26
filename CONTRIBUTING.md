# Contributing to TramTrace

Thanks for helping improve TramTrace. Changes should be small, reviewable and
covered by the relevant automated tests.

## Development workflow

1. Fork the repository and create a focused branch.
2. Do not commit credentials, generated private keys, feed captures containing
   secrets, build output or local environment files.
3. Run the complete verification gate documented in `README.md`.
4. Open a pull request describing the behavior change, hardware assumptions and
   tests performed.

Changes to GPIO, chain order, station pairing or direction slots must update
`hardware/STATION_MAPPING.csv`, `hardware/README.md` and the corresponding
hardware/native tests together. Do not infer LED order from reference numbers;
the existing map was traced from both schematic nets and PCB placement.

Firmware pull requests should not change `kFirmwareVersion` unless they are the
designated release change. Release tags and signing are performed only after a
green change reaches `main`.

## Quality and security

- Preserve fail-closed behavior for stale feeds, malformed payloads, TLS and
  signed OTA verification.
- Keep route brightness within the documented USB-safe limit.
- Add regression tests for fixes and new edge cases.
- Report vulnerabilities privately under `SECURITY.md`, not in a public issue.

By submitting a contribution, you confirm you have the right to provide it.
The repository currently has no open-source licence, so contribution and
licensing terms should be agreed with the maintainer before substantial work.
