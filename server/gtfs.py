"""Focused static-GTFS loader for the four TramTrace light-rail routes."""

from __future__ import annotations

import csv
import io
import os
import tempfile
import time
import zipfile
from collections import Counter, defaultdict
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Iterable, Iterator, Mapping, Protocol
from urllib.parse import urlparse

import requests

from .errors import MissingTokenError, StaticGTFSLoadError
from .mapping import (
    PCB_ROUTE_ORDERS,
    ROUTE_TERMINI,
    SUPPORTED_ROUTES,
    canonical_station,
    route_station_index,
)


OFFICIAL_COMPLETE_GTFS_URL = (
    "https://opendata.transport.nsw.gov.au/data/dataset/"
    "d1f68d4f-b778-44df-9823-cf2fa922e47f/resource/"
    "67974f14-01bf-47b7-bfa5-c7f2f8a950ca/download/"
    "full_greater_sydney_gtfs_static_0.zip"
)
_MAX_REMOTE_GTFS_BYTES = 600 * 1024 * 1024
_REMOTE_GTFS_MEMORY_BYTES = 32 * 1024 * 1024
_MAX_GTFS_MEMBER_BYTES = 4 * 1024 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class StopPoint:
    stop_id: str
    name: str
    latitude: float | None
    longitude: float | None
    parent_station: str | None


@dataclass(frozen=True, slots=True)
class TripPattern:
    trip_id: str
    route_id: str
    route: str
    headsign: str
    raw_direction_id: int | None
    direction: int | None
    stations: tuple[str, ...]
    station_by_sequence: Mapping[int, str]
    stop_ids: frozenset[str]


@dataclass(frozen=True, slots=True)
class StaticGTFS:
    """The small, immutable subset of full GTFS needed by TramTrace."""

    source: str
    loaded_at: float
    routes_by_id: Mapping[str, str]
    trips: Mapping[str, TripPattern]
    stops: Mapping[str, StopPoint]
    stop_to_station: Mapping[tuple[str, str], str]
    station_positions: Mapping[str, Mapping[str, tuple[float, float]]]
    validated_direction_ids: Mapping[str, Mapping[int, int]]
    routes_by_source: Mapping[tuple[str, str], str]
    trips_by_source: Mapping[tuple[str, str], TripPattern]
    stops_by_source: Mapping[tuple[str, str, str], str]
    direction_ids_by_source: Mapping[tuple[str, str, int], int]

    def route_for_id(
        self, route_id: str | None, source: str | None = None
    ) -> str | None:
        if not route_id:
            return None
        if source:
            namespaced = self.routes_by_source.get((source, str(route_id)))
            if namespaced:
                return namespaced
        direct = self.routes_by_id.get(str(route_id))
        if direct:
            return direct
        short = str(route_id).upper()
        return short if short in SUPPORTED_ROUTES else None

    def trip_for(
        self, source: str | None, trip_id: str | None
    ) -> TripPattern | None:
        if not trip_id:
            return None
        if source:
            namespaced = self.trips_by_source.get((source, str(trip_id)))
            if namespaced:
                return namespaced
        return self.trips.get(str(trip_id))

    def station_for_stop(
        self, route: str, stop_id: str | None, source: str | None = None
    ) -> str | None:
        if not stop_id:
            return None
        if source:
            namespaced = self.stops_by_source.get((source, route, str(stop_id)))
            if namespaced:
                return namespaced
        return self.stop_to_station.get((route, str(stop_id)))

    def checked_direction_id(
        self,
        route: str,
        raw_direction_id: int | None,
        source: str | None = None,
    ) -> int | None:
        if raw_direction_id not in (0, 1):
            return None
        if source:
            namespaced = self.direction_ids_by_source.get(
                (source, route, raw_direction_id)
            )
            if namespaced in (0, 1):
                return namespaced
        return self.validated_direction_ids.get(route, {}).get(raw_direction_id)


@dataclass(slots=True)
class _TripDraft:
    trip_id: str
    route_id: str
    route: str
    headsign: str
    raw_direction_id: int | None
    stop_times: list[tuple[int, str]]


class _CsvBundle(Protocol):
    def open_text(self, filename: str) -> AbstractContextManager[IO[str]]:
        ...

    def close(self) -> None:
        ...


class _DirectoryBundle:
    def __init__(self, path: Path):
        self.path = path
        by_name: dict[str, list[Path]] = defaultdict(list)
        for candidate in path.rglob("*.txt"):
            by_name[candidate.name.casefold()].append(candidate)
        self._members = {
            name: min(paths, key=lambda item: (len(item.parts), len(str(item))))
            for name, paths in by_name.items()
        }

    def open_text(self, filename: str) -> IO[str]:
        path = self._members.get(filename.casefold())
        if path is None:
            raise StaticGTFSLoadError(f"Static GTFS is missing {filename}")
        return path.open("r", encoding="utf-8-sig", newline="")

    def close(self) -> None:
        return None


class _ZipBundle:
    def __init__(
        self,
        source: str | Path | IO[bytes],
        *,
        close_source: bool = False,
    ):
        self._owned_source = source if close_source and hasattr(source, "close") else None
        try:
            self._zip = zipfile.ZipFile(source)
        except (OSError, zipfile.BadZipFile) as exc:
            if self._owned_source is not None:
                self._owned_source.close()
            raise StaticGTFSLoadError("Static GTFS source is not a valid ZIP") from exc

        by_name: dict[str, list[str]] = defaultdict(list)
        for member in self._zip.namelist():
            if member.endswith("/"):
                continue
            by_name[Path(member).name.casefold()].append(member)
        self._members = {
            name: min(paths, key=lambda item: (item.count("/"), len(item)))
            for name, paths in by_name.items()
        }

    def open_text(self, filename: str) -> IO[str]:
        member = self._members.get(filename.casefold())
        if member is None:
            raise StaticGTFSLoadError(f"Static GTFS is missing {filename}")
        info = self._zip.getinfo(member)
        if info.file_size > _MAX_GTFS_MEMBER_BYTES:
            raise StaticGTFSLoadError(f"Static GTFS member {filename} is unexpectedly large")
        return io.TextIOWrapper(self._zip.open(info), encoding="utf-8-sig", newline="")

    def close(self) -> None:
        try:
            self._zip.close()
        finally:
            if self._owned_source is not None:
                self._owned_source.close()


def _is_url(source: str) -> bool:
    return urlparse(source).scheme.casefold() in {"http", "https"}


def _open_bundle(
    source: str | os.PathLike[str],
    *,
    token: str | None,
    session: requests.Session | None,
    timeout_seconds: float,
) -> _CsvBundle:
    source_text = os.fspath(source)
    if _is_url(source_text):
        host = (urlparse(source_text).hostname or "").casefold()
        if host == "api.transport.nsw.gov.au" and not token:
            raise MissingTokenError(
                "TFNSW_API_TOKEN is required to download the official static GTFS"
            )
        client = session or requests.Session()
        headers = {
            "Accept": "application/zip",
            "Cache-Control": "no-cache",
            "User-Agent": "tramtrace/1.0",
        }
        if token and host == "api.transport.nsw.gov.au":
            headers["Authorization"] = f"apikey {token}"
        response: requests.Response | None = None
        body = tempfile.SpooledTemporaryFile(
            max_size=_REMOTE_GTFS_MEMORY_BYTES,
            mode="w+b",
        )
        try:
            response = client.get(
                source_text,
                headers=headers,
                timeout=timeout_seconds,
                stream=True,
            )
            response.raise_for_status()
            try:
                content_length = int(response.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                content_length = 0
            if content_length > _MAX_REMOTE_GTFS_BYTES:
                raise StaticGTFSLoadError("Static GTFS download is unexpectedly large")

            for chunk in response.iter_content(1024 * 1024):
                if not chunk:
                    continue
                body.write(chunk)
                if body.tell() > _MAX_REMOTE_GTFS_BYTES:
                    raise StaticGTFSLoadError(
                        "Static GTFS download exceeded the size limit"
                    )
            body.seek(0)
            return _ZipBundle(body, close_source=True)
        except requests.RequestException as exc:
            body.close()
            raise StaticGTFSLoadError(f"Unable to download static GTFS: {exc}") from exc
        except Exception:
            body.close()
            raise
        finally:
            if response is not None:
                response.close()

    path = Path(source_text).expanduser()
    if not path.exists():
        raise StaticGTFSLoadError(f"Static GTFS source does not exist: {path}")
    if path.is_dir():
        return _DirectoryBundle(path)
    return _ZipBundle(path)


def _rows(bundle: _CsvBundle, filename: str) -> Iterator[dict[str, str]]:
    with bundle.open_text(filename) as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise StaticGTFSLoadError(f"Static GTFS {filename} has no CSV header")
        for row in reader:
            yield {key: (value or "").strip() for key, value in row.items() if key}


def _as_int(value: str | int | None) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _as_float(value: str | float | None) -> float | None:
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _collapsed(values: Iterable[str]) -> tuple[str, ...]:
    out: list[str] = []
    for value in values:
        if value and (not out or out[-1] != value):
            out.append(value)
    return tuple(out)


def normalise_trip_direction(
    route: str,
    *,
    headsign: str | None,
    station_sequence: Iterable[str] = (),
    raw_direction_id: int | None = None,
    validated_direction_ids: Mapping[int, int] | None = None,
) -> int | None:
    """Normalise a trip to the PCB's direction slots.

    Public headsign/terminus information is authoritative.  Route order is used
    for short-turn trips.  ``direction_id`` is accepted only through a mapping
    that was independently validated against authoritative trips in this GTFS.
    """

    if route not in PCB_ROUTE_ORDERS:
        return None

    canonical_headsign = canonical_station(route, headsign)
    direction_zero, direction_one = ROUTE_TERMINI[route]
    if canonical_headsign == direction_zero:
        return 0
    if canonical_headsign == direction_one:
        return 1

    indices = [
        index
        for station in station_sequence
        if (index := route_station_index(route, station)) is not None
    ]
    if len(indices) >= 2 and indices[0] != indices[-1]:
        moving_to_high_index = indices[-1] > indices[0]
        zero_index = route_station_index(route, direction_zero)
        one_index = route_station_index(route, direction_one)
        if zero_index is not None and one_index is not None:
            direction_at_high_index = 0 if zero_index > one_index else 1
            return (
                direction_at_high_index
                if moving_to_high_index
                else 1 - direction_at_high_index
            )

    if raw_direction_id in (0, 1) and validated_direction_ids:
        checked = validated_direction_ids.get(raw_direction_id)
        if checked in (0, 1):
            return checked
    return None


def _validated_direction_maps(
    drafts: Iterable[_TripDraft],
    station_sequences: Mapping[str, tuple[str, ...]],
) -> dict[str, dict[int, int]]:
    votes: dict[str, dict[int, Counter[int]]] = defaultdict(
        lambda: defaultdict(Counter)
    )
    for draft in drafts:
        if draft.raw_direction_id not in (0, 1):
            continue
        resolved = normalise_trip_direction(
            draft.route,
            headsign=draft.headsign,
            station_sequence=station_sequences.get(draft.trip_id, ()),
        )
        if resolved in (0, 1):
            votes[draft.route][draft.raw_direction_id][resolved] += 1

    validated: dict[str, dict[int, int]] = {}
    for route, raw_votes in votes.items():
        route_map: dict[int, int] = {}
        for raw_direction, counts in raw_votes.items():
            if len(counts) != 1:
                continue
            direction, count = counts.most_common(1)[0]
            if count > 0:
                route_map[raw_direction] = direction
        if route_map:
            validated[route] = route_map
    return validated


def load_static_gtfs(
    source: str | os.PathLike[str] = OFFICIAL_COMPLETE_GTFS_URL,
    *,
    token: str | None = None,
    session: requests.Session | None = None,
    timeout_seconds: float = 60.0,
    now: float | None = None,
    expected_routes: Iterable[str] = SUPPORTED_ROUTES,
    namespace: str | None = None,
) -> StaticGTFS:
    """Load and filter a local directory, local ZIP, or remote GTFS ZIP."""

    wanted_routes = frozenset(str(route).upper() for route in expected_routes)
    if not wanted_routes or not wanted_routes <= SUPPORTED_ROUTES:
        raise StaticGTFSLoadError("Static GTFS expected_routes is invalid")

    bundle = _open_bundle(
        source,
        token=token,
        session=session,
        timeout_seconds=timeout_seconds,
    )
    try:
        routes_by_id: dict[str, str] = {}
        for row in _rows(bundle, "routes.txt"):
            route = row.get("route_short_name", "").upper()
            if route not in wanted_routes:
                continue
            # TfNSW's complete feed currently uses the extended TPEG light-
            # rail route type 900.  Standard GTFS publishers may use 0, so
            # accept both without admitting any other transport modes.
            if _as_int(row.get("route_type")) not in (0, 900):
                continue
            route_id = row.get("route_id", "")
            if route_id:
                routes_by_id[route_id] = route
        if set(routes_by_id.values()) != set(wanted_routes):
            missing = sorted(set(wanted_routes) - set(routes_by_id.values()))
            raise StaticGTFSLoadError(
                "Static GTFS is missing TramTrace route(s): " + ", ".join(missing)
            )

        drafts: dict[str, _TripDraft] = {}
        for row in _rows(bundle, "trips.txt"):
            route_id = row.get("route_id", "")
            route = routes_by_id.get(route_id)
            trip_id = row.get("trip_id", "")
            if not route or not trip_id:
                continue
            drafts[trip_id] = _TripDraft(
                trip_id=trip_id,
                route_id=route_id,
                route=route,
                headsign=row.get("trip_headsign", ""),
                raw_direction_id=_as_int(row.get("direction_id")),
                stop_times=[],
            )
        if not drafts:
            raise StaticGTFSLoadError("Static GTFS contains no L1-L4 trips")

        referenced_stop_ids: set[str] = set()
        for row in _rows(bundle, "stop_times.txt"):
            draft = drafts.get(row.get("trip_id", ""))
            if draft is None:
                continue
            stop_id = row.get("stop_id", "")
            sequence = _as_int(row.get("stop_sequence"))
            if not stop_id or sequence is None:
                continue
            draft.stop_times.append((sequence, stop_id))
            referenced_stop_ids.add(stop_id)

        all_stops: dict[str, StopPoint] = {}
        for row in _rows(bundle, "stops.txt"):
            stop_id = row.get("stop_id", "")
            if not stop_id:
                continue
            all_stops[stop_id] = StopPoint(
                stop_id=stop_id,
                name=row.get("stop_name", ""),
                latitude=_as_float(row.get("stop_lat")),
                longitude=_as_float(row.get("stop_lon")),
                parent_station=row.get("parent_station") or None,
            )

        kept_stop_ids = set(referenced_stop_ids)
        for stop_id in tuple(referenced_stop_ids):
            stop = all_stops.get(stop_id)
            if stop and stop.parent_station:
                kept_stop_ids.add(stop.parent_station)
        stop_to_station: dict[tuple[str, str], str] = {}
        sequence_by_trip: dict[str, dict[int, str]] = {}
        stations_by_trip: dict[str, tuple[str, ...]] = {}
        position_samples: dict[
            tuple[str, str], dict[str, tuple[float, float]]
        ] = defaultdict(dict)

        for draft in drafts.values():
            by_sequence: dict[int, str] = {}
            ordered_stations: list[str] = []
            for sequence, stop_id in sorted(draft.stop_times):
                stop = all_stops.get(stop_id)
                parent = (
                    all_stops.get(stop.parent_station)
                    if stop and stop.parent_station
                    else None
                )
                station = canonical_station(draft.route, stop.name if stop else None)
                if station is None and parent is not None:
                    station = canonical_station(draft.route, parent.name)
                if station is None:
                    continue

                by_sequence[sequence] = station
                ordered_stations.append(station)
                stop_to_station[(draft.route, stop_id)] = station
                if stop and stop.parent_station:
                    stop_to_station[(draft.route, stop.parent_station)] = station

                coordinate = stop
                if (
                    coordinate is None
                    or coordinate.latitude is None
                    or coordinate.longitude is None
                ):
                    coordinate = parent
                if (
                    coordinate
                    and coordinate.latitude is not None
                    and coordinate.longitude is not None
                ):
                    position_samples[(draft.route, station)][coordinate.stop_id] = (
                        coordinate.latitude,
                        coordinate.longitude,
                    )

            sequence_by_trip[draft.trip_id] = by_sequence
            stations_by_trip[draft.trip_id] = _collapsed(ordered_stations)

        # Keep official stop aliases and coordinates even when a station is not
        # present in the currently published trip patterns.  This matters for
        # temporarily closed stations such as L1 Convention: it remains on the
        # physical board and in stops.txt even while stop_times.txt omits it.
        # Canonicalisation is route-aware, so applying each feed's expected
        # routes also handles the shared L2/L3 trunk without cross-route leaks.
        for route in wanted_routes:
            for stop_id, stop in all_stops.items():
                parent = (
                    all_stops.get(stop.parent_station)
                    if stop.parent_station
                    else None
                )
                station = canonical_station(route, stop.name)
                if station is None and parent is not None:
                    station = canonical_station(route, parent.name)
                if station is None:
                    continue

                kept_stop_ids.add(stop_id)
                stop_to_station.setdefault((route, stop_id), station)
                if stop.parent_station:
                    kept_stop_ids.add(stop.parent_station)
                    stop_to_station.setdefault(
                        (route, stop.parent_station), station
                    )

                coordinate = stop
                if coordinate.latitude is None or coordinate.longitude is None:
                    coordinate = parent
                if (
                    coordinate is not None
                    and coordinate.latitude is not None
                    and coordinate.longitude is not None
                ):
                    position_samples[(route, station)].setdefault(
                        coordinate.stop_id,
                        (coordinate.latitude, coordinate.longitude),
                    )

        stops = {
            stop_id: stop
            for stop_id, stop in all_stops.items()
            if stop_id in kept_stop_ids
        }

        validated = _validated_direction_maps(drafts.values(), stations_by_trip)
        trips: dict[str, TripPattern] = {}
        for draft in drafts.values():
            stations_for_trip = stations_by_trip.get(draft.trip_id, ())
            direction = normalise_trip_direction(
                draft.route,
                headsign=draft.headsign,
                station_sequence=stations_for_trip,
                raw_direction_id=draft.raw_direction_id,
                validated_direction_ids=validated.get(draft.route),
            )
            trips[draft.trip_id] = TripPattern(
                trip_id=draft.trip_id,
                route_id=draft.route_id,
                route=draft.route,
                headsign=draft.headsign,
                raw_direction_id=draft.raw_direction_id,
                direction=direction,
                stations=stations_for_trip,
                station_by_sequence=sequence_by_trip.get(draft.trip_id, {}),
                stop_ids=frozenset(stop_id for _, stop_id in draft.stop_times),
            )

        station_positions: dict[str, dict[str, tuple[float, float]]] = {
            route: {} for route in PCB_ROUTE_ORDERS
        }
        for (route, station), samples in position_samples.items():
            if not samples:
                continue
            coordinates = tuple(samples.values())
            station_positions[route][station] = (
                sum(point[0] for point in coordinates) / len(coordinates),
                sum(point[1] for point in coordinates) / len(coordinates),
            )

        return StaticGTFS(
            source=os.fspath(source),
            loaded_at=time.time() if now is None else now,
            routes_by_id=routes_by_id,
            trips=trips,
            stops=stops,
            stop_to_station=stop_to_station,
            station_positions=station_positions,
            validated_direction_ids=validated,
            routes_by_source=(
                {(namespace, route_id): route for route_id, route in routes_by_id.items()}
                if namespace
                else {}
            ),
            trips_by_source=(
                {(namespace, trip_id): trip for trip_id, trip in trips.items()}
                if namespace
                else {}
            ),
            stops_by_source=(
                {
                    (namespace, route, stop_id): station
                    for (route, stop_id), station in stop_to_station.items()
                }
                if namespace
                else {}
            ),
            direction_ids_by_source=(
                {
                    (namespace, route, raw): direction
                    for route, route_map in validated.items()
                    for raw, direction in route_map.items()
                }
                if namespace
                else {}
            ),
        )
    except StaticGTFSLoadError:
        raise
    except (csv.Error, UnicodeError, OSError, KeyError) as exc:
        raise StaticGTFSLoadError(f"Unable to parse static GTFS: {exc}") from exc
    finally:
        bundle.close()


def merge_static_gtfs(
    base: StaticGTFS | None,
    overlays: Iterable[StaticGTFS],
    *,
    now: float | None = None,
) -> StaticGTFS:
    """Merge operator schedules over an optional complete/offline base.

    Operator route/trip/stop indexes win so they align with realtime IDs.
    Existing base coordinates win; operator coordinates only fill stations
    absent from the base.
    """

    overlay_list = tuple(overlays)
    layers = ((base,) if base is not None else ()) + overlay_list
    if not layers:
        raise StaticGTFSLoadError("No static GTFS data is available to merge")

    routes_by_id: dict[str, str] = {}
    trips: dict[str, TripPattern] = {}
    stops: dict[str, StopPoint] = {}
    stop_to_station: dict[tuple[str, str], str] = {}
    validated: dict[str, dict[int, int]] = {}
    routes_by_source: dict[tuple[str, str], str] = {}
    trips_by_source: dict[tuple[str, str], TripPattern] = {}
    stops_by_source: dict[tuple[str, str, str], str] = {}
    direction_ids_by_source: dict[tuple[str, str, int], int] = {}
    station_positions: dict[str, dict[str, tuple[float, float]]] = {
        route: {} for route in PCB_ROUTE_ORDERS
    }

    for layer_index, layer in enumerate(layers):
        routes_by_id.update(layer.routes_by_id)
        trips.update(layer.trips)
        stops.update(layer.stops)
        stop_to_station.update(layer.stop_to_station)
        for route, route_map in layer.validated_direction_ids.items():
            validated.setdefault(route, {}).update(route_map)
        routes_by_source.update(layer.routes_by_source)
        trips_by_source.update(layer.trips_by_source)
        stops_by_source.update(layer.stops_by_source)
        direction_ids_by_source.update(layer.direction_ids_by_source)
        for route, route_positions in layer.station_positions.items():
            for station, position in route_positions.items():
                if layer_index == 0 and base is not None:
                    station_positions.setdefault(route, {})[station] = position
                else:
                    station_positions.setdefault(route, {}).setdefault(
                        station, position
                    )

    return StaticGTFS(
        source=" + ".join(layer.source for layer in layers),
        loaded_at=time.time() if now is None else now,
        routes_by_id=routes_by_id,
        trips=trips,
        stops=stops,
        stop_to_station=stop_to_station,
        station_positions=station_positions,
        validated_direction_ids=validated,
        routes_by_source=routes_by_source,
        trips_by_source=trips_by_source,
        stops_by_source=stops_by_source,
        direction_ids_by_source=direction_ids_by_source,
    )
