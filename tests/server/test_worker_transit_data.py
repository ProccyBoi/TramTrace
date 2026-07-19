from __future__ import annotations

from dataclasses import replace

import pytest

from scripts.generate_worker_transit_data import build_worker_transit_data
from server.errors import StaticGTFSLoadError
from server.gtfs import StaticGTFS, load_static_gtfs
from server.mapping import PCB_ROUTE_ORDERS
from server.schedule import ScheduleSpec


def _complete_positions(
    static: StaticGTFS,
    routes: frozenset[str],
) -> StaticGTFS:
    positions = {
        route: {
            station: (-33.8 - index / 10_000, 151.0 + index / 10_000)
            for index, station in enumerate(PCB_ROUTE_ORDERS[route])
        }
        for route in routes
    }
    return replace(static, station_positions=positions)


def test_worker_artifact_is_route_aware_compact_and_complete(
    operator_schedule_specs: tuple[ScheduleSpec, ...],
) -> None:
    statics = {
        spec.name: _complete_positions(
            load_static_gtfs(
                spec.source,
                expected_routes=spec.routes,
                namespace=spec.name,
            ),
            spec.routes,
        )
        for spec in operator_schedule_specs
    }

    artifact = build_worker_transit_data(
        statics,
        schedules=operator_schedule_specs,
        generated_at="2026-07-19T00:00:00Z",
    )

    assert artifact["schemaVersion"] == 1
    assert artifact["generatedAt"] == "2026-07-19T00:00:00Z"
    assert list(artifact["routes"]) == ["L1", "L2", "L3", "L4"]
    assert sum(
        len(route["stations"]) for route in artifact["routes"].values()
    ) == 68
    assert artifact["routes"]["L4"]["termini"] == [
        "Westmead",
        "Carlingford",
    ]
    assert artifact["routes"]["L4"]["stations"][0][0] == "Carlingford"

    cbd = artifact["sources"]["cbdandsoutheast"]
    assert cbd["routeIds"]["CSELR_L2"] == "L2"
    assert cbd["routeIds"]["CSELR_L3"] == "L3"
    assert cbd["stops"]["L2"]["op-shared-central"] == 6
    assert cbd["stops"]["L3"]["op-shared-central"] == 7
    assert cbd["trips"]["33945-10467:348996:351777"][:2] == ["L2", 0]
    assert cbd["trips"]["33945-10830:345995:349462"][:2] == ["L3", 1]
    assert len(cbd["patterns"]["L2"]) == 2
    assert len(cbd["patterns"]["L3"]) == 2


def test_worker_artifact_rejects_incomplete_station_positions(
    operator_schedule_specs: tuple[ScheduleSpec, ...],
) -> None:
    statics = {
        spec.name: load_static_gtfs(
            spec.source,
            expected_routes=spec.routes,
            namespace=spec.name,
        )
        for spec in operator_schedule_specs
    }

    with pytest.raises(
        StaticGTFSLoadError,
        match="missing PCB station coordinates",
    ):
        build_worker_transit_data(
            statics,
            schedules=operator_schedule_specs,
            generated_at="2026-07-19T00:00:00Z",
        )
