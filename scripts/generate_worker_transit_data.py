"""Generate the secret-free static transit index used by the Sites Worker.

The TfNSW API token is read only from ``TFNSW_API_TOKEN``.  It is used by the
existing :mod:`server.gtfs` loader while downloading the three operator
schedule ZIPs and is never copied into the generated artifact.

Schema version 1 is deliberately compact:

``routes[route]``
    ``source`` is the matching realtime feed name, ``termini`` is the PCB
    direction-slot order, and ``stations`` contains
    ``[canonical_name, latitude, longitude]`` rows in exact PCB order.

``sources[source]``
    ``routeIds`` maps official route IDs to L1-L4; ``directionIds`` maps raw
    GTFS direction IDs to PCB direction slots; ``stops`` maps route-aware
    official stop IDs to station indexes; ``patterns`` deduplicates
    ``[stop_sequence, station_index]`` pairs per route; and ``trips`` maps
    official trip IDs to ``[route, direction, pattern_index]``.

The trip pattern index is relative to ``patterns[route]``.  A missing direction
or pattern is represented by JSON ``null``.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from server.errors import MissingTokenError, StaticGTFSLoadError
from server.gtfs import StaticGTFS, load_static_gtfs
from server.mapping import PCB_ROUTE_ORDERS, ROUTE_TERMINI
from server.schedule import DEFAULT_SCHEDULES, ScheduleSpec


SCHEMA_VERSION = 1
DEFAULT_OUTPUT = (
    REPOSITORY_ROOT
    / "hosting"
    / "worker"
    / "generated-transit-data.json"
)


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _station_position(
    static: StaticGTFS,
    route: str,
    station: str,
) -> list[float | None]:
    position = static.station_positions.get(route, {}).get(station)
    if position is None:
        return [None, None]

    latitude, longitude = position
    if not (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90.0 <= latitude <= 90.0
        and -180.0 <= longitude <= 180.0
    ):
        raise StaticGTFSLoadError(
            f"Static GTFS has invalid coordinates for {route} {station}"
        )
    # Seven decimal places is finer than one centimetre around Sydney and keeps
    # repeated platform coordinates compact and deterministic.
    return [round(latitude, 7), round(longitude, 7)]


def _source_route_ids(
    source: str,
    static: StaticGTFS,
    routes: frozenset[str],
) -> dict[str, str]:
    namespaced = {
        route_id: route
        for (namespace, route_id), route in static.routes_by_source.items()
        if namespace == source and route in routes
    }
    route_ids = namespaced or {
        route_id: route
        for route_id, route in static.routes_by_id.items()
        if route in routes
    }
    return dict(sorted(route_ids.items()))


def _source_direction_ids(
    source: str,
    static: StaticGTFS,
    routes: frozenset[str],
) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for route in sorted(routes):
        namespaced = {
            str(raw): direction
            for (namespace, item_route, raw), direction in (
                static.direction_ids_by_source.items()
            )
            if namespace == source and item_route == route
        }
        route_map = namespaced or {
            str(raw): direction
            for raw, direction in static.validated_direction_ids.get(
                route, {}
            ).items()
        }
        out[route] = dict(sorted(route_map.items()))
    return out


def _source_stops(
    source: str,
    static: StaticGTFS,
    routes: frozenset[str],
) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for route in sorted(routes):
        station_indexes = {
            station: index
            for index, station in enumerate(PCB_ROUTE_ORDERS[route])
        }
        namespaced = {
            stop_id: station
            for (namespace, item_route, stop_id), station in (
                static.stops_by_source.items()
            )
            if namespace == source and item_route == route
        }
        aliases = namespaced or {
            stop_id: station
            for (item_route, stop_id), station in static.stop_to_station.items()
            if item_route == route
        }
        out[route] = {
            stop_id: station_indexes[station]
            for stop_id, station in sorted(aliases.items())
            if station in station_indexes
        }
    return out


def _source_trips_and_patterns(
    source: str,
    static: StaticGTFS,
    routes: frozenset[str],
) -> tuple[
    dict[str, list[list[list[int]]]],
    dict[str, list[str | int | None]],
]:
    namespaced = {
        trip_id: trip
        for (namespace, trip_id), trip in static.trips_by_source.items()
        if namespace == source and trip.route in routes
    }
    trips = namespaced or {
        trip_id: trip
        for trip_id, trip in static.trips.items()
        if trip.route in routes
    }

    patterns: dict[str, list[list[list[int]]]] = {
        route: [] for route in sorted(routes)
    }
    pattern_indexes: dict[str, dict[tuple[tuple[int, int], ...], int]] = {
        route: {} for route in routes
    }
    trip_rows: dict[str, list[str | int | None]] = {}

    for trip_id, trip in sorted(trips.items()):
        station_indexes = {
            station: index
            for index, station in enumerate(PCB_ROUTE_ORDERS[trip.route])
        }
        pattern_key = tuple(
            (int(sequence), station_indexes[station])
            for sequence, station in sorted(trip.station_by_sequence.items())
            if station in station_indexes
        )
        pattern_index: int | None = None
        if pattern_key:
            by_route = pattern_indexes[trip.route]
            pattern_index = by_route.get(pattern_key)
            if pattern_index is None:
                pattern_index = len(patterns[trip.route])
                by_route[pattern_key] = pattern_index
                patterns[trip.route].append(
                    [[sequence, station_index] for sequence, station_index in pattern_key]
                )

        trip_rows[trip_id] = [trip.route, trip.direction, pattern_index]

    return patterns, trip_rows


def build_worker_transit_data(
    statics: Mapping[str, StaticGTFS],
    *,
    schedules: Sequence[ScheduleSpec] = DEFAULT_SCHEDULES,
    generated_at: str | None = None,
    require_complete_positions: bool = True,
) -> dict[str, Any]:
    """Build and validate a schema-v1 Worker artifact from operator schedules."""

    expected_sources = {spec.name for spec in schedules}
    if set(statics) != expected_sources:
        missing = sorted(expected_sources - set(statics))
        extra = sorted(set(statics) - expected_sources)
        details = []
        if missing:
            details.append("missing " + ", ".join(missing))
        if extra:
            details.append("unexpected " + ", ".join(extra))
        raise StaticGTFSLoadError(
            "Operator schedule set does not match configuration: "
            + "; ".join(details)
        )

    route_sources: dict[str, str] = {}
    for spec in schedules:
        for route in spec.routes:
            previous = route_sources.setdefault(route, spec.name)
            if previous != spec.name:
                raise StaticGTFSLoadError(
                    f"Route {route} is assigned to multiple schedule sources"
                )
    if set(route_sources) != set(PCB_ROUTE_ORDERS):
        raise StaticGTFSLoadError("Schedule sources do not cover exactly L1-L4")

    routes: dict[str, dict[str, Any]] = {}
    missing_positions: list[str] = []
    for route, station_names in PCB_ROUTE_ORDERS.items():
        source = route_sources[route]
        static = statics[source]
        station_rows: list[list[str | float | None]] = []
        for station in station_names:
            latitude, longitude = _station_position(static, route, station)
            if latitude is None or longitude is None:
                missing_positions.append(f"{route} {station}")
            station_rows.append([station, latitude, longitude])
        routes[route] = {
            "source": source,
            "termini": list(ROUTE_TERMINI[route]),
            "stations": station_rows,
        }

    if require_complete_positions and missing_positions:
        preview = ", ".join(missing_positions[:8])
        remainder = len(missing_positions) - 8
        suffix = f" (+{remainder} more)" if remainder > 0 else ""
        raise StaticGTFSLoadError(
            "Static GTFS is missing PCB station coordinates: "
            + preview
            + suffix
        )

    sources: dict[str, dict[str, Any]] = {}
    for spec in schedules:
        static = statics[spec.name]
        route_ids = _source_route_ids(spec.name, static, spec.routes)
        if set(route_ids.values()) != set(spec.routes):
            missing = sorted(set(spec.routes) - set(route_ids.values()))
            raise StaticGTFSLoadError(
                f"{spec.name} schedule is missing route IDs for "
                + ", ".join(missing)
            )
        patterns, trips = _source_trips_and_patterns(
            spec.name, static, spec.routes
        )
        if not trips:
            raise StaticGTFSLoadError(
                f"{spec.name} schedule contains no supported trips"
            )
        sources[spec.name] = {
            "routeIds": route_ids,
            "directionIds": _source_direction_ids(
                spec.name, static, spec.routes
            ),
            "stops": _source_stops(spec.name, static, spec.routes),
            "patterns": patterns,
            "trips": trips,
        }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at or _utc_timestamp(),
        "routes": routes,
        "sources": sources,
    }


def load_operator_schedules(
    schedules: Sequence[ScheduleSpec],
    *,
    token: str | None,
    timeout_seconds: float,
) -> dict[str, StaticGTFS]:
    """Download/read and parse each configured operator schedule independently."""

    return {
        spec.name: load_static_gtfs(
            spec.source,
            token=token,
            timeout_seconds=timeout_seconds,
            expected_routes=spec.routes,
            namespace=spec.name,
        )
        for spec in schedules
    }


def _source_overrides(values: Sequence[str]) -> dict[str, str]:
    known = {spec.name for spec in DEFAULT_SCHEDULES}
    out: dict[str, str] = {}
    for value in values:
        name, separator, source = value.partition("=")
        if not separator or not name or not source:
            raise ValueError("--source must use NAME=PATH_OR_URL")
        if name not in known:
            raise ValueError(
                f"Unknown schedule source {name!r}; expected "
                + ", ".join(sorted(known))
            )
        out[name] = source
    return out


def _write_json_atomic(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        dir=path.parent,
        prefix=path.name + ".",
        suffix=".tmp",
        delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            json.dump(
                data,
                handle,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            handle.write("\n")
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"output JSON path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--source",
        action="append",
        default=[],
        metavar="NAME=PATH_OR_URL",
        help="override an operator schedule URL with a local ZIP or directory",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=90.0,
        help="download timeout per schedule in seconds",
    )
    args = parser.parse_args(argv)

    try:
        overrides = _source_overrides(args.source)
        schedules = tuple(
            ScheduleSpec(
                spec.name,
                overrides.get(spec.name, spec.source),
                spec.routes,
            )
            for spec in DEFAULT_SCHEDULES
        )
        token = os.environ.get("TFNSW_API_TOKEN", "").strip() or None
        statics = load_operator_schedules(
            schedules,
            token=token,
            timeout_seconds=max(1.0, args.timeout),
        )
        artifact = build_worker_transit_data(
            statics,
            schedules=schedules,
        )
        _write_json_atomic(args.output.resolve(), artifact)
    except (MissingTokenError, StaticGTFSLoadError, OSError, ValueError) as exc:
        parser.exit(1, f"error: {exc}\n")

    route_count = len(artifact["routes"])
    station_count = sum(
        len(route["stations"]) for route in artifact["routes"].values()
    )
    trip_count = sum(
        len(source["trips"]) for source in artifact["sources"].values()
    )
    print(
        f"Wrote schema v{SCHEMA_VERSION} with {route_count} routes, "
        f"{station_count} route-stations, and {trip_count} trips to "
        f"{args.output.resolve()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
