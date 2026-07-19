from __future__ import annotations

import csv
import io
import time
import zipfile
from pathlib import Path

import pytest
from google.transit import gtfs_realtime_pb2

from server.gtfs import StaticGTFS, load_static_gtfs
from server.realtime import FeedPart, FeedSpec
from server.schedule import ScheduleSpec


def _csv_text(fieldnames: list[str], rows: list[dict[str, object]]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


@pytest.fixture()
def static_zip(tmp_path: Path) -> Path:
    routes = [
        {
            "route_id": f"route-{route}",
            "route_short_name": route,
            # Standard GTFS permits 0; TfNSW's full feed currently uses 900.
            "route_type": 0 if route == "L4" else 900,
        }
        for route in ("L1", "L2", "L3", "L4")
    ]
    routes.append(
        {"route_id": "not-light-rail", "route_short_name": "999", "route_type": 700}
    )

    stops = [
        # L1 includes the official/legacy aliases that differ from PCB text.
        ("l1-dulwich", "Dulwich Hill Light Rail", -33.910, 151.140),
        ("l1-bank", "Fish Market Light Rail", -33.870, 151.193),
        (
            "l1-convention",
            "Convention Centre Light Rail",
            -33.8726,
            151.1981,
        ),
        ("l1-central", "Central Grand Concourse Light Rail", -33.883, 151.207),
        # L2/L3 deliberately share IDs along their common trunk.
        ("shared-cq", "Circular Quay", -33.861, 151.210),
        ("shared-town", "Town Hall Light Rail", -33.873, 151.207),
        ("shared-central", "Central Chalmers Street Light Rail", -33.884, 151.210),
        ("shared-moore", "Moore Park Light Rail", -33.893, 151.221),
        ("l2-randwick", "Randwick Light Rail", -33.914, 151.242),
        ("l3-es", "E.S. Marks Light Rail", -33.910, 151.224),
        ("l3-juniors", "Juniors Kingsford Light Rail", -33.930, 151.230),
        # L4 aliases include the apostrophe omitted by the silkscreen.
        ("l4-carlingford", "Carlingford Light Rail", -33.783, 151.045),
        ("l4-childrens", "Children's Hospital Light Rail", -33.801, 150.991),
        ("l4-westmead", "Westmead Light Rail", -33.807, 150.989),
    ]
    stop_rows = [
        {
            "stop_id": stop_id,
            "stop_name": name,
            "stop_lat": lat,
            "stop_lon": lon,
            "location_type": 0,
            "parent_station": "",
        }
        for stop_id, name, lat, lon in stops
    ]

    trips = [
        ("l1-0", "L1", "Dulwich Hill", 0),
        ("l1-1", "L1", "Central Station", 1),
        ("l2-0", "L2", "Randwick", 0),
        ("l2-1", "L2", "Circular Quay", 1),
        ("l2-short", "L2", "Town Hall", 1),
        ("l3-0", "L3", "Juniors Kingsford", 0),
        ("l3-1", "L3", "Circular Quay", 1),
        ("l4-0", "L4", "Westmead", 0),
        ("l4-1", "L4", "Carlingford", 1),
    ]
    trip_rows = [
        {
            "route_id": f"route-{route}",
            "service_id": "daily",
            "trip_id": trip_id,
            "trip_headsign": headsign,
            "direction_id": direction,
        }
        for trip_id, route, headsign, direction in trips
    ]

    sequences = {
        "l1-0": ("l1-central", "l1-bank", "l1-dulwich"),
        "l1-1": ("l1-dulwich", "l1-bank", "l1-central"),
        "l2-0": (
            "shared-cq",
            "shared-town",
            "shared-central",
            "shared-moore",
            "l2-randwick",
        ),
        "l2-1": (
            "l2-randwick",
            "shared-moore",
            "shared-central",
            "shared-town",
            "shared-cq",
        ),
        "l2-short": (
            "l2-randwick",
            "shared-moore",
            "shared-central",
            "shared-town",
        ),
        "l3-0": (
            "shared-cq",
            "shared-town",
            "shared-central",
            "shared-moore",
            "l3-es",
            "l3-juniors",
        ),
        "l3-1": (
            "l3-juniors",
            "l3-es",
            "shared-moore",
            "shared-central",
            "shared-town",
            "shared-cq",
        ),
        # L4's direction-0 terminus is at the *end* of the PCB chain.
        "l4-0": ("l4-carlingford", "l4-childrens", "l4-westmead"),
        "l4-1": ("l4-westmead", "l4-childrens", "l4-carlingford"),
    }
    stop_time_rows: list[dict[str, object]] = []
    for trip_id, stop_ids in sequences.items():
        for sequence, stop_id in enumerate(stop_ids, start=1):
            stop_time_rows.append(
                {
                    "trip_id": trip_id,
                    "arrival_time": "12:00:00",
                    "departure_time": "12:00:00",
                    "stop_id": stop_id,
                    "stop_sequence": sequence,
                }
            )

    path = tmp_path / "synthetic-gtfs.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "routes.txt",
            _csv_text(
                ["route_id", "route_short_name", "route_type"],
                routes,
            ),
        )
        archive.writestr(
            "trips.txt",
            _csv_text(
                [
                    "route_id",
                    "service_id",
                    "trip_id",
                    "trip_headsign",
                    "direction_id",
                ],
                trip_rows,
            ),
        )
        archive.writestr(
            "stop_times.txt",
            _csv_text(
                [
                    "trip_id",
                    "arrival_time",
                    "departure_time",
                    "stop_id",
                    "stop_sequence",
                ],
                stop_time_rows,
            ),
        )
        archive.writestr(
            "stops.txt",
            _csv_text(
                [
                    "stop_id",
                    "stop_name",
                    "stop_lat",
                    "stop_lon",
                    "location_type",
                    "parent_station",
                ],
                stop_rows,
            ),
        )
    return path


@pytest.fixture()
def static_gtfs(static_zip: Path) -> StaticGTFS:
    return load_static_gtfs(static_zip, now=time.time())


def make_feed_part(
    *,
    name: str,
    routes: set[str],
    header_timestamp: int,
    vehicles: list[dict[str, object]],
) -> FeedPart:
    message = gtfs_realtime_pb2.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = header_timestamp
    for index, values in enumerate(vehicles):
        entity = message.entity.add()
        entity.id = str(index)
        vehicle = entity.vehicle
        if trip_id := values.get("trip_id"):
            vehicle.trip.trip_id = str(trip_id)
        if route_id := values.get("route_id"):
            vehicle.trip.route_id = str(route_id)
        if "direction_id" in values:
            vehicle.trip.direction_id = int(values["direction_id"])
        if stop_id := values.get("stop_id"):
            vehicle.stop_id = str(stop_id)
        if "current_stop_sequence" in values:
            vehicle.current_stop_sequence = int(values["current_stop_sequence"])
        if "current_status" in values:
            vehicle.current_status = int(values["current_status"])
        if "latitude" in values and "longitude" in values:
            vehicle.position.latitude = float(values["latitude"])
            vehicle.position.longitude = float(values["longitude"])
        if "timestamp" in values:
            vehicle.timestamp = int(values["timestamp"])
    return FeedPart(
        spec=FeedSpec(
            name=name,
            url=f"https://example.invalid/{name}",
            routes=frozenset(routes),
        ),
        message=message,
        received_at=float(header_timestamp),
        header_timestamp=float(header_timestamp),
    )


@pytest.fixture()
def feed_part_factory():
    return make_feed_part


def _write_schedule_zip(
    path: Path,
    *,
    routes: list[tuple[str, str]],
    trips: list[tuple[str, str, str, int]],
    sequences: dict[str, tuple[str, ...]],
    stops: list[tuple[str, str, float, float]],
) -> None:
    route_rows = [
        {"route_id": route_id, "route_short_name": short, "route_type": 0}
        for route_id, short in routes
    ]
    trip_rows = [
        {
            "route_id": route_id,
            "service_id": "daily",
            "trip_id": trip_id,
            "trip_headsign": headsign,
            "direction_id": direction,
        }
        for trip_id, route_id, headsign, direction in trips
    ]
    stop_time_rows = [
        {
            "trip_id": trip_id,
            "arrival_time": "12:00:00",
            "departure_time": "12:00:00",
            "stop_id": stop_id,
            "stop_sequence": sequence,
        }
        for trip_id, stop_ids in sequences.items()
        for sequence, stop_id in enumerate(stop_ids, start=1)
    ]
    stop_rows = [
        {
            "stop_id": stop_id,
            "stop_name": name,
            "stop_lat": latitude,
            "stop_lon": longitude,
            "location_type": 0,
            "parent_station": "",
        }
        for stop_id, name, latitude, longitude in stops
    ]
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "routes.txt",
            _csv_text(["route_id", "route_short_name", "route_type"], route_rows),
        )
        archive.writestr(
            "trips.txt",
            _csv_text(
                [
                    "route_id",
                    "service_id",
                    "trip_id",
                    "trip_headsign",
                    "direction_id",
                ],
                trip_rows,
            ),
        )
        archive.writestr(
            "stop_times.txt",
            _csv_text(
                [
                    "trip_id",
                    "arrival_time",
                    "departure_time",
                    "stop_id",
                    "stop_sequence",
                ],
                stop_time_rows,
            ),
        )
        archive.writestr(
            "stops.txt",
            _csv_text(
                [
                    "stop_id",
                    "stop_name",
                    "stop_lat",
                    "stop_lon",
                    "location_type",
                    "parent_station",
                ],
                stop_rows,
            ),
        )


@pytest.fixture()
def operator_schedule_specs(tmp_path: Path) -> tuple[ScheduleSpec, ...]:
    innerwest = tmp_path / "innerwest.zip"
    _write_schedule_zip(
        innerwest,
        routes=[("IWLR-191", "L1")],
        trips=[
            ("iwlr-to-dulwich", "IWLR-191", "Dulwich Hill", 0),
            ("iwlr-to-central", "IWLR-191", "Central Station", 1),
        ],
        sequences={
            "iwlr-to-dulwich": ("op-l1-central", "op-l1-bank", "op-l1-dulwich"),
            "iwlr-to-central": ("op-l1-dulwich", "op-l1-bank", "op-l1-central"),
        },
        stops=[
            ("op-l1-dulwich", "Dulwich Hill Light Rail", 0.0, 0.0),
            ("op-l1-bank", "Bank Street Light Rail", 0.0, 0.0),
            ("op-l1-central", "Central Grand Concourse", 0.0, 0.0),
        ],
    )

    cbd = tmp_path / "cbdandsoutheast.zip"
    _write_schedule_zip(
        cbd,
        routes=[("CSELR_L2", "L2"), ("CSELR_L3", "L3")],
        trips=[
            ("33945-10467:348996:351777", "CSELR_L2", "Randwick", 0),
            ("cselr-l2-to-cq", "CSELR_L2", "Circular Quay", 1),
            ("cselr-l3-to-juniors", "CSELR_L3", "Juniors Kingsford", 0),
            ("33945-10830:345995:349462", "CSELR_L3", "Circular Quay", 1),
        ],
        sequences={
            "33945-10467:348996:351777": (
                "op-shared-cq",
                "op-shared-central",
                "op-l2-randwick",
            ),
            "cselr-l2-to-cq": (
                "op-l2-randwick",
                "op-shared-central",
                "op-shared-cq",
            ),
            "cselr-l3-to-juniors": (
                "op-shared-cq",
                "op-shared-central",
                "op-l3-juniors",
            ),
            "33945-10830:345995:349462": (
                "op-l3-juniors",
                "op-shared-central",
                "op-shared-cq",
            ),
        },
        stops=[
            ("op-shared-cq", "Circular Quay", 0.0, 0.0),
            ("op-shared-central", "Central Chalmers Street", 0.0, 0.0),
            ("op-l2-randwick", "Randwick Light Rail", 0.0, 0.0),
            ("op-l3-juniors", "Juniors Kingsford Light Rail", 0.0, 0.0),
        ],
    )

    parramatta = tmp_path / "parramatta.zip"
    _write_schedule_zip(
        parramatta,
        routes=[("ISD-17-6720_L4", "L4")],
        trips=[
            ("isd-l4-to-westmead", "ISD-17-6720_L4", "Westmead", 0),
            ("41154-10157:1001", "ISD-17-6720_L4", "Carlingford", 1),
        ],
        sequences={
            "isd-l4-to-westmead": (
                "op-l4-carlingford",
                "op-l4-childrens",
                "op-l4-westmead",
            ),
            "41154-10157:1001": (
                "op-l4-westmead",
                "op-l4-childrens",
                "op-l4-carlingford",
            ),
        },
        stops=[
            ("op-l4-carlingford", "Carlingford Light Rail", 0.0, 0.0),
            ("op-l4-childrens", "Childrens Hospital Light Rail", 0.0, 0.0),
            ("op-l4-westmead", "Westmead Light Rail", 0.0, 0.0),
        ],
    )
    return (
        ScheduleSpec("innerwest", str(innerwest), frozenset({"L1"})),
        ScheduleSpec(
            "cbdandsoutheast", str(cbd), frozenset({"L2", "L3"})
        ),
        ScheduleSpec("parramatta", str(parramatta), frozenset({"L4"})),
    )
