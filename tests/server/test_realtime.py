from __future__ import annotations

import requests
from google.transit import gtfs_realtime_pb2

from server.realtime import FeedSpec, TfNSWRealtimeClient


class _Response:
    def __init__(self, body: bytes):
        self.content = body

    def raise_for_status(self) -> None:
        return None

    def close(self) -> None:
        return None


class _SequenceSession:
    def __init__(self, results: list[object]):
        self.results = list(results)
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def get(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def _feed_bytes(timestamp: int) -> bytes:
    message = gtfs_realtime_pb2.FeedMessage()
    message.header.gtfs_realtime_version = "2.0"
    message.header.timestamp = timestamp
    return message.SerializeToString()


def test_last_good_feed_survives_a_transient_fetch_failure() -> None:
    session = _SequenceSession(
        [
            _Response(_feed_bytes(100)),
            requests.ConnectionError("temporary outage"),
        ]
    )
    spec = FeedSpec(
        name="innerwest",
        url="https://example.invalid/innerwest",
        routes=frozenset({"L1"}),
    )
    client = TfNSWRealtimeClient(
        token="test-token",
        feeds=(spec,),
        session=session,  # type: ignore[arg-type]
        cache_seconds=0,
    )

    first = client.snapshot(now=100, force=True)
    second = client.snapshot(now=105, force=True)

    assert first.parts[0].header_timestamp == 100
    assert second.parts[0].header_timestamp == 100
    assert second.feed_age(105) == 5
    assert second.health(105)["innerwest"]["available"] is True
    assert second.health(105)["innerwest"]["error"] == "ConnectionError"
    assert session.calls[0][1]["headers"]["Authorization"] == "apikey test-token"
