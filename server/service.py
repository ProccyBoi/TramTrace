"""Application configuration and orchestration for TramTrace."""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from typing import Sequence

import requests

from .errors import MissingTokenError, RealtimeFeedError, StaticGTFSLoadError
from .gtfs import StaticGTFS, load_static_gtfs, merge_static_gtfs
from .realtime import (
    DEFAULT_FEEDS,
    FeedSnapshot,
    FeedSpec,
    TfNSWRealtimeClient,
)
from .schedule import (
    DEFAULT_SCHEDULES,
    ScheduleSpec,
    TfNSWScheduleClient,
)
from .state import (
    DEFAULT_APPROACHING_METRES,
    DEFAULT_AT_STATION_METRES,
    DEFAULT_FAR_METRES,
    DirectionalStateEngine,
    StateThresholds,
    observations_from_snapshot,
)

MIN_FEED_CACHE_SECONDS = 15.0


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return min(maximum, max(minimum, parsed))


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return min(maximum, max(minimum, parsed))


def _feed_specs_from_env() -> tuple[FeedSpec, ...]:
    overrides = {
        "innerwest": os.getenv("TRAMTRACE_L1_VP_URL"),
        "cbdandsoutheast": os.getenv("TRAMTRACE_L23_VP_URL"),
        "parramatta": os.getenv("TRAMTRACE_L4_VP_URL"),
    }
    return tuple(
        FeedSpec(spec.name, overrides.get(spec.name) or spec.url, spec.routes)
        for spec in DEFAULT_FEEDS
    )


def _schedule_specs_from_env() -> tuple[ScheduleSpec, ...]:
    overrides = {
        "innerwest": os.getenv("TRAMTRACE_L1_SCHEDULE_SOURCE"),
        "cbdandsoutheast": os.getenv("TRAMTRACE_L23_SCHEDULE_SOURCE"),
        "parramatta": os.getenv("TRAMTRACE_L4_SCHEDULE_SOURCE"),
    }
    return tuple(
        ScheduleSpec(
            spec.name,
            overrides.get(spec.name) or spec.source,
            spec.routes,
        )
        for spec in DEFAULT_SCHEDULES
    )


@dataclass(frozen=True, slots=True)
class Settings:
    api_token: str | None
    gtfs_source: str | None = None
    brightness: int = 24
    poll_seconds: int = 3
    feed_cache_seconds: float = MIN_FEED_CACHE_SECONDS
    static_refresh_seconds: float = 21_600.0
    request_timeout_seconds: float = 15.0
    static_timeout_seconds: float = 90.0
    schedule_refresh_seconds: float = 21_600.0
    schedule_failure_retry_seconds: float = 60.0
    max_vehicle_age_seconds: float = 90.0
    max_feed_age_seconds: float = 120.0
    future_tolerance_seconds: float = 30.0
    at_station_metres: float = DEFAULT_AT_STATION_METRES
    approaching_metres: float = DEFAULT_APPROACHING_METRES
    far_metres: float = DEFAULT_FAR_METRES
    feeds: Sequence[FeedSpec] = DEFAULT_FEEDS
    schedules: Sequence[ScheduleSpec] = DEFAULT_SCHEDULES

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            api_token=os.getenv("TFNSW_API_TOKEN"),
            gtfs_source=os.getenv("TRAMTRACE_GTFS_SOURCE") or None,
            # The firmware clamps at 64 to protect USB-powered boards.
            brightness=_env_int("TRAMTRACE_BRIGHTNESS", 24, 0, 64),
            poll_seconds=_env_int("TRAMTRACE_POLL_SECONDS", 3, 1, 60),
            feed_cache_seconds=_env_float(
                "TRAMTRACE_FEED_CACHE_SECONDS",
                MIN_FEED_CACHE_SECONDS,
                MIN_FEED_CACHE_SECONDS,
                60.0,
            ),
            static_refresh_seconds=_env_float(
                "TRAMTRACE_STATIC_REFRESH_SECONDS", 21_600.0, 60.0, 604_800.0
            ),
            request_timeout_seconds=_env_float(
                "TRAMTRACE_REQUEST_TIMEOUT_SECONDS", 15.0, 1.0, 120.0
            ),
            static_timeout_seconds=_env_float(
                "TRAMTRACE_STATIC_TIMEOUT_SECONDS", 90.0, 1.0, 600.0
            ),
            schedule_refresh_seconds=_env_float(
                "TRAMTRACE_SCHEDULE_REFRESH_SECONDS", 21_600.0, 60.0, 604_800.0
            ),
            schedule_failure_retry_seconds=_env_float(
                "TRAMTRACE_SCHEDULE_RETRY_SECONDS", 60.0, 1.0, 3600.0
            ),
            max_vehicle_age_seconds=_env_float(
                "TRAMTRACE_MAX_VEHICLE_AGE_SECONDS", 90.0, 1.0, 900.0
            ),
            max_feed_age_seconds=_env_float(
                "TRAMTRACE_MAX_FEED_AGE_SECONDS", 120.0, 1.0, 1800.0
            ),
            future_tolerance_seconds=_env_float(
                "TRAMTRACE_FUTURE_TOLERANCE_SECONDS", 30.0, 0.0, 300.0
            ),
            at_station_metres=_env_float(
                "TRAMTRACE_AT_STATION_METRES",
                DEFAULT_AT_STATION_METRES,
                0.0,
                5000.0,
            ),
            approaching_metres=_env_float(
                "TRAMTRACE_APPROACHING_METRES",
                DEFAULT_APPROACHING_METRES,
                0.0,
                5000.0,
            ),
            far_metres=_env_float(
                "TRAMTRACE_FAR_METRES",
                DEFAULT_FAR_METRES,
                0.0,
                5000.0,
            ),
            feeds=_feed_specs_from_env(),
            schedules=_schedule_specs_from_env(),
        )


class TramTraceService:
    def __init__(
        self,
        settings: Settings,
        *,
        session: requests.Session | None = None,
        static: StaticGTFS | None = None,
        realtime: TfNSWRealtimeClient | None = None,
        schedules: TfNSWScheduleClient | None = None,
    ):
        self.settings = settings
        self.session = session or requests.Session()
        self.realtime = realtime or TfNSWRealtimeClient(
            token=settings.api_token,
            feeds=settings.feeds,
            session=self.session,
            cache_seconds=max(
                MIN_FEED_CACHE_SECONDS,
                settings.feed_cache_seconds,
            ),
            timeout_seconds=settings.request_timeout_seconds,
        )
        self.schedule_client = schedules or TfNSWScheduleClient(
            token=settings.api_token,
            schedules=settings.schedules,
            session=self.session,
            refresh_seconds=settings.schedule_refresh_seconds,
            failure_retry_seconds=settings.schedule_failure_retry_seconds,
            timeout_seconds=settings.static_timeout_seconds,
        )
        self._base_static = static
        self._static = static
        self._engine = self._make_engine(static) if static else None
        self._static_error: str | None = None
        self._static_lock = threading.Lock()
        self._last_merge_at = static.loaded_at if static else 0.0

    def _make_engine(self, static: StaticGTFS) -> DirectionalStateEngine:
        at_station = max(0.0, self.settings.at_station_metres)
        approaching = max(at_station, self.settings.approaching_metres)
        far = max(approaching, self.settings.far_metres)
        thresholds = StateThresholds(
            at_station_metres=at_station,
            approaching_metres=approaching,
            far_metres=far,
        )
        return DirectionalStateEngine(
            static,
            thresholds=thresholds,
            max_vehicle_age_seconds=self.settings.max_vehicle_age_seconds,
            max_feed_age_seconds=self.settings.max_feed_age_seconds,
            future_tolerance_seconds=self.settings.future_tolerance_seconds,
        )

    def static_gtfs(self, *, now: float) -> StaticGTFS:
        with self._static_lock:
            cached_schedules = self.schedule_client.cached_snapshot()
            schedule_degraded = (
                cached_schedules is None
                or len(cached_schedules.parts) < len(self.settings.schedules)
                or bool(cached_schedules.errors)
            )
            refresh_after = min(
                self.settings.schedule_refresh_seconds,
                (
                    self.settings.static_refresh_seconds
                    if self.settings.gtfs_source
                    else self.settings.schedule_refresh_seconds
                ),
            )
            if schedule_degraded or self._static_error is not None:
                refresh_after = min(
                    refresh_after,
                    self.settings.schedule_failure_retry_seconds,
                )
            if self._static is not None and now - self._last_merge_at < refresh_after:
                return self._static

            base_error: str | None = None
            if self.settings.gtfs_source and (
                self._base_static is None
                or now - self._base_static.loaded_at
                >= self.settings.static_refresh_seconds
            ):
                try:
                    self._base_static = load_static_gtfs(
                        self.settings.gtfs_source,
                        token=self.settings.api_token,
                        session=self.session,
                        timeout_seconds=self.settings.static_timeout_seconds,
                        now=now,
                    )
                except Exception as exc:
                    base_error = exc.__class__.__name__

            schedule_error: str | None = None
            schedule_exception: Exception | None = None
            try:
                schedule_snapshot = self.schedule_client.snapshot(now=now)
            except Exception as exc:
                schedule_exception = exc
                schedule_error = exc.__class__.__name__
                schedule_snapshot = self.schedule_client.cached_snapshot()

            overlays = (
                tuple(part.static for part in schedule_snapshot.parts)
                if schedule_snapshot is not None
                else ()
            )
            if self._base_static is None and not overlays:
                self._static_error = schedule_error or base_error
                if self._static is not None:
                    return self._static
                if isinstance(schedule_exception, MissingTokenError):
                    raise schedule_exception
                if schedule_error:
                    raise StaticGTFSLoadError(
                        "No realtime-aligned operator schedule is available"
                    )
                raise StaticGTFSLoadError("No static GTFS source is available")

            try:
                refreshed = merge_static_gtfs(
                    self._base_static,
                    overlays,
                    now=now,
                )
            except Exception as exc:
                self._static_error = exc.__class__.__name__
                if self._static is not None:
                    return self._static
                raise

            self._static = refreshed
            self._engine = self._make_engine(refreshed)
            self._static_error = base_error
            self._last_merge_at = now
            return refreshed

    def payload(self, *, now: float | None = None) -> dict[str, object]:
        use_realtime_clock = now is None
        timestamp = time.time() if use_realtime_clock else float(now)
        static = self.static_gtfs(now=timestamp)
        snapshot = self.realtime.snapshot(
            now=None if use_realtime_clock else timestamp
        )
        if use_realtime_clock:
            timestamp = time.time()
        fresh_parts = tuple(
            part
            for part in snapshot.parts
            if (
                -self.settings.future_tolerance_seconds
                <= timestamp - (part.header_timestamp or part.received_at)
                <= self.settings.max_feed_age_seconds
            )
        )
        if not fresh_parts:
            raise RealtimeFeedError("No fresh TfNSW light-rail feed is available")
        usable_snapshot = FeedSnapshot(
            parts=fresh_parts,
            attempted_at=snapshot.attempted_at,
            errors=snapshot.errors,
        )
        engine = self._engine
        if engine is None:  # Defensive; static_gtfs always sets this.
            raise StaticGTFSLoadError("Static GTFS state engine is unavailable")
        observations = observations_from_snapshot(
            usable_snapshot,
            static,
            now=timestamp,
            max_feed_age_seconds=self.settings.max_feed_age_seconds,
            future_tolerance_seconds=self.settings.future_tolerance_seconds,
        )
        result = engine.calculate(observations, now=timestamp)
        return {
            "schema": 1,
            "timestamp": int(timestamp),
            "feed_age": usable_snapshot.feed_age(timestamp),
            "brightness": self.settings.brightness,
            "poll_seconds": self.settings.poll_seconds,
            "states": result.states,
        }

    def health(self, *, now: float | None = None) -> tuple[dict[str, object], bool]:
        timestamp = time.time() if now is None else float(now)
        snapshot: FeedSnapshot | None = self.realtime.cached_snapshot()
        token_configured = bool((self.settings.api_token or "").strip())
        static_loaded = self._static is not None
        feed_details = {
            spec.name: {
                "available": False,
                "fresh": False,
                "age": None,
                "error": None,
            }
            for spec in self.settings.feeds
        }
        if snapshot is not None:
            for name, details in snapshot.health(timestamp).items():
                age = details["age"]
                details["fresh"] = (
                    isinstance(age, int)
                    and age <= self.settings.max_feed_age_seconds
                )
                feed_details[name] = details
        all_feeds_fresh = bool(feed_details) and all(
            bool(details["fresh"]) for details in feed_details.values()
        )
        schedule_details = {
            spec.name: {
                "available": False,
                "age": None,
                "error": None,
            }
            for spec in self.settings.schedules
        }
        schedule_snapshot = self.schedule_client.cached_snapshot()
        if schedule_snapshot is not None:
            schedule_details.update(schedule_snapshot.health(timestamp))
        all_schedules_available = bool(schedule_details) and all(
            bool(details["available"]) for details in schedule_details.values()
        )
        healthy = (
            token_configured
            and static_loaded
            and self._static_error is None
            and all_feeds_fresh
            and all_schedules_available
        )
        body: dict[str, object] = {
            "ok": healthy,
            "token_configured": token_configured,
            "static_loaded": static_loaded,
            "static_age": (
                int(max(0.0, timestamp - self._static.loaded_at))
                if self._static is not None
                else None
            ),
            "feed_age": snapshot.feed_age(timestamp) if snapshot else None,
            "feeds": feed_details,
            "schedules": schedule_details,
            "error": self._static_error,
        }
        return body, healthy
