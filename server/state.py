"""Direction-aware conversion of GTFS-Realtime vehicles to PCB LED states."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Iterable

from .gtfs import StaticGTFS, TripPattern
from .mapping import PCB_ROUTE_ORDERS, empty_states
from .realtime import FeedPart, FeedSnapshot


INCOMING_AT = 0
STOPPED_AT = 1
IN_TRANSIT_TO = 2
DEFAULT_AT_STATION_METRES = 120.0
DEFAULT_APPROACHING_METRES = 450.0
DEFAULT_FAR_METRES = 800.0
_ROUTE_TOKEN_RE = re.compile(r"(?<![A-Z0-9])L[1-4](?![A-Z0-9])")


@dataclass(frozen=True, slots=True)
class StateThresholds:
    at_station_metres: float = DEFAULT_AT_STATION_METRES
    approaching_metres: float = DEFAULT_APPROACHING_METRES
    far_metres: float = DEFAULT_FAR_METRES

    def __post_init__(self) -> None:
        if not (
            0 <= self.at_station_metres
            <= self.approaching_metres
            <= self.far_metres
        ):
            raise ValueError("Distance thresholds must be non-negative and increasing")


@dataclass(frozen=True, slots=True)
class VehicleObservation:
    route: str
    direction: int
    trip_id: str | None
    stop_id: str | None
    current_stop_sequence: int | None
    current_status: int
    latitude: float | None
    longitude: float | None
    timestamp: float | None
    source: str = "synthetic"
    vehicle_id: str | None = None
    entity_id: str | None = None
    trip_start_date: str | None = None
    trip_start_time: str | None = None


@dataclass(frozen=True, slots=True)
class StateResult:
    states: dict[str, dict[str, list[int]]]
    accepted_vehicles: int
    stale_vehicles: int
    unresolved_vehicles: int


@dataclass(frozen=True, slots=True)
class _VehicleCandidate:
    observation: VehicleObservation
    station: str
    reported: bool
    distance: float | None
    state: int
    identity_keys: tuple[str, ...]


def _has_field(message: object, field: str) -> bool:
    checker = getattr(message, "HasField", None)
    if checker is None:
        return getattr(message, field, None) is not None
    try:
        return bool(checker(field))
    except (TypeError, ValueError):
        value = getattr(message, field, None)
        return value not in (None, "", 0)


def _as_optional_int(message: object, field: str) -> int | None:
    if not _has_field(message, field):
        return None
    try:
        return int(getattr(message, field))
    except (TypeError, ValueError):
        return None


def _route_from_realtime(
    part: FeedPart,
    static: StaticGTFS,
    *,
    trip_id: str | None,
    route_id: str | None,
    stop_id: str | None,
) -> tuple[str | None, TripPattern | None]:
    pattern = static.trip_for(part.spec.name, trip_id)
    if pattern is not None:
        return pattern.route, pattern

    route = static.route_for_id(route_id, part.spec.name)
    if route in part.spec.routes:
        return route, None

    # Operator realtime route/trip IDs do not always equal consolidated-static
    # IDs.  A delimited L2/L3 token is still safe to use for their shared feed.
    for value in (route_id, trip_id):
        match = _ROUTE_TOKEN_RE.search(str(value or "").upper())
        if match and match.group(0) in part.spec.routes:
            return match.group(0), None

    # L1 and L4 have dedicated endpoints, making source identity authoritative.
    if len(part.spec.routes) == 1:
        return next(iter(part.spec.routes)), None

    # A branch stop can safely distinguish L2 from L3.  Shared-trunk stops
    # resolve to both and are deliberately left unknown rather than guessed.
    if stop_id:
        candidates = {
            candidate
            for candidate in part.spec.routes
            if static.station_for_stop(candidate, stop_id, part.spec.name) is not None
        }
        if len(candidates) == 1:
            return candidates.pop(), None
    return None, None


def observations_from_part(part: FeedPart, static: StaticGTFS) -> Iterable[VehicleObservation]:
    """Yield normalised vehicle observations from one protobuf feed."""

    for entity in part.message.entity:
        if not _has_field(entity, "vehicle"):
            continue
        vehicle = entity.vehicle
        trip_descriptor = vehicle.trip if _has_field(vehicle, "trip") else None
        trip_id = (
            str(getattr(trip_descriptor, "trip_id", "") or "") or None
            if trip_descriptor is not None
            else None
        )
        trip_start_date = (
            str(getattr(trip_descriptor, "start_date", "") or "") or None
            if trip_descriptor is not None
            else None
        )
        trip_start_time = (
            str(getattr(trip_descriptor, "start_time", "") or "") or None
            if trip_descriptor is not None
            else None
        )
        route_id = (
            str(getattr(trip_descriptor, "route_id", "") or "") or None
            if trip_descriptor is not None
            else None
        )
        realtime_direction = (
            _as_optional_int(trip_descriptor, "direction_id")
            if trip_descriptor is not None
            else None
        )

        stop_id = str(getattr(vehicle, "stop_id", "") or "") or None
        route, pattern = _route_from_realtime(
            part,
            static,
            trip_id=trip_id,
            route_id=route_id,
            stop_id=stop_id,
        )
        if route is None or route not in part.spec.routes:
            continue
        # Prefer the live descriptor when its raw ID has been validated
        # against the current static feed.  Fall back to the static trip
        # pattern when the live descriptor omits direction_id.
        checked_realtime_direction = static.checked_direction_id(
            route, realtime_direction, part.spec.name
        )
        direction = (
            checked_realtime_direction
            if checked_realtime_direction in (0, 1)
            else pattern.direction if pattern and pattern.direction in (0, 1)
            else None
        )
        if direction not in (0, 1):
            continue

        latitude: float | None = None
        longitude: float | None = None
        if _has_field(vehicle, "position"):
            latitude = float(vehicle.position.latitude)
            longitude = float(vehicle.position.longitude)

        current_sequence = _as_optional_int(vehicle, "current_stop_sequence")
        current_status = int(getattr(vehicle, "current_status", IN_TRANSIT_TO))
        vehicle_timestamp = _as_optional_int(vehicle, "timestamp")
        vehicle_descriptor = (
            vehicle.vehicle if _has_field(vehicle, "vehicle") else None
        )
        vehicle_id = (
            str(getattr(vehicle_descriptor, "id", "") or "") or None
            if vehicle_descriptor is not None
            else None
        )
        yield VehicleObservation(
            route=route,
            direction=direction,
            trip_id=trip_id,
            stop_id=stop_id,
            current_stop_sequence=current_sequence,
            current_status=current_status,
            latitude=latitude,
            longitude=longitude,
            timestamp=float(vehicle_timestamp) if vehicle_timestamp is not None else None,
            source=part.spec.name,
            vehicle_id=vehicle_id,
            entity_id=str(getattr(entity, "id", "") or "") or None,
            trip_start_date=trip_start_date,
            trip_start_time=trip_start_time,
        )


def observations_from_snapshot(
    snapshot: FeedSnapshot,
    static: StaticGTFS,
    *,
    now: float,
    max_feed_age_seconds: float,
    future_tolerance_seconds: float,
) -> Iterable[VehicleObservation]:
    for part in snapshot.parts:
        source_timestamp = part.header_timestamp or part.received_at
        source_age = now - source_timestamp
        if source_age > max_feed_age_seconds or source_age < -future_tolerance_seconds:
            continue
        yield from observations_from_part(part, static)


def haversine_metres(
    latitude_a: float,
    longitude_a: float,
    latitude_b: float,
    longitude_b: float,
) -> float:
    radius = 6_371_000.0
    lat_a = math.radians(latitude_a)
    lat_b = math.radians(latitude_b)
    delta_lat = lat_b - lat_a
    delta_lon = math.radians(longitude_b - longitude_a)
    value = (
        math.sin(delta_lat / 2.0) ** 2
        + math.cos(lat_a) * math.cos(lat_b) * math.sin(delta_lon / 2.0) ** 2
    )
    return 2.0 * radius * math.asin(min(1.0, math.sqrt(value)))


class DirectionalStateEngine:
    def __init__(
        self,
        static: StaticGTFS,
        *,
        thresholds: StateThresholds = StateThresholds(),
        max_vehicle_age_seconds: float = 90.0,
        max_feed_age_seconds: float = 120.0,
        future_tolerance_seconds: float = 30.0,
    ):
        self.static = static
        self.thresholds = thresholds
        self.max_vehicle_age_seconds = max(1.0, float(max_vehicle_age_seconds))
        self.max_feed_age_seconds = max(1.0, float(max_feed_age_seconds))
        self.future_tolerance_seconds = max(0.0, float(future_tolerance_seconds))

    def _pattern(self, observation: VehicleObservation) -> TripPattern | None:
        if not observation.trip_id:
            return None
        return self.static.trip_for(observation.source, observation.trip_id)

    def _allowed_stations(
        self, observation: VehicleObservation, pattern: TripPattern | None
    ) -> frozenset[str]:
        if pattern and pattern.stations:
            return frozenset(pattern.stations)
        return frozenset(PCB_ROUTE_ORDERS[observation.route])

    def _reported_station(
        self, observation: VehicleObservation, pattern: TripPattern | None
    ) -> str | None:
        station = self.static.station_for_stop(
            observation.route, observation.stop_id, observation.source
        )
        if station is None and pattern and observation.current_stop_sequence is not None:
            station = pattern.station_by_sequence.get(observation.current_stop_sequence)
        if station is None:
            return None
        return station if station in self._allowed_stations(observation, pattern) else None

    def _distance_to_station(
        self, observation: VehicleObservation, station: str
    ) -> float | None:
        if observation.latitude is None or observation.longitude is None:
            return None
        position = self.static.station_positions.get(observation.route, {}).get(station)
        if position is None:
            return None
        return haversine_metres(
            observation.latitude,
            observation.longitude,
            position[0],
            position[1],
        )

    def _nearest_station(
        self, observation: VehicleObservation, pattern: TripPattern | None
    ) -> tuple[str | None, float | None]:
        if observation.latitude is None or observation.longitude is None:
            return None, None
        allowed = self._allowed_stations(observation, pattern)
        best_station: str | None = None
        best_distance: float | None = None
        for station, position in self.static.station_positions.get(
            observation.route, {}
        ).items():
            if station not in allowed:
                continue
            distance = haversine_metres(
                observation.latitude,
                observation.longitude,
                position[0],
                position[1],
            )
            if best_distance is None or distance < best_distance:
                best_station = station
                best_distance = distance
        return best_station, best_distance

    def _state(
        self,
        observation: VehicleObservation,
        *,
        reported_station: bool,
        distance: float | None,
    ) -> int:
        if observation.current_status == STOPPED_AT and reported_station:
            return 3
        if distance is not None:
            if distance <= self.thresholds.at_station_metres:
                return 3
            if distance <= self.thresholds.approaching_metres:
                return 2
            if distance <= self.thresholds.far_metres:
                return 1
            return 0
        if reported_station:
            return 2 if observation.current_status == INCOMING_AT else 1
        return 0

    @staticmethod
    def _identity_keys(observation: VehicleObservation) -> tuple[str, ...]:
        prefix = observation.source
        keys: list[str] = []
        if observation.vehicle_id:
            keys.append(f"{prefix}:vehicle:{observation.vehicle_id}")
        if observation.trip_id:
            trip_instance = "|".join(
                (
                    observation.trip_id,
                    observation.trip_start_date or "",
                    observation.trip_start_time or "",
                )
            )
            keys.append(f"{prefix}:trip:{trip_instance}")
        if observation.entity_id:
            keys.append(f"{prefix}:entity:{observation.entity_id}")
        return tuple(keys)

    @staticmethod
    def _candidate_is_better(
        candidate: _VehicleCandidate,
        existing: _VehicleCandidate,
    ) -> bool:
        candidate_timestamp = (
            candidate.observation.timestamp
            if candidate.observation.timestamp is not None
            else float("-inf")
        )
        existing_timestamp = (
            existing.observation.timestamp
            if existing.observation.timestamp is not None
            else float("-inf")
        )
        if candidate_timestamp != existing_timestamp:
            return candidate_timestamp > existing_timestamp

        candidate_sequence = (
            candidate.observation.current_stop_sequence
            if candidate.observation.current_stop_sequence is not None
            else -1
        )
        existing_sequence = (
            existing.observation.current_stop_sequence
            if existing.observation.current_stop_sequence is not None
            else -1
        )
        if candidate_sequence != existing_sequence:
            return candidate_sequence > existing_sequence

        candidate_has_distance = candidate.distance is not None
        existing_has_distance = existing.distance is not None
        if candidate_has_distance != existing_has_distance:
            return candidate_has_distance
        if (
            candidate.distance is not None
            and existing.distance is not None
            and candidate.distance != existing.distance
        ):
            return candidate.distance < existing.distance
        if candidate.reported != existing.reported:
            return candidate.reported

        candidate_tie = (
            candidate.observation.entity_id or "",
            candidate.observation.route,
            candidate.observation.direction,
            candidate.station,
        )
        existing_tie = (
            existing.observation.entity_id or "",
            existing.observation.route,
            existing.observation.direction,
            existing.station,
        )
        return candidate_tie < existing_tie

    def _deduplicate_candidates(
        self, candidates: list[_VehicleCandidate]
    ) -> list[_VehicleCandidate]:
        if len(candidates) < 2:
            return candidates

        parents = list(range(len(candidates)))

        def find(index: int) -> int:
            while parents[index] != index:
                parents[index] = parents[parents[index]]
                index = parents[index]
            return index

        def union(left: int, right: int) -> None:
            left_root = find(left)
            right_root = find(right)
            if left_root != right_root:
                parents[right_root] = left_root

        identity_owner: dict[str, int] = {}
        for index, candidate in enumerate(candidates):
            for key in candidate.identity_keys:
                owner = identity_owner.setdefault(key, index)
                union(index, owner)

        winners: dict[int, _VehicleCandidate] = {}
        for index, candidate in enumerate(candidates):
            root = find(index)
            existing = winners.get(root)
            if existing is None or self._candidate_is_better(candidate, existing):
                winners[root] = candidate
        return list(winners.values())

    def calculate(
        self,
        observations: Iterable[VehicleObservation],
        *,
        now: float,
    ) -> StateResult:
        states = empty_states()
        accepted = 0
        stale = 0
        unresolved = 0
        candidates: list[_VehicleCandidate] = []

        for observation in observations:
            if observation.route not in PCB_ROUTE_ORDERS or observation.direction not in (
                0,
                1,
            ):
                unresolved += 1
                continue
            if observation.timestamp is not None:
                age = now - observation.timestamp
                if (
                    age > self.max_vehicle_age_seconds
                    or age < -self.future_tolerance_seconds
                ):
                    stale += 1
                    continue

            pattern = self._pattern(observation)
            station = self._reported_station(observation, pattern)
            reported = station is not None
            distance = (
                self._distance_to_station(observation, station) if station else None
            )
            if station is None:
                station, distance = self._nearest_station(observation, pattern)
            if station is None:
                unresolved += 1
                continue

            state = self._state(
                observation,
                reported_station=reported,
                distance=distance,
            )
            candidates.append(
                _VehicleCandidate(
                    observation=observation,
                    station=station,
                    reported=reported,
                    distance=distance,
                    state=state,
                    identity_keys=self._identity_keys(observation),
                )
            )

        for candidate in self._deduplicate_candidates(candidates):
            observation = candidate.observation
            if candidate.state <= 0:
                continue
            states[observation.route][candidate.station][observation.direction] = max(
                states[observation.route][candidate.station][observation.direction],
                candidate.state,
            )
            accepted += 1

        return StateResult(
            states=states,
            accepted_vehicles=accepted,
            stale_vehicles=stale,
            unresolved_vehicles=unresolved,
        )
