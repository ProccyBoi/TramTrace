from __future__ import annotations

from server.errors import StaticGTFSLoadError
from server.gtfs import StaticGTFS, merge_static_gtfs
from server.realtime import FeedSnapshot
from server.schedule import ScheduleSpec, TfNSWScheduleClient
from server.service import Settings, TramTraceService
from server.state import STOPPED_AT, observations_from_snapshot


def _load_operator_static(
    specs: tuple[ScheduleSpec, ...],
    *,
    now: float = 1_000,
):
    client = TfNSWScheduleClient(
        token=None,
        schedules=specs,
        refresh_seconds=60,
    )
    snapshot = client.snapshot(now=now, force=True)
    return client, snapshot


def test_operator_schedules_merge_exact_official_route_ids_and_keep_base_positions(
    static_gtfs: StaticGTFS,
    operator_schedule_specs: tuple[ScheduleSpec, ...],
) -> None:
    _, snapshot = _load_operator_static(operator_schedule_specs)
    merged = merge_static_gtfs(
        static_gtfs,
        (part.static for part in snapshot.parts),
        now=1_000,
    )

    assert (
        merged.route_for_id("CSELR_L2", "cbdandsoutheast")
        == "L2"
    )
    assert (
        merged.route_for_id("CSELR_L3", "cbdandsoutheast")
        == "L3"
    )
    assert (
        merged.route_for_id("ISD-17-6720_L4", "parramatta")
        == "L4"
    )
    assert (
        merged.trip_for("cbdandsoutheast", "33945-10467:348996:351777").direction
        == 0
    )
    assert (
        merged.trip_for("cbdandsoutheast", "33945-10830:345995:349462").direction
        == 1
    )
    assert merged.trip_for("parramatta", "41154-10157:1001").direction == 1
    assert (
        merged.station_for_stop(
            "L4", "op-l4-childrens", "parramatta"
        )
        == "Childrens Hospital"
    )
    # Operator fixtures deliberately use (0, 0); an explicit complete/offline
    # base remains authoritative for display coordinates.
    assert (
        merged.station_positions["L2"]["Central"]
        == static_gtfs.station_positions["L2"]["Central"]
    )


def test_operator_trip_pattern_supplies_route_and_direction_when_live_omits_both(
    static_gtfs: StaticGTFS,
    operator_schedule_specs: tuple[ScheduleSpec, ...],
    feed_part_factory,
) -> None:
    _, schedules = _load_operator_static(operator_schedule_specs)
    merged = merge_static_gtfs(
        static_gtfs,
        (part.static for part in schedules.parts),
        now=2_000,
    )
    cbd = feed_part_factory(
        name="cbdandsoutheast",
        routes={"L2", "L3"},
        header_timestamp=2_000,
        vehicles=[
            {
                "trip_id": "33945-10830:345995:349462",
                # route_id and direction_id intentionally omitted.
                "stop_id": "op-shared-central",
                "current_status": STOPPED_AT,
                "timestamp": 2_000,
            }
        ],
    )
    parramatta = feed_part_factory(
        name="parramatta",
        routes={"L4"},
        header_timestamp=2_000,
        vehicles=[
            {
                "trip_id": "41154-10157:1001",
                # route_id and direction_id intentionally omitted.
                "stop_id": "op-l4-childrens",
                "current_status": STOPPED_AT,
                "timestamp": 2_000,
            }
        ],
    )
    observations = list(
        observations_from_snapshot(
            FeedSnapshot(
                parts=(cbd, parramatta),
                attempted_at=2_000,
                errors={},
            ),
            merged,
            now=2_000,
            max_feed_age_seconds=120,
            future_tolerance_seconds=30,
        )
    )
    assert [(item.route, item.direction) for item in observations] == [
        ("L3", 1),
        ("L4", 1),
    ]


def test_exact_operator_route_id_resolves_unknown_trip(
    static_gtfs: StaticGTFS,
    operator_schedule_specs: tuple[ScheduleSpec, ...],
    feed_part_factory,
) -> None:
    _, schedules = _load_operator_static(operator_schedule_specs)
    merged = merge_static_gtfs(
        static_gtfs,
        (part.static for part in schedules.parts),
        now=3_000,
    )
    part = feed_part_factory(
        name="cbdandsoutheast",
        routes={"L2", "L3"},
        header_timestamp=3_000,
        vehicles=[
            {
                "trip_id": "unpublished-extra-trip",
                "route_id": "CSELR_L2",
                "direction_id": 0,
                "stop_id": "op-l2-randwick",
                "current_status": STOPPED_AT,
                "timestamp": 3_000,
            }
        ],
    )
    observations = list(
        observations_from_snapshot(
            FeedSnapshot(parts=(part,), attempted_at=3_000, errors={}),
            merged,
            now=3_000,
            max_feed_age_seconds=120,
            future_tolerance_seconds=30,
        )
    )
    assert [(item.route, item.direction) for item in observations] == [("L2", 0)]


def test_schedule_refresh_failure_retains_last_good(
    operator_schedule_specs: tuple[ScheduleSpec, ...],
    monkeypatch,
) -> None:
    spec = operator_schedule_specs[0]
    client, first = _load_operator_static((spec,), now=4_000)

    def fail_load(*args, **kwargs):
        raise StaticGTFSLoadError("temporary failure")

    monkeypatch.setattr("server.schedule.load_static_gtfs", fail_load)
    second = client.snapshot(now=4_061, force=True)

    assert second.parts[0].static is first.parts[0].static
    assert second.health(4_061)["innerwest"]["available"] is True
    assert second.health(4_061)["innerwest"]["error"] == "StaticGTFSLoadError"


def test_default_service_builds_static_only_from_operator_schedules(
    operator_schedule_specs: tuple[ScheduleSpec, ...],
) -> None:
    service = TramTraceService(
        Settings(
            api_token="test-token",
            gtfs_source=None,
            schedules=operator_schedule_specs,
            schedule_refresh_seconds=60,
        )
    )
    static = service.static_gtfs(now=5_000)

    assert static.route_for_id("CSELR_L2", "cbdandsoutheast") == "L2"
    assert static.route_for_id("ISD-17-6720_L4", "parramatta") == "L4"
    assert len(service.schedule_client.cached_snapshot().parts) == 3
