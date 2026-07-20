# TramTrace backend

This FastAPI service converts the official TfNSW light-rail vehicle-position
feeds into the two direction LEDs fitted at every TramTrace PCB station.
Metroboard's stop-first/nearest-stop state model is retained, but route and
direction handling is deliberately stricter for L1-L4.

## Run

Python 3.10 or newer is required.

```powershell
python -m pip install -r server/requirements.txt
$env:TFNSW_API_TOKEN = "your TfNSW Open Data token"
python -m uvicorn server.app:app --host 0.0.0.0 --port 8000
```

By default, the service loads TfNSW's three operator schedule bundles:
Inner West for L1, CBD and South East for L2/L3, and Parramatta for L4. These
bundles share route and trip identifiers with their matching realtime feeds,
including `CSELR_L2`, `CSELR_L3`, and `ISD-17-6720_L4`.

`TRAMTRACE_GTFS_SOURCE` is an optional base override. It may point to an
extracted GTFS directory, a GTFS ZIP, or an HTTP(S) ZIP URL. When configured,
its station coordinates are retained while the operator schedules overlay the
realtime-aligned trip, route, direction, and stop indexes. The service does not
download the large complete Greater Sydney GTFS bundle unless it is explicitly
configured here. Neither a token nor a downloaded GTFS archive is committed to
this repository.

## ESP32 endpoint

`GET /tramtrace_payload` returns:

```json
{
  "schema": 1,
  "timestamp": 1784420000,
  "feed_age": 2,
  "brightness": 24,
  "poll_seconds": 3,
  "states": {
    "L1": {
      "Dulwich Hill": [0, 0],
      "Bank Street": [2, 0],
      "Central": [0, 3]
    }
  }
}
```

Every real response contains every PCB station on L1-L4 in PCB chain order.
Each station value is `[direction0, direction1]`:

| Route | direction 0 heads toward | direction 1 heads toward |
| --- | --- | --- |
| L1 | Dulwich Hill | Central |
| L2 | Randwick | Circular Quay |
| L3 | Juniors Kingsford | Circular Quay |
| L4 | Westmead | Carlingford |

L4's direction slots intentionally run opposite to its PCB station-list
order. A source-namespaced operator trip match can recover both route and
direction when realtime omits them. Otherwise direction is resolved from the
validated realtime value, the trip headsign/terminus, or the ordered trip
pattern for short turns.

States use Metroboard-compatible values:

- `0`: off / no fresh vehicle in range
- `1`: vehicle within the far radius, or in transit to a reported stop
- `2`: approaching the reported station / within the approaching radius
- `3`: stopped at the station / within the at-station radius

The backend returns PCB labels, including `Bank Street` for TfNSW's
`Fish Market`, `Childrens Hospital`, `ES Marks`, and the correct route-specific
Central aliases. L2 and L3 remain separate in JSON even where their physical
trunk LEDs are shared.

Before station states are emitted, observations are grouped by their
source-scoped TfNSW tracking-beacon ID and scheduled trip instance. When the
same vehicle is present in multiple feed records, only the newest deterministic
station candidate is retained. Distinct vehicles at the same station still
combine normally, while records without a stable identity are left separate
rather than guessed.

`GET /healthz` reports token/static readiness plus per-feed and per-schedule
availability, last-good age, and refresh errors. Responses use
`Cache-Control: no-store`.

## Live feed defaults

- L1: `https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/lightrail/innerwest`
- L2/L3: `https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast`
- L4: `https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/lightrail/parramatta`

Each feed has an independent last-good cache. A transient failure therefore
does not blank unrelated routes; cached data naturally turns off once it fails
the configured feed/vehicle stale guards.

## Operator schedule defaults

- L1: `https://api.transport.nsw.gov.au/v1/gtfs/schedule/lightrail/innerwest`
- L2/L3: `https://api.transport.nsw.gov.au/v1/gtfs/schedule/lightrail/cbdandsoutheast`
- L4: `https://api.transport.nsw.gov.au/v1/gtfs/schedule/lightrail/parramatta`

Each source refreshes independently and retains its own last-good schedule if a
later fetch fails.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TFNSW_API_TOKEN` | none | Required TfNSW Open Data API token |
| `TRAMTRACE_GTFS_SOURCE` | none | Optional base GTFS directory, ZIP, or URL |
| `TRAMTRACE_BRIGHTNESS` | `24` | Payload brightness, clamped to `0..64` |
| `TRAMTRACE_POLL_SECONDS` | `3` | ESP32 polling interval |
| `TRAMTRACE_FEED_CACHE_SECONDS` | `3` | Minimum live-feed refetch interval |
| `TRAMTRACE_STATIC_REFRESH_SECONDS` | `21600` | Optional base-GTFS refresh interval |
| `TRAMTRACE_SCHEDULE_REFRESH_SECONDS` | `21600` | Per-operator schedule refresh interval |
| `TRAMTRACE_SCHEDULE_RETRY_SECONDS` | `60` | Failed schedule retry interval |
| `TRAMTRACE_MAX_VEHICLE_AGE_SECONDS` | `90` | Per-vehicle stale cutoff |
| `TRAMTRACE_MAX_FEED_AGE_SECONDS` | `120` | Whole-feed stale cutoff |
| `TRAMTRACE_AT_STATION_METRES` | `120` | State 3 distance |
| `TRAMTRACE_APPROACHING_METRES` | `450` | State 2 distance |
| `TRAMTRACE_FAR_METRES` | `800` | State 1 distance |
| `TRAMTRACE_L1_VP_URL` | official L1 URL | L1 feed override |
| `TRAMTRACE_L23_VP_URL` | official L2/L3 URL | L2/L3 feed override |
| `TRAMTRACE_L4_VP_URL` | official L4 URL | L4 feed override |
| `TRAMTRACE_L1_SCHEDULE_SOURCE` | official L1 schedule | L1 schedule directory, ZIP, or URL override |
| `TRAMTRACE_L23_SCHEDULE_SOURCE` | official L2/L3 schedule | L2/L3 schedule directory, ZIP, or URL override |
| `TRAMTRACE_L4_SCHEDULE_SOURCE` | official L4 schedule | L4 schedule directory, ZIP, or URL override |

## Tests

Tests build tiny base/operator GTFS ZIPs and protobuf GTFS-Realtime messages;
they never download TfNSW archives or require a real token. Operator fixtures
exercise the documented CSELR and Parramatta route/trip identifier formats.

```powershell
python -m pytest tests/server
```
