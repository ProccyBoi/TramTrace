from __future__ import annotations

from server.gtfs import StaticGTFS, normalise_trip_direction
from server.mapping import PCB_ROUTE_ORDERS, canonical_station, normalise_station_name


def test_pcb_aliases_are_exact_and_route_aware() -> None:
    assert canonical_station("L1", "Fish Market Light Rail") == "Bank Street"
    assert canonical_station("L1", "Bank Street") == "Bank Street"
    assert canonical_station("L1", "Convention Centre Light Rail") == "Convention"
    assert canonical_station("L1", "Central Grand Concourse Light Rail") == "Central"
    assert canonical_station("L2", "Central Chalmers Street Light Rail") == "Central"
    assert canonical_station("L3", "E.S. Marks Light Rail") == "ES Marks"
    assert (
        canonical_station("L4", "Children's Hospital Light Rail")
        == "Childrens Hospital"
    )
    assert canonical_station("L4", "Childrens Hospital") == "Childrens Hospital"
    assert canonical_station("L2", "Randwick") == "Randwick"
    assert canonical_station("L1", "Randwick") is None


def test_station_suffix_normalisation_is_linear_and_repeatable() -> None:
    assert normalise_station_name("Central Light Rail Station Stop") == "central"
    assert normalise_station_name("Randwick STATION") == "randwick"


def test_static_gtfs_uses_headsign_and_route_order(static_gtfs: StaticGTFS) -> None:
    assert static_gtfs.trips["l1-0"].direction == 0
    assert static_gtfs.trips["l1-1"].direction == 1
    assert static_gtfs.trips["l2-short"].direction == 1
    assert static_gtfs.trips["l3-0"].direction == 0
    # L4 is intentionally opposite the physical PCB list order.
    assert static_gtfs.trips["l4-0"].direction == 0
    assert static_gtfs.trips["l4-1"].direction == 1
    assert static_gtfs.validated_direction_ids["L4"] == {0: 0, 1: 1}


def test_headsign_wins_and_direction_id_requires_validation() -> None:
    assert (
        normalise_trip_direction(
            "L2",
            headsign="Circular Quay",
            raw_direction_id=0,
            validated_direction_ids={0: 0},
        )
        == 1
    )
    assert (
        normalise_trip_direction(
            "L2",
            headsign="",
            station_sequence=(),
            raw_direction_id=1,
            validated_direction_ids=None,
        )
        is None
    )
    assert (
        normalise_trip_direction(
            "L2",
            headsign="",
            station_sequence=(),
            raw_direction_id=1,
            validated_direction_ids={1: 1},
        )
        == 1
    )


def test_all_routes_keep_the_full_pcb_order(static_gtfs: StaticGTFS) -> None:
    assert tuple(PCB_ROUTE_ORDERS) == ("L1", "L2", "L3", "L4")
    assert len(PCB_ROUTE_ORDERS["L1"]) == 23
    assert len(PCB_ROUTE_ORDERS["L2"]) == 14
    assert len(PCB_ROUTE_ORDERS["L3"]) == 15
    assert len(PCB_ROUTE_ORDERS["L4"]) == 16
    assert static_gtfs.station_for_stop("L1", "l1-bank") == "Bank Street"
    assert static_gtfs.station_for_stop("L1", "l1-convention") == "Convention"
    assert static_gtfs.station_positions["L1"]["Convention"] == (
        -33.8726,
        151.1981,
    )
    assert static_gtfs.station_for_stop("L3", "l3-es") == "ES Marks"
