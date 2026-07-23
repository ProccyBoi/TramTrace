from __future__ import annotations

import time

from fastapi.testclient import TestClient

from server.app import create_app
from server.gtfs import StaticGTFS
from server.realtime import FeedSnapshot, TfNSWRealtimeClient
from server.service import Settings, TramTraceService
from server.state import STOPPED_AT


class _SnapshotClient:
    def __init__(self, snapshot: FeedSnapshot):
        self.value = snapshot
        self.requested_nows: list[float | None] = []

    def snapshot(self, *, now: float | None = None, force: bool = False) -> FeedSnapshot:
        self.requested_nows.append(now)
        return self.value

    def cached_snapshot(self) -> FeedSnapshot:
        return self.value


def test_payload_contract_is_compact_and_directional(
    static_gtfs: StaticGTFS, feed_part_factory
) -> None:
    now = int(time.time())
    part = feed_part_factory(
        name="parramatta",
        routes={"L4"},
        header_timestamp=now - 2,
        vehicles=[
            {
                "trip_id": "l4-0",
                "route_id": "route-L4",
                "stop_id": "l4-childrens",
                "current_status": STOPPED_AT,
                "timestamp": now - 2,
            }
        ],
    )
    snapshot = FeedSnapshot(parts=(part,), attempted_at=now, errors={})
    settings = Settings(api_token="test-token", brightness=24, poll_seconds=3)
    realtime = _SnapshotClient(snapshot)
    service = TramTraceService(
        settings,
        static=static_gtfs,
        realtime=realtime,  # type: ignore[arg-type]
    )
    client = TestClient(create_app(service))

    response = client.get("/tramtrace_payload")
    assert response.status_code == 200
    payload = response.json()
    assert tuple(payload) == (
        "schema",
        "timestamp",
        "feed_age",
        "brightness",
        "poll_seconds",
        "states",
    )
    assert payload["schema"] == 1
    assert payload["brightness"] == 24
    assert payload["poll_seconds"] == 3
    assert payload["states"]["L4"]["Childrens Hospital"] == [3, 0]
    assert response.headers["cache-control"] == "no-store"
    assert realtime.requested_nows == [None]


def test_one_stale_feed_does_not_block_other_fresh_routes(
    static_gtfs: StaticGTFS, feed_part_factory
) -> None:
    now = int(time.time())
    stale = feed_part_factory(
        name="innerwest",
        routes={"L1"},
        header_timestamp=now - 500,
        vehicles=[],
    )
    fresh = feed_part_factory(
        name="parramatta",
        routes={"L4"},
        header_timestamp=now - 3,
        vehicles=[
            {
                "trip_id": "l4-0",
                "route_id": "route-L4",
                "stop_id": "l4-childrens",
                "current_status": STOPPED_AT,
                "timestamp": now - 3,
            }
        ],
    )
    snapshot = FeedSnapshot(
        parts=(stale, fresh),
        attempted_at=now,
        errors={"innerwest": "timeout"},
    )
    realtime = _SnapshotClient(snapshot)
    service = TramTraceService(
        Settings(api_token="test-token", max_feed_age_seconds=120),
        static=static_gtfs,
        realtime=realtime,  # type: ignore[arg-type]
    )

    payload = service.payload(now=now)
    assert payload["feed_age"] == 3
    assert payload["states"]["L1"]["Bank Street"] == [0, 0]
    assert payload["states"]["L4"]["Childrens Hospital"] == [3, 0]
    assert realtime.requested_nows == [now]


def test_missing_token_fails_without_exposing_a_secret(static_gtfs: StaticGTFS) -> None:
    settings = Settings(api_token=None)
    realtime = TfNSWRealtimeClient(token=None, feeds=())
    service = TramTraceService(settings, static=static_gtfs, realtime=realtime)
    client = TestClient(create_app(service))

    payload_response = client.get("/tramtrace_payload")
    assert payload_response.status_code == 503
    assert payload_response.json()["error"] == "missing_tfnsw_api_token"
    assert "test-token" not in payload_response.text

    health_response = client.get("/healthz")
    assert health_response.status_code == 503
    assert health_response.json()["token_configured"] is False
