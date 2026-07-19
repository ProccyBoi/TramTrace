from __future__ import annotations

import csv
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "hardware" / "STATION_MAPPING.csv"
HEADER_PATH = ROOT / "include" / "station_map.h"

PINS = {"L1": 16, "L2": 17, "L3": 18, "L4": 19}
LENGTHS = {"L1": 45, "L2": 8, "L3": 30, "L4": 32}
DESTINATIONS = {
    "L1": ("Dulwich Hill", "Central"),
    "L2": ("Randwick", "Circular Quay"),
    "L3": ("Juniors Kingsford", "Circular Quay"),
    "L4": ("Westmead", "Carlingford"),
}


def load_rows() -> list[dict[str, str]]:
    with CSV_PATH.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def test_csv_and_firmware_bindings_are_identical() -> None:
    rows = load_rows()
    assert len(rows) == 68

    source = HEADER_PATH.read_text(encoding="utf-8")
    bindings = re.findall(
        r'\{"(L[1-4])", "([^"]+)", '
        r"\{Strip::(L[1-4]), (\d+), (\d+)\}\}",
        source,
    )
    assert len(bindings) == 68

    expected = [
        (
            row["route"],
            row["station"],
            f"L{(int(row['gpio']) - 15)}",
            row["pixel_direction_0"],
            row["pixel_direction_1"],
        )
        for row in rows
    ]
    assert bindings == expected


def test_direction_labels_and_pixels_are_valid() -> None:
    rows = load_rows()
    seen: dict[str, set[int]] = {line: set() for line in LENGTHS}

    for row in rows:
        route = row["route"]
        physical_strip = f"L{int(row['gpio']) - 15}"
        pixel_0 = int(row["pixel_direction_0"])
        pixel_1 = int(row["pixel_direction_1"])

        assert int(row["gpio"]) == PINS[physical_strip]
        assert row["direction_0_destination"] == DESTINATIONS[route][0]
        assert row["direction_1_destination"] == DESTINATIONS[route][1]
        assert 0 <= pixel_0 < LENGTHS[physical_strip]
        assert 0 <= pixel_1 < LENGTHS[physical_strip]
        seen[physical_strip].update((pixel_0, pixel_1))

    for line, length in LENGTHS.items():
        assert seen[line] == set(range(length))


def test_known_layout_exceptions_are_explicit() -> None:
    rows = load_rows()
    by_key = {(row["route"], row["station"]): row for row in rows}

    central_l1 = by_key[("L1", "Central")]
    assert central_l1["led_direction_0"] == "LED139"
    assert central_l1["led_direction_1"] == "LED139"

    l2_shared = by_key[("L2", "Circular Quay")]
    l3_shared = by_key[("L3", "Circular Quay")]
    assert l2_shared["gpio"] == l3_shared["gpio"] == "18"
    assert l2_shared["led_direction_0"] == l3_shared["led_direction_0"]
    assert l2_shared["led_direction_1"] == l3_shared["led_direction_1"]

    assert by_key[("L1", "Bank Street")]["parent_stop_id"] == "200952"
