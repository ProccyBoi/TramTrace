from __future__ import annotations

import threading

import pytest
import requests
from google.transit import gtfs_realtime_pb2

from server.errors import RealtimeFeedError
from server.realtime import FeedSpec, TfNSWRealtimeClient
from server.service import Settings, TramTraceService


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


class _BlockingFailureSession:
    def __init__(self):
        self.calls = 0
        self.request_started = threading.Event()
        self.release_request = threading.Event()

    def get(self, *args, **kwargs):
        self.calls += 1
        self.request_started.set()
        if not self.release_request.wait(timeout=2):
            raise AssertionError("test did not release the blocked request")
        raise requests.ConnectionError("temporary outage")


class _SequenceClock:
    def __init__(self, values: list[float]):
        self.values = list(values)

    def __call__(self) -> float:
        return self.values.pop(0)


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


def test_empty_failure_is_cached_for_the_configured_interval() -> None:
    session = _SequenceSession(
        [
            requests.ConnectionError("temporary outage"),
            _Response(_feed_bytes(115)),
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
        cache_seconds=15,
    )

    with pytest.raises(RealtimeFeedError, match="innerwest=ConnectionError"):
        client.snapshot(now=100)
    with pytest.raises(RealtimeFeedError, match="innerwest=ConnectionError"):
        client.snapshot(now=114.999)

    assert len(session.calls) == 1
    cached = client.cached_snapshot()
    assert cached is not None
    assert cached.parts == ()
    assert cached.attempted_at == 100
    assert cached.errors == {"innerwest": "ConnectionError"}

    recovered = client.snapshot(now=115)
    assert len(session.calls) == 2
    assert recovered.parts[0].header_timestamp == 115
    assert recovered.errors == {}


def test_production_cooldown_starts_when_a_slow_fetch_completes() -> None:
    session = _SequenceSession(
        [
            _Response(_feed_bytes(100)),
            _Response(_feed_bytes(135)),
        ]
    )
    clock = _SequenceClock([100, 120, 134.999, 135, 140])
    spec = FeedSpec(
        name="innerwest",
        url="https://example.invalid/innerwest",
        routes=frozenset({"L1"}),
    )
    client = TfNSWRealtimeClient(
        token="test-token",
        feeds=(spec,),
        session=session,  # type: ignore[arg-type]
        cache_seconds=15,
        clock=clock,
    )

    first = client.snapshot()
    cached = client.snapshot()
    refreshed = client.snapshot()

    assert first.attempted_at == 120
    assert first.parts[0].received_at == 120
    assert cached.attempted_at == 120
    assert refreshed.attempted_at == 140
    assert len(session.calls) == 2


def test_total_failure_backoff_is_bounded_and_resets_on_recovery() -> None:
    session = _SequenceSession(
        [
            requests.ConnectionError("failure one"),
            requests.ConnectionError("failure two"),
            requests.ConnectionError("failure three"),
            _Response(_feed_bytes(170)),
            requests.ConnectionError("failure after recovery"),
            _Response(_feed_bytes(190)),
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
        cache_seconds=10,
        failure_backoff_max_seconds=40,
    )

    with pytest.raises(RealtimeFeedError):
        client.snapshot(now=100)
    with pytest.raises(RealtimeFeedError):
        client.snapshot(now=109)
    assert len(session.calls) == 1

    with pytest.raises(RealtimeFeedError):
        client.snapshot(now=110)
    with pytest.raises(RealtimeFeedError):
        client.snapshot(now=129)
    assert len(session.calls) == 2

    with pytest.raises(RealtimeFeedError):
        client.snapshot(now=130)
    with pytest.raises(RealtimeFeedError):
        client.snapshot(now=169)
    assert len(session.calls) == 3

    recovered = client.snapshot(now=170)
    assert recovered.parts[0].header_timestamp == 170
    assert len(session.calls) == 4

    stale = client.snapshot(now=180)
    assert stale.parts[0].header_timestamp == 170
    assert stale.errors == {"innerwest": "ConnectionError"}
    assert len(session.calls) == 5

    cached = client.snapshot(now=189)
    assert cached.attempted_at == 180
    assert len(session.calls) == 5

    recovered_again = client.snapshot(now=190)
    assert recovered_again.parts[0].header_timestamp == 190
    assert recovered_again.errors == {}
    assert len(session.calls) == 6


def test_partial_refresh_retains_each_feeds_last_good_data() -> None:
    innerwest = FeedSpec(
        name="innerwest",
        url="https://example.invalid/innerwest",
        routes=frozenset({"L1"}),
    )
    parramatta = FeedSpec(
        name="parramatta",
        url="https://example.invalid/parramatta",
        routes=frozenset({"L4"}),
    )
    session = _SequenceSession(
        [
            _Response(_feed_bytes(100)),
            requests.ConnectionError("L4 unavailable"),
            requests.ConnectionError("L1 unavailable"),
            _Response(_feed_bytes(115)),
        ]
    )
    client = TfNSWRealtimeClient(
        token="test-token",
        feeds=(innerwest, parramatta),
        session=session,  # type: ignore[arg-type]
        cache_seconds=15,
    )

    first = client.snapshot(now=100)
    second = client.snapshot(now=115)

    first_by_name = {part.spec.name: part for part in first.parts}
    second_by_name = {part.spec.name: part for part in second.parts}
    assert set(first_by_name) == {"innerwest"}
    assert first.errors == {"parramatta": "ConnectionError"}
    assert second_by_name["innerwest"].header_timestamp == 100
    assert second_by_name["parramatta"].header_timestamp == 115
    assert second.errors == {"innerwest": "ConnectionError"}


def test_concurrent_callers_share_an_empty_failure_attempt() -> None:
    session = _BlockingFailureSession()
    spec = FeedSpec(
        name="innerwest",
        url="https://example.invalid/innerwest",
        routes=frozenset({"L1"}),
    )
    client = TfNSWRealtimeClient(
        token="test-token",
        feeds=(spec,),
        session=session,  # type: ignore[arg-type]
        cache_seconds=15,
    )
    second_started = threading.Event()
    errors: list[Exception] = []

    def request_snapshot(*, signal_started: bool = False) -> None:
        if signal_started:
            second_started.set()
        try:
            client.snapshot(now=100)
        except Exception as exc:
            errors.append(exc)

    first = threading.Thread(target=request_snapshot)
    second = threading.Thread(
        target=request_snapshot,
        kwargs={"signal_started": True},
    )
    first.start()
    assert session.request_started.wait(timeout=2)
    second.start()
    assert second_started.wait(timeout=2)
    session.release_request.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert session.calls == 1
    assert len(errors) == 2
    assert all(isinstance(exc, RealtimeFeedError) for exc in errors)


def test_runtime_feed_cache_defaults_to_and_clamps_at_15_seconds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TRAMTRACE_FEED_CACHE_SECONDS", raising=False)
    assert Settings.from_env().feed_cache_seconds == 15

    monkeypatch.setenv("TRAMTRACE_FEED_CACHE_SECONDS", "3")
    assert Settings.from_env().feed_cache_seconds == 15

    monkeypatch.setenv("TRAMTRACE_FEED_CACHE_SECONDS", "30")
    assert Settings.from_env().feed_cache_seconds == 30

    unsafe_settings = Settings(api_token="test-token", feed_cache_seconds=3)
    service = TramTraceService(unsafe_settings)
    assert service.realtime.cache_seconds == 15
