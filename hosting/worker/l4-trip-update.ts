import type { StopTimeUpdate, TripUpdate } from "./gtfs-realtime";

export interface TripUpdateWindow {
  atStationSeconds: number;
  approachingSeconds: number;
  farSeconds: number;
}

export interface SelectedTripUpdateStop {
  stopId: string;
  stopSequence?: number;
  arrivalTime: number;
  departureTime: number;
  state: 1 | 2 | 3;
}

function usableStopTime(
  update: StopTimeUpdate,
  isMappedStop: (stopId: string) => boolean,
): {
  stopId: string;
  stopSequence?: number;
  arrivalTime: number;
  departureTime: number;
} | null {
  if (
    !update.stopId ||
    !isMappedStop(update.stopId) ||
    (update.scheduleRelationship !== undefined &&
      update.scheduleRelationship !== 0)
  ) {
    return null;
  }
  const eventTime = update.arrivalTime ?? update.departureTime;
  if (eventTime === undefined) {
    return null;
  }
  const arrivalTime = update.arrivalTime ?? eventTime;
  const departureTime = Math.max(
    arrivalTime,
    update.departureTime ?? eventTime,
  );
  return {
    stopId: update.stopId,
    stopSequence: update.stopSequence,
    arrivalTime,
    departureTime,
  };
}

export function selectTripUpdateStop(
  update: TripUpdate,
  now: number,
  window: TripUpdateWindow,
  isMappedStop: (stopId: string) => boolean,
): SelectedTripUpdateStop | null {
  if (
    update.trip?.scheduleRelationship !== undefined &&
    update.trip.scheduleRelationship !== 0
  ) {
    return null;
  }

  const candidates = update.stopTimeUpdates
    .map((stopTime) => usableStopTime(stopTime, isMappedStop))
    .filter((stopTime) => stopTime !== null)
    .filter(
      (stopTime) =>
        stopTime.departureTime >= now &&
        stopTime.arrivalTime >= now - window.farSeconds &&
        stopTime.arrivalTime <= now + window.farSeconds,
    );
  const dwelling = candidates
    .filter(
      (stopTime) =>
        stopTime.arrivalTime <= now && stopTime.departureTime >= now,
    )
    .sort(
      (left, right) =>
        (right.stopSequence ?? Number.MIN_SAFE_INTEGER) -
          (left.stopSequence ?? Number.MIN_SAFE_INTEGER) ||
        right.arrivalTime - left.arrivalTime,
    )[0];
  const candidate =
    dwelling ||
    candidates.sort(
      (left, right) =>
        left.arrivalTime - right.arrivalTime ||
        (left.stopSequence ?? Number.MAX_SAFE_INTEGER) -
          (right.stopSequence ?? Number.MAX_SAFE_INTEGER),
    )[0];
  if (!candidate) {
    return null;
  }

  const secondsUntilArrival = candidate.arrivalTime - now;
  let state: 1 | 2 | 3 = 1;
  if (
    candidate.arrivalTime <= now ||
    secondsUntilArrival <= window.atStationSeconds
  ) {
    state = 3;
  } else if (secondsUntilArrival <= window.approachingSeconds) {
    state = 2;
  }
  return { ...candidate, state };
}
