# TramTrace live service

This is the permanent Sites-hosted backend for the TramTrace ESP32 map. It
fetches the three official Transport for NSW light-rail vehicle-position feeds,
maps vehicles to the 68 route-stations on the PCB, and emits two directional
states per station. Because L4 vehicle positions can be intermittently missing
or stale, its Trip Update feed can supply one close stop within 90 seconds.
Fresh vehicle positions always take precedence, and source-scoped vehicle and
trip identities ensure one tram can win only one station in each payload.
The fallback requires a fresh full feed and absolute near-term stop event; an
unchanged per-trip timestamp is recorded diagnostically but is not treated as
current position evidence.

Successful board payloads are edge-cached for 15 seconds. The three
vehicle-position feeds refresh no more often than every 15 seconds per Worker
instance, while the separate L4 Trip Update feed has a hard 60-second minimum
and an edge cache. Failed refreshes use exponential backoff, and any
still-fresh last-good feeds remain usable.

## Endpoints

- `GET /tramtrace_payload?board_id=...` returns the firmware payload. The
  `board_id` must match the hosted `TRAMTRACE_BOARD_KEY` secret.
- `GET /healthz` reports feed and static-index freshness without exposing
  credentials.
- `GET /` renders a small public service page.

## Runtime configuration

Production values are managed by Sites and are not stored in this repository:

- `TFNSW_API_TOKEN` (secret)
- `TRAMTRACE_BOARD_KEY` (secret)
- `TRAMTRACE_BRIGHTNESS` (default `24`, maximum `64`)
- `TRAMTRACE_POLL_SECONDS` (default `3`)
- `TRAMTRACE_FEED_CACHE_SECONDS` (default and hard minimum `15`)
- `TRAMTRACE_AT_STATION_METRES` (default `120`)
- `TRAMTRACE_APPROACHING_METRES` (default `450`)
- `TRAMTRACE_FAR_METRES` (default `800`)
- `TRAMTRACE_L4_FAR_METRES` (default `1700`; reported next stops only)
- `TRAMTRACE_L4_TRIP_UPDATE_CACHE_SECONDS` (default and hard minimum `60`)
- `TRAMTRACE_L4_TRIP_UPDATE_FAR_SECONDS` (default `90`; maximum lookahead)
- `TRAMTRACE_L4_TRIP_UPDATE_URL` (defaults to the official Parramatta Light
  Rail Trip Update endpoint)

## Static transit index

`worker/generated-transit-data.json` is a credential-free snapshot derived from
the three operator schedule bundles. Refresh it when TfNSW changes identifiers
or stop geometry:

```powershell
$env:TFNSW_API_TOKEN = "<token>"
python ..\scripts\generate_worker_transit_data.py
```

The generator validates route coverage, all 68 station coordinates, directions,
trip patterns, and route-aware stop aliases before replacing the artifact.

## Development

Requires Node.js 22.13 or later and pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm test
```
