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
- `hardware/STATION_MAPPING.csv` — schematic/layout cross-reference including
  every LED reference and current TfNSW parent stop ID.
- `hardware/README.md` — electrical chains and layout exceptions.
- `server/` — TfNSW static/GTFS-Realtime to TramTrace payload service.
- `tests/` and `test/` — backend, mapping and native firmware-map tests.

- `hosting/` contains the permanent Sites Worker deployment and status page.
- `scripts/generate_worker_transit_data.py` builds its token-free compact
  schedule index from the official operator bundles.

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

The checked-in PlatformIO environment targets the connected ESP32 on `COM9`.
Change `upload_port` and `monitor_port` in `platformio.ini` if Windows assigns a
different port.

```powershell
platformio test -e native
platformio run -e tramtrace
platformio run -e tramtrace -t upload
platformio device monitor -b 115200 -p COM9
```

On its first TramTrace boot the board runs a low-brightness, one-pixel chase,
then opens an access point named `TramTrace-Setup-XXXXXX`. Join it and open
`http://192.168.4.1/` to enter:

1. Wi-Fi name and password.
2. The public backend URL, either its base URL or the full
   `/tramtrace_payload` URL.
3. An optional board ID and a brightness from 1 to 64.

Useful 115200-baud serial commands are `info`, `test`, `test-pairs`,
`simulate`, `simulate-loop`, `stop`, `map`, `config`, and `factory-reset`.
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
current GTFS route colours: L1 `#BE1622`, L2 `#DD1E25`, L3 `#781140`, and L4
`#BB2043`. Simulation brightness is capped at 16/255 for USB safety.
`simulate-loop` saves and repeats that mode continuously, including after a
power cycle; send `stop` over serial to clear the saved replay setting and
return to normal setup/live operation.

The route display is binary: every non-zero live state is continuously solid
and state zero is off. Individual RGB channels are never dimmed, so every lit
pixel uses the route's complete official RGB value. A shared L2/L3 trunk pixel
uses the stronger state; an equal-state tie keeps one deterministic colour
instead of blinking or blending. The default activation bands are 120 m,
450 m, and 800 m.

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

The Worker fetches all three light-rail feeds concurrently and serves the same
68-station, two-direction schema as the Python backend. Refresh
`hosting/worker/generated-transit-data.json` when TfNSW changes its schedule
identifiers:

```powershell
$env:TFNSW_API_TOKEN = "your TfNSW Open Data token"
python scripts/generate_worker_transit_data.py
```

## Verification

```powershell
python -m pytest tests/server tests/hardware -q
platformio test -e native
platformio run -e tramtrace
```

The firmware currently uses TLS without certificate verification, matching the
Metroboard reference. Keep TfNSW credentials only on the backend, use HTTPS,
and place the backend behind a trusted reverse proxy before exposing it
publicly.
