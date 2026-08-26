# TramTrace

TramTrace is ESP32 firmware plus a small FastAPI service for the four Sydney
light-rail lines shown on the custom TramTrace PCB. Each station normally has
two addressable LEDs: payload slot 0 shows a tram travelling toward the first
terminus below, and slot 1 shows the opposite direction.

| Route | Slot 0 | Slot 1 |
| --- | --- | --- |
| L1 | Dulwich Hill | Central |
| L2 | Randwick | Circular Quay |
| L3 | Juniors Kingsford | Circular Quay |
| L4 | Westmead | Carlingford |

The design uses the working
[ProccyBoi/Metroboard](https://github.com/ProccyBoi/Metroboard) project as its
software reference for captive setup, saved ESP32 settings, TfNSW server-side
authentication, live polling, and distance/status LED states. TramTrace has a
separate direction-aware payload and a mapping traced specifically from this
board's KiCad schematic and PCB layout.

## Repository layout

- `src/main.cpp` — ESP32 firmware, setup portal, live polling and LED effects.
- `include/station_map.h` — compiled GPIO, strip and direction-to-pixel map.
- `include/display_logic.h` — solid/off display and shared-route priority.
- `include/ota_policy.h` and `include/ota_public_key.h` — strict version and
  signed-release verification policy.
- `hardware/STATION_MAPPING.csv` — schematic/layout cross-reference including
  every LED reference and current TfNSW parent stop ID.
- `hardware/README.md` — electrical chains and layout exceptions.
- `server/` — TfNSW static/GTFS-Realtime to TramTrace payload service.
- `tests/` and `test/` — backend, mapping and native firmware-map tests.

- `hosting/` contains the permanent Sites Worker deployment and status page.
- `scripts/generate_worker_transit_data.py` builds its token-free compact
  schedule index from the official operator bundles. GitHub Actions runs the
  complete test/build matrix and publishes signed firmware release assets.

## Important PCB exceptions

- GPIO16 drives the 45-pixel L1 chain.
- GPIO17 drives only the eight L2 branch pixels from Randwick through Royal
  Randwick.
- GPIO18 drives L3 and the L2/L3 shared trunk from Moore Park through Circular
  Quay.
- GPIO19 drives the 32-pixel L4 chain.
- GPIO25 drives the single status LED.
- L1 Central has one physical pixel, so both L1 directions merge there.

See `hardware/README.md` before changing a pixel number. There are 116
addressable LEDs including status; do not run an all-white, full-brightness
test from computer USB power. Firmware caps route brightness at 64/255 and its
first-boot test lights one pixel at a time.

## Build and upload

The PlatformIO platform and toolchain are pinned so local and GitHub builds use
the same ESP32 Arduino release. The 16 MB partition table provides two 6.4 MB
application slots for rollback-safe OTA.

```powershell
platformio test -e native
platformio run -e tramtrace
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\flash_connected_boards.ps1 -Ports COM9,COM20
platformio device monitor -b 115200 -p COM9
```

The uploader validates that each selected port is a CH340 device, writes the
bootloader, OTA partition table and initial app image, and does not erase the
NVS configuration partition at `0x9000..0xDFFF`. To upload one board, run
`scripts/upload_firmware_only.ps1 -Port COM9`.

On its first TramTrace boot the board runs a low-brightness, one-pixel chase,
then opens an access point named `TramTrace-Setup-XXXXXX`. Join it and open
`http://192.168.4.1/` to enter:

1. A nearby Wi-Fi network from the scan list (or a manually typed hidden SSID)
   and its password.
2. The public backend URL, either its base URL or the full
   `/tramtrace_payload` URL.
3. An optional board ID and a brightness from 1 to 64.

Useful 115200-baud serial commands are `info`, `test`, `test-pairs`,
`simulate`, `simulate-loop`, `stop`, `map`, `config`, `ota-check`, and
`factory-reset`.
They remain available while the setup portal is open. `test-pairs` is the
final assembled-board check: for each printed station it lights slot 0 and
then slot 1.

The board can also be provisioned without changing the computer's Wi-Fi:

```text
provision|ssid|password|https://backend.example|board-key|20
```

This command saves the values to ESP32 NVS and restarts into live mode. The
firmware never prints the password or board key back to serial.

`simulate` runs two virtual trams in opposite directions on every route. Each
stop progresses through in-range, approaching and stopped states using the
current GTFS route identities. Simulation uses a fixed comparison brightness
of 40/255. Only eight route pixels are active per frame, so this remains safe
on USB while making the physical route colours easier to compare.
`simulate-loop` saves and repeats that mode continuously, including after a
power cycle; send `stop` over serial to clear the saved replay setting and
return to normal setup/live operation.

The route display is binary: every non-zero live state is continuously solid
and state zero is off. The official browser sRGB values are retained separately
from a quantisation-aware physical LED palette. On the assembled board that
palette deliberately renders L1 as warm red, L2 as bright clean red, L3 as
dark clean red, and L4 as rose-red. This exaggeration is necessary because the
four closely related official reds otherwise collapse to the same integer PWM
values at normal brightness. L3 remains blue-free because blue made it look
pink through the physical optics. A shared L2/L3 trunk pixel uses the stronger
state; an equal-state tie keeps one deterministic colour instead of blinking
or blending. Firmware 0.3.1 applies the selected brightness directly; the
separate status LED remains at 12. Live frames no longer retain a missing pixel
for an extra poll, preventing a moving vehicle from appearing at both its old
and new stations. The live service also deduplicates TfNSW records by
tracking-beacon and trip-instance identity before emitting station states. The
default activation bands are 120 m, 450 m, and 800 m.

## Signed over-the-air updates

Firmware 0.3.1 checks the public TramTrace Sites service after 60 seconds, then
every six hours. A failed check retries after 15 minutes. The board requests
`/firmware_manifest`, and the service resolves the latest immutable GitHub
Release before streaming `/firmware.bin`. `ota-check` triggers the same flow
immediately over serial.

Every release is authenticated twice before boot:

1. The board verifies an ECDSA P-256 signature over the version, byte size and
   SHA-256 digest using the public key compiled into the firmware.
2. While writing the inactive OTA slot it verifies both SHA-256 and the ESP32
   updater's MD5 check, then reboots only after the image finishes cleanly.

The signing key is stored only in the `OTA_SIGNING_KEY_B64` GitHub Actions
secret. To publish a later release, change `kFirmwareVersion` to a strict
`X.Y.Z` version, merge a green pull request, and push the matching `vX.Y.Z`
tag. The release workflow rejects a tag/version mismatch and publishes
`manifest.json` plus `tramtrace-X.Y.Z.bin`. Never commit the private signing
key or reuse a firmware version.

## Run the backend

Python 3.10 or newer and a TfNSW Open Data API token are required.

```powershell
python -m pip install -r server/requirements.txt
$env:TFNSW_API_TOKEN = "your TfNSW Open Data token"
python -m uvicorn server.app:app --host 0.0.0.0 --port 8000
```

By default the service loads TfNSW's three operator schedule bundles for L1,
L2/L3 and L4. Those are the correct static timetables to match against the
three live feeds, and each has an independent last-good cache.

`TRAMTRACE_GTFS_SOURCE` is optional. Set it to a local complete-GTFS ZIP only
if you want a supplementary offline base; the realtime-aligned operator
schedules still overlay its trip, route, stop and direction indexes.

```powershell
$env:TRAMTRACE_GTFS_SOURCE = "D:\path\to\full-gtfs.zip"
```

The service polls the separate L1, L2/L3 and L4 vehicle-position feeds,
preserves a last-good cache per feed, and excludes stale feeds independently.
It resolves direction using a validated live `direction_id`, then the matching
static trip/headsign and stop sequence. Unknown direction is left off rather
than guessed.

See `server/README.md` for the API schema and all environment variables.

## Permanent deployment

The production service is deployed at
[tramtrace-sydney-live.chatgptbolt.chatgpt.site](https://tramtrace-sydney-live.chatgptbolt.chatgpt.site).
The ESP32 payload route requires its private board key, while `/healthz` and
the status page expose no credentials. The TfNSW token is stored only as a
hosted runtime secret.

The Worker fetches all three light-rail feeds concurrently, serves the same
68-station, two-direction schema as the Python backend, and exposes the public
signed OTA manifest/binary proxy without exposing TfNSW or board credentials.
Refresh
`hosting/worker/generated-transit-data.json` when TfNSW changes its schedule
identifiers:

```powershell
$env:TFNSW_API_TOKEN = "your TfNSW Open Data token"
python scripts/generate_worker_transit_data.py
```

## Verification

```powershell
python -m pytest tests -q
platformio test -e native
platformio run -e tramtrace
cd hosting
pnpm test
```

The ESP32 network client does not pin a certificate chain because the hosted
chain can rotate. OTA authenticity does not depend on TLS: the immutable
release digest is signed and verified on-device. The live payload still relies
on HTTPS transport, so keep TfNSW credentials only on the backend and never put
service secrets in firmware or the public repository.
