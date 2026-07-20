from __future__ import annotations

import pytest

from server.gtfs import StaticGTFS
from server.realtime import FeedSnapshot
from server.service import Settings
from server.state import (
    DEFAULT_APPROACHING_METRES,
    DEFAULT_AT_STATION_METRES,
    DEFAULT_FAR_METRES,
    INCOMING_AT,
    STOPPED_AT,
    DirectionalStateEngine,
    StateThresholds,
    VehicleObservation,
    observations_from_snapshot,
)


def test_live_distance_defaults_are_consistent(monkeypatch) -> None:
    for name in (
        "TRAMTRACE_AT_STATION_METRES",
        "TRAMTRACE_APPROACHING_METRES",
        "TRAMTRACE_FAR_METRES",
    ):
        monkeypatch.delenv(name, raising=False)

    thresholds = StateThresholds()
    settings = Settings.from_env()
    expected = (
        DEFAULT_AT_STATION_METRES,
        DEFAULT_APPROACHING_METRES,
        DEFAULT_FAR_METRES,
    )

    assert expected == (120.0, 450.0, 800.0)
    assert (
        thresholds.at_station_metres,
        thresholds.approaching_metres,
        thresholds.far_metres,
    ) == expected
    assert (
        settings.at_station_metres,
        settings.approaching_metres,
        settings.far_metres,
    ) == expected


def test_shared_l2_l3_trunk_stays_separate(
    static_gtfs: StaticGTFS, feed_part_factory
) -> None:
    now = 10_000
    part = feed_part_factory(
        name="cbdandsoutheast",
        routes={"L2", "L3"},
        header_timestamp=now,
        vehicles=[
            {
                "trip_id": "l2-0",
                "route_id": "route-L2",
                "stop_id": "shared-central",
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
            {
                "trip_id": "l3-1",
                "route_id": "route-L3",
                "stop_id": "shared-central",
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
        ],
    )
    snapshot = FeedSnapshot(parts=(part,), attempted_at=now, errors={})
    observations = observations_from_snapshot(
        snapshot,
        static_gtfs,
        now=now,
        max_feed_age_seconds=120,
        future_tolerance_seconds=30,
    )
    result = DirectionalStateEngine(static_gtfs).calculate(observations, now=now)

    assert result.states["L2"]["Central"] == [3, 0]
    assert result.states["L3"]["Central"] == [0, 3]
    assert result.accepted_vehicles == 2


def test_feed_source_and_branch_stop_resolve_operator_route_ids(
    static_gtfs: StaticGTFS, feed_part_factory
) -> None:
    now = 20_000
    innerwest = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=now,
        vehicles=[
            {
                "trip_id": "operator-trip-not-in-static",
                "route_id": "IWLR-191",
                "direction_id": 0,
                "stop_id": "l1-bank",
                "current_status": STOPPED_AT,
                "timestamp": now,
            }
        ],
    )
    cbd = feed_part_factory(
        name="cbdandsoutheast",
        routes={"L2", "L3"},
        header_timestamp=now,
        vehicles=[
            {
                "trip_id": "unknown-branch-trip",
                "route_id": "operator-route-without-line-token",
                "direction_id": 0,
                "stop_id": "l2-randwick",
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
            {
                "trip_id": "unknown-shared-trip",
                "route_id": "operator-route-without-line-token",
                "direction_id": 0,
                "stop_id": "shared-central",
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
        ],
    )
    snapshot = FeedSnapshot(
        parts=(innerwest, cbd),
        attempted_at=now,
        errors={},
    )
    observations = list(
        observations_from_snapshot(
            snapshot,
            static_gtfs,
            now=now,
            max_feed_age_seconds=120,
            future_tolerance_seconds=30,
        )
    )

    assert [(item.route, item.direction) for item in observations] == [
        ("L1", 0),
        ("L2", 0),
    ]


def test_validated_realtime_direction_precedes_static_trip_direction(
    static_gtfs: StaticGTFS, feed_part_factory
) -> None:
    now = 25_000
    part = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=now,
        vehicles=[
            {
                "trip_id": "l1-0",
                "route_id": "route-L1",
                "direction_id": 1,
                "stop_id": "l1-bank",
                "current_status": STOPPED_AT,
                "timestamp": now,
            }
        ],
    )
    observations = list(
        observations_from_snapshot(
            FeedSnapshot(parts=(part,), attempted_at=now, errors={}),
            static_gtfs,
            now=now,
            max_feed_age_seconds=120,
            future_tolerance_seconds=30,
        )
    )
    assert len(observations) == 1
    assert observations[0].direction == 1


@pytest.mark.parametrize("reverse_order", [False, True])
def test_same_vehicle_only_lights_its_newest_station(
    static_gtfs: StaticGTFS,
    feed_part_factory,
    reverse_order: bool,
) -> None:
    now = 30_000
    vehicles = [
        {
            "entity_id": "older-record",
            "vehicle_id": "tracking-beacon-118466",
            "trip_id": "l1-1",
            "route_id": "route-L1",
            "direction_id": 1,
            "stop_id": "l1-central",
            "current_stop_sequence": 3,
            "current_status": STOPPED_AT,
            "timestamp": now - 1,
        },
        {
            "entity_id": "newer-record",
            "vehicle_id": "tracking-beacon-118466",
            "trip_id": "l1-0",
            "route_id": "route-L1",
            "direction_id": 0,
            "stop_id": "l1-bank",
            "current_stop_sequence": 2,
            "current_status": STOPPED_AT,
            "timestamp": now,
        },
    ]
    if reverse_order:
        vehicles.reverse()
    part = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=now,
        vehicles=vehicles,
    )
    observations = observations_from_snapshot(
        FeedSnapshot(parts=(part,), attempted_at=now, errors={}),
        static_gtfs,
        now=now,
        max_feed_age_seconds=120,
        future_tolerance_seconds=30,
    )

    result = DirectionalStateEngine(static_gtfs).calculate(observations, now=now)

    assert result.states["L1"]["Central"] == [0, 0]
    assert result.states["L1"]["Bank Street"] == [3, 0]
    assert result.accepted_vehicles == 1


def test_trip_instance_deduplicates_when_vehicle_id_is_missing(
    static_gtfs: StaticGTFS,
    feed_part_factory,
) -> None:
    now = 31_000
    part = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=now,
        vehicles=[
            {
                "entity_id": "old-trip-record",
                "trip_id": "l1-1",
                "trip_start_date": "20260720",
                "trip_start_time": "12:00:00",
                "route_id": "route-L1",
                "direction_id": 1,
                "stop_id": "l1-dulwich",
                "current_stop_sequence": 1,
                "current_status": STOPPED_AT,
                "timestamp": now - 1,
            },
            {
                "entity_id": "new-trip-record",
                "trip_id": "l1-1",
                "trip_start_date": "20260720",
                "trip_start_time": "12:00:00",
                "route_id": "route-L1",
                "direction_id": 1,
                "stop_id": "l1-bank",
                "current_stop_sequence": 2,
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
        ],
    )
    observations = observations_from_snapshot(
        FeedSnapshot(parts=(part,), attempted_at=now, errors={}),
        static_gtfs,
        now=now,
        max_feed_age_seconds=120,
        future_tolerance_seconds=30,
    )

    result = DirectionalStateEngine(static_gtfs).calculate(observations, now=now)

    assert result.states["L1"]["Dulwich Hill"] == [0, 0]
    assert result.states["L1"]["Bank Street"] == [0, 3]
    assert result.accepted_vehicles == 1


def test_different_vehicles_remain_visible(
    static_gtfs: StaticGTFS,
    feed_part_factory,
) -> None:
    now = 32_000
    part = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=now,
        vehicles=[
            {
                "vehicle_id": "beacon-a",
                "trip_id": "l1-0",
                "route_id": "route-L1",
                "direction_id": 0,
                "stop_id": "l1-central",
                "current_stop_sequence": 1,
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
            {
                "vehicle_id": "beacon-b",
                "trip_id": "l1-1",
                "route_id": "route-L1",
                "direction_id": 1,
                "stop_id": "l1-bank",
                "current_stop_sequence": 2,
                "current_status": STOPPED_AT,
                "timestamp": now,
            },
        ],
    )
    observations = observations_from_snapshot(
        FeedSnapshot(parts=(part,), attempted_at=now, errors={}),
        static_gtfs,
        now=now,
        max_feed_age_seconds=120,
        future_tolerance_seconds=30,
    )

    result = DirectionalStateEngine(static_gtfs).calculate(observations, now=now)

    assert result.states["L1"]["Central"] == [3, 0]
    assert result.states["L1"]["Bank Street"] == [0, 3]
    assert result.accepted_vehicles == 2


def test_newest_inactive_record_suppresses_older_vehicle_ghost(
    static_gtfs: StaticGTFS,
) -> None:
    now = 33_000
    engine = DirectionalStateEngine(static_gtfs)
    result = engine.calculate(
        [
            VehicleObservation(
                route="L1",
                direction=0,
                trip_id="l1-0",
                stop_id="l1-central",
                current_stop_sequence=1,
                current_status=STOPPED_AT,
                latitude=None,
                longitude=None,
                timestamp=now - 1,
                source="innerwest",
                vehicle_id="tracking-beacon-ghost-test",
                entity_id="old-active",
            ),
            VehicleObservation(
                route="L1",
                direction=0,
                trip_id="l1-0",
                stop_id="l1-bank",
                current_stop_sequence=2,
                current_status=2,
                latitude=0.0,
                longitude=0.0,
                timestamp=now,
                source="innerwest",
                vehicle_id="tracking-beacon-ghost-test",
                entity_id="new-inactive",
            ),
        ],
        now=now,
    )

    assert result.states["L1"]["Central"] == [0, 0]
    assert result.states["L1"]["Bank Street"] == [0, 0]
    assert result.accepted_vehicles == 0


def test_stale_vehicle_and_stale_feed_are_guarded(
    static_gtfs: StaticGTFS, feed_part_factory
) -> None:
    engine = DirectionalStateEngine(
        static_gtfs,
        max_vehicle_age_seconds=60,
        max_feed_age_seconds=90,
    )
    result = engine.calculate(
        [
            VehicleObservation(
                route="L1",
                direction=0,
                trip_id="l1-0",
                stop_id="l1-bank",
                current_stop_sequence=2,
                current_status=STOPPED_AT,
                latitude=None,
                longitude=None,
                timestamp=100,
            )
        ],
        now=200,
    )
    assert result.states["L1"]["Bank Street"] == [0, 0]
    assert result.stale_vehicles == 1

    stale_part = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=100,
        vehicles=[
            {
                "trip_id": "l1-0",
                "stop_id": "l1-bank",
                "current_status": STOPPED_AT,
                "timestamp": 200,
            }
        ],
    )
    assert (
        list(
            observations_from_snapshot(
                FeedSnapshot(parts=(stale_part,), attempted_at=200, errors={}),
                static_gtfs,
                now=200,
                max_feed_age_seconds=90,
                future_tolerance_seconds=30,
            )
        )
        == []
    )


def test_short_turn_cannot_light_a_station_beyond_its_pattern(
    static_gtfs: StaticGTFS,
) -> None:
    engine = DirectionalStateEngine(static_gtfs)
    result = engine.calculate(
        [
            VehicleObservation(
                route="L2",
                direction=1,
                trip_id="l2-short",
                stop_id="shared-cq",
                current_stop_sequence=5,
                current_status=STOPPED_AT,
                latitude=None,
                longitude=None,
                timestamp=500,
            ),
            VehicleObservation(
                route="L2",
                direction=1,
                trip_id="l2-short",
                stop_id="shared-town",
                current_stop_sequence=4,
                current_status=STOPPED_AT,
                latitude=None,
                longitude=None,
                timestamp=500,
            ),
        ],
        now=500,
    )
    assert result.states["L2"]["Circular Quay"] == [0, 0]
    assert result.states["L2"]["Town Hall"] == [0, 3]


def test_alias_target_and_status_produce_led_state(static_gtfs: StaticGTFS) -> None:
    engine = DirectionalStateEngine(static_gtfs)
    result = engine.calculate(
        [
            VehicleObservation(
                route="L1",
                direction=0,
                trip_id="l1-0",
                stop_id="l1-bank",
                current_stop_sequence=2,
                current_status=INCOMING_AT,
                latitude=None,
                longitude=None,
                timestamp=700,
            )
        ],
        now=700,
    )
    assert result.states["L1"]["Bank Street"] == [2, 0]


def test_nearest_station_fallback_is_route_scoped(static_gtfs: StaticGTFS) -> None:
    engine = DirectionalStateEngine(static_gtfs)
    latitude, longitude = static_gtfs.station_positions["L3"]["ES Marks"]
    result = engine.calculate(
        [
            VehicleObservation(
                route="L3",
                direction=0,
                trip_id=None,
                stop_id=None,
                current_stop_sequence=None,
                current_status=INCOMING_AT,
                latitude=latitude,
                longitude=longitude,
                timestamp=900,
            )
        ],
        now=900,
    )
    assert result.states["L3"]["ES Marks"] == [3, 0]
    assert "ES Marks" not in result.states["L2"]
