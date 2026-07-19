"""Realtime-aligned TfNSW operator schedule loading and last-good caches."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Mapping, Sequence

import requests

from .errors import MissingTokenError, StaticGTFSLoadError
from .gtfs import StaticGTFS, load_static_gtfs


@dataclass(frozen=True, slots=True)
class ScheduleSpec:
    name: str
    source: str
    routes: frozenset[str]


DEFAULT_SCHEDULES: tuple[ScheduleSpec, ...] = (
    ScheduleSpec(
        "innerwest",
        "https://api.transport.nsw.gov.au/v1/gtfs/schedule/lightrail/innerwest",
        frozenset({"L1"}),
    ),
    ScheduleSpec(
        "cbdandsoutheast",
        (
            "https://api.transport.nsw.gov.au/v1/gtfs/schedule/"
            "lightrail/cbdandsoutheast"
        ),
        frozenset({"L2", "L3"}),
    ),
    ScheduleSpec(
        "parramatta",
        "https://api.transport.nsw.gov.au/v1/gtfs/schedule/lightrail/parramatta",
        frozenset({"L4"}),
    ),
)


@dataclass(frozen=True, slots=True)
class SchedulePart:
    spec: ScheduleSpec
    static: StaticGTFS
    loaded_at: float


@dataclass(frozen=True, slots=True)
class ScheduleSnapshot:
    parts: tuple[SchedulePart, ...]
    attempted_at: float
    errors: Mapping[str, str]

    def health(self, now: float) -> dict[str, dict[str, object]]:
        by_name = {part.spec.name: part for part in self.parts}
        names = set(by_name) | set(self.errors)
        return {
            name: {
                "available": name in by_name,
                "age": (
                    int(max(0.0, now - by_name[name].loaded_at))
                    if name in by_name
                    else None
                ),
                "error": self.errors.get(name),
            }
            for name in sorted(names)
        }


class TfNSWScheduleClient:
    """Refresh operator GTFS bundles independently and retain each last-good."""

    def __init__(
        self,
        *,
        token: str | None,
        schedules: Sequence[ScheduleSpec] = DEFAULT_SCHEDULES,
        session: requests.Session | None = None,
        refresh_seconds: float = 21_600.0,
        failure_retry_seconds: float = 60.0,
        timeout_seconds: float = 90.0,
    ):
        self.token = (token or "").strip()
        self.schedules = tuple(schedules)
        self.session = session or requests.Session()
        self.refresh_seconds = max(60.0, float(refresh_seconds))
        self.failure_retry_seconds = max(1.0, float(failure_retry_seconds))
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self._parts: dict[str, SchedulePart] = {}
        self._errors: dict[str, str] = {}
        self._last_attempts: dict[str, float] = {}
        self._lock = threading.Lock()

    def _due(self, spec: ScheduleSpec, now: float, force: bool) -> bool:
        if force:
            return True
        part = self._parts.get(spec.name)
        if part and now - part.loaded_at < self.refresh_seconds:
            return False
        last_attempt = self._last_attempts.get(spec.name)
        return last_attempt is None or now - last_attempt >= self.failure_retry_seconds

    def snapshot(
        self, *, now: float | None = None, force: bool = False
    ) -> ScheduleSnapshot:
        timestamp = time.time() if now is None else float(now)
        missing_token: MissingTokenError | None = None
        with self._lock:
            errors = dict(self._errors)
            for spec in self.schedules:
                if not self._due(spec, timestamp, force):
                    continue
                self._last_attempts[spec.name] = timestamp
                try:
                    static = load_static_gtfs(
                        spec.source,
                        token=self.token,
                        session=self.session,
                        timeout_seconds=self.timeout_seconds,
                        now=timestamp,
                        expected_routes=spec.routes,
                        namespace=spec.name,
                    )
                    self._parts[spec.name] = SchedulePart(
                        spec=spec,
                        static=static,
                        loaded_at=timestamp,
                    )
                    errors.pop(spec.name, None)
                except MissingTokenError as exc:
                    missing_token = exc
                    errors[spec.name] = exc.__class__.__name__
                except Exception as exc:
                    errors[spec.name] = exc.__class__.__name__
            self._errors = errors

            if not self._parts:
                if missing_token is not None:
                    raise missing_token
                raise StaticGTFSLoadError(
                    "No realtime-aligned light-rail schedule is available"
                )
            return ScheduleSnapshot(
                parts=tuple(self._parts.values()),
                attempted_at=max(self._last_attempts.values(), default=timestamp),
                errors=dict(errors),
            )

    def cached_snapshot(self) -> ScheduleSnapshot | None:
        with self._lock:
            if not self._parts:
                return None
            return ScheduleSnapshot(
                parts=tuple(self._parts.values()),
                attempted_at=max(self._last_attempts.values(), default=0.0),
                errors=dict(self._errors),
            )
