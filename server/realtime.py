"""TfNSW light-rail GTFS-Realtime fetching with per-feed last-good caches."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping, Sequence

import requests
from google.transit import gtfs_realtime_pb2

from .errors import MissingTokenError, RealtimeFeedError


@dataclass(frozen=True, slots=True)
class FeedSpec:
    name: str
    url: str
    routes: frozenset[str]


DEFAULT_FEEDS: tuple[FeedSpec, ...] = (
    FeedSpec(
        name="innerwest",
        url="https://api.transport.nsw.gov.au/v2/gtfs/vehiclepos/lightrail/innerwest",
        routes=frozenset({"L1"}),
    ),
    FeedSpec(
        name="cbdandsoutheast",
        url=(
            "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/"
            "lightrail/cbdandsoutheast"
        ),
        routes=frozenset({"L2", "L3"}),
    ),
    FeedSpec(
        name="parramatta",
        url="https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/lightrail/parramatta",
        routes=frozenset({"L4"}),
    ),
)


@dataclass(frozen=True, slots=True)
class FeedPart:
    spec: FeedSpec
    message: gtfs_realtime_pb2.FeedMessage
    received_at: float
    header_timestamp: float

    def age(self, now: float) -> float:
        timestamp = self.header_timestamp or self.received_at
        return max(0.0, now - timestamp)


@dataclass(frozen=True, slots=True)
class FeedSnapshot:
    parts: tuple[FeedPart, ...]
    attempted_at: float
    errors: Mapping[str, str]

    def feed_age(self, now: float) -> int | None:
        if not self.parts:
            return None
        return int(max(part.age(now) for part in self.parts))

    def health(self, now: float) -> dict[str, dict[str, object]]:
        by_name = {part.spec.name: part for part in self.parts}
        names = set(by_name) | set(self.errors)
        return {
            name: {
                "available": name in by_name,
                "age": int(by_name[name].age(now)) if name in by_name else None,
                "error": self.errors.get(name),
            }
            for name in sorted(names)
        }


class TfNSWRealtimeClient:
    """Fetch the three official light-rail feeds without discarding last-good data."""

    _MIN_FAILURE_BACKOFF_SECONDS = 1.0

    def __init__(
        self,
        *,
        token: str | None,
        feeds: Sequence[FeedSpec] = DEFAULT_FEEDS,
        session: requests.Session | None = None,
        cache_seconds: float = 15.0,
        failure_backoff_max_seconds: float = 300.0,
        timeout_seconds: float = 12.0,
        max_response_bytes: int = 20 * 1024 * 1024,
        clock: Callable[[], float] | None = None,
    ):
        self.token = (token or "").strip()
        self.feeds = tuple(feeds)
        self.session = session or requests.Session()
        self.cache_seconds = max(0.0, float(cache_seconds))
        failure_backoff_base = max(
            self._MIN_FAILURE_BACKOFF_SECONDS,
            self.cache_seconds,
        )
        self.failure_backoff_max_seconds = max(
            failure_backoff_base,
            float(failure_backoff_max_seconds),
        )
        self.timeout_seconds = max(0.1, float(timeout_seconds))
        self.max_response_bytes = max(1024, int(max_response_bytes))
        self._clock = clock or time.time
        self._parts: dict[str, FeedPart] = {}
        self._errors: dict[str, str] = {}
        self._has_attempted = False
        self._last_attempt = 0.0
        self._next_attempt_at = 0.0
        self._consecutive_total_failures = 0
        self._lock = threading.Lock()

    @staticmethod
    def _safe_error(exc: Exception) -> str:
        # Do not leak response bodies or request headers (which can contain the
        # API token) into health JSON or logs.
        if isinstance(exc, requests.HTTPError) and exc.response is not None:
            return f"HTTP {exc.response.status_code}"
        if isinstance(exc, requests.Timeout):
            return "timeout"
        if isinstance(exc, requests.RequestException):
            return exc.__class__.__name__
        return exc.__class__.__name__

    def _fetch_one(self, spec: FeedSpec, now: float) -> FeedPart:
        headers = {
            # TfNSW Open Data uses the literal ``apikey`` auth scheme.  This
            # matches the working Metroboard implementation.
            "Authorization": f"apikey {self.token}",
            "Accept": "application/x-protobuf, application/octet-stream",
            "Cache-Control": "no-cache",
            "User-Agent": "tramtrace/1.0",
        }
        response = self.session.get(
            spec.url,
            headers=headers,
            timeout=self.timeout_seconds,
        )
        try:
            response.raise_for_status()
            body = response.content
            if len(body) > self.max_response_bytes:
                raise RealtimeFeedError("GTFS-Realtime response exceeded the size limit")
            message = gtfs_realtime_pb2.FeedMessage()
            message.ParseFromString(body)
            header_timestamp = float(getattr(message.header, "timestamp", 0) or 0)
            return FeedPart(
                spec=spec,
                message=message,
                received_at=now,
                header_timestamp=header_timestamp,
            )
        finally:
            response.close()

    def _snapshot_locked(self) -> FeedSnapshot:
        return FeedSnapshot(
            parts=tuple(self._parts.values()),
            attempted_at=self._last_attempt,
            errors=dict(self._errors),
        )

    def _raise_unavailable_locked(self) -> None:
        detail = ", ".join(
            f"{name}={error}" for name, error in sorted(self._errors.items())
        )
        raise RealtimeFeedError(
            f"No TfNSW light-rail feed is available{': ' + detail if detail else ''}"
        )

    def _record_attempt_locked(
        self,
        *,
        timestamp: float,
        errors: Mapping[str, str],
        successful_fetches: int,
    ) -> None:
        self._has_attempted = True
        self._errors = dict(errors)
        self._last_attempt = timestamp
        if successful_fetches:
            self._consecutive_total_failures = 0
            self._next_attempt_at = timestamp + self.cache_seconds
            return

        self._consecutive_total_failures += 1
        backoff_base = max(
            self._MIN_FAILURE_BACKOFF_SECONDS,
            self.cache_seconds,
        )
        # Cap the exponent as well as the resulting delay so a prolonged
        # outage cannot create unnecessarily large intermediate integers.
        exponent = min(self._consecutive_total_failures - 1, 30)
        delay = min(
            self.failure_backoff_max_seconds,
            backoff_base * (2**exponent),
        )
        self._next_attempt_at = timestamp + delay

    def snapshot(self, *, now: float | None = None, force: bool = False) -> FeedSnapshot:
        if not self.token:
            raise MissingTokenError(
                "TFNSW_API_TOKEN is required for TfNSW light-rail realtime data"
            )

        use_completion_clock = now is None
        timestamp = self._clock() if use_completion_clock else float(now)
        with self._lock:
            if (
                not force
                and self._has_attempted
                and timestamp < self._next_attempt_at
            ):
                if not self._parts:
                    self._raise_unavailable_locked()
                return self._snapshot_locked()

            errors: dict[str, str] = {}
            successful_fetches = 0
            successful_names: list[str] = []
            for spec in self.feeds:
                try:
                    self._parts[spec.name] = self._fetch_one(spec, timestamp)
                    successful_fetches += 1
                    successful_names.append(spec.name)
                except Exception as exc:
                    errors[spec.name] = self._safe_error(exc)
            completed_at = (
                max(timestamp, self._clock())
                if use_completion_clock
                else timestamp
            )
            if use_completion_clock:
                for name in successful_names:
                    part = self._parts[name]
                    self._parts[name] = FeedPart(
                        spec=part.spec,
                        message=part.message,
                        received_at=completed_at,
                        header_timestamp=part.header_timestamp,
                    )
            self._record_attempt_locked(
                timestamp=completed_at,
                errors=errors,
                successful_fetches=successful_fetches,
            )

            if not self._parts:
                self._raise_unavailable_locked()
            return self._snapshot_locked()

    def cached_snapshot(self) -> FeedSnapshot | None:
        with self._lock:
            if not self._has_attempted:
                return None
            return self._snapshot_locked()
