import assert from "node:assert/strict";
import test from "node:test";

import { selectTripUpdateStop } from "../worker/l4-trip-update.ts";

const window = {
  atStationSeconds: 15,
  approachingSeconds: 45,
  farSeconds: 90,
};
const mappedStops = new Set(["stop-a", "stop-b", "stop-c"]);
const isMappedStop = (stopId) => mappedStops.has(stopId);

function tripUpdate(overrides = {}) {
  return {
    entityId: "entity-a",
    trip: {
      tripId: "trip-a",
      directionId: 0,
      ...overrides.trip,
    },
    timestamp: 1_000,
    vehicleId: "tram-a",
    stopTimeUpdates: overrides.stopTimeUpdates || [],
  };
}

test("selects exactly one closest upcoming mapped stop", () => {
  const selected = selectTripUpdateStop(
    tripUpdate({
      stopTimeUpdates: [
        {
          stopSequence: 4,
          arrivalTime: 980,
          departureTime: 990,
          stopId: "stop-a",
        },
        {
          stopSequence: 5,
          arrivalTime: 1_030,
          departureTime: 1_040,
          stopId: "stop-b",
        },
        {
          stopSequence: 6,
          arrivalTime: 1_060,
          departureTime: 1_070,
          stopId: "stop-c",
        },
      ],
    }),
    1_000,
    window,
    isMappedStop,
  );

  assert.deepEqual(selected, {
    stopId: "stop-b",
    stopSequence: 5,
    arrivalTime: 1_030,
    departureTime: 1_040,
    state: 2,
  });
});

test("prioritizes a currently dwelling stop over an upcoming stop", () => {
  const selected = selectTripUpdateStop(
    tripUpdate({
      stopTimeUpdates: [
        {
          stopSequence: 4,
          arrivalTime: 990,
          departureTime: 1_010,
          stopId: "stop-a",
        },
        {
          stopSequence: 5,
          arrivalTime: 1_005,
          departureTime: 1_015,
          stopId: "stop-b",
        },
      ],
    }),
    1_000,
    window,
    isMappedStop,
  );

  assert.deepEqual(selected, {
    stopId: "stop-a",
    stopSequence: 4,
    arrivalTime: 990,
    departureTime: 1_010,
    state: 3,
  });

  const implausiblyLongDwell = selectTripUpdateStop(
    tripUpdate({
      stopTimeUpdates: [
        {
          stopSequence: 3,
          arrivalTime: 900,
          departureTime: 1_010,
          stopId: "stop-a",
        },
      ],
    }),
    1_000,
    window,
    isMappedStop,
  );
  assert.equal(implausiblyLongDwell, null);
});

test("applies the strict 15/45/90-second state window", () => {
  const selectedAt = (arrivalTime) =>
    selectTripUpdateStop(
      tripUpdate({
        stopTimeUpdates: [
          {
            arrivalTime,
            stopId: "stop-a",
          },
        ],
      }),
      1_000,
      window,
      isMappedStop,
    );

  assert.equal(selectedAt(1_015)?.state, 3);
  assert.equal(selectedAt(1_016)?.state, 2);
  assert.equal(selectedAt(1_045)?.state, 2);
  assert.equal(selectedAt(1_046)?.state, 1);
  assert.equal(selectedAt(1_090)?.state, 1);
  assert.equal(selectedAt(1_091), null);
});

test("rejects canceled trips", () => {
  const selected = selectTripUpdateStop(
    tripUpdate({
      trip: { scheduleRelationship: 3 },
      stopTimeUpdates: [
        { arrivalTime: 1_030, stopId: "stop-a" },
      ],
    }),
    1_000,
    window,
    isMappedStop,
  );

  assert.equal(selected, null);
});

test("rejects skipped, no-data, and unscheduled stop updates", () => {
  const selected = selectTripUpdateStop(
    tripUpdate({
      stopTimeUpdates: [1, 2, 3].map((scheduleRelationship, index) => ({
        arrivalTime: 1_020 + index,
        stopId: ["stop-a", "stop-b", "stop-c"][index],
        scheduleRelationship,
      })),
    }),
    1_000,
    window,
    isMappedStop,
  );

  assert.equal(selected, null);
});

test("requires absolute event times and accepts a departure-only time", () => {
  const relativeOnly = selectTripUpdateStop(
    tripUpdate({
      stopTimeUpdates: [
        {
          stopSequence: 5,
          arrivalDelay: 30,
          departureDelay: 35,
          stopId: "stop-b",
        },
      ],
    }),
    1_000,
    window,
    isMappedStop,
  );
  const departureOnly = selectTripUpdateStop(
    tripUpdate({
      stopTimeUpdates: [
        {
          stopSequence: 5,
          departureTime: 1_030,
          stopId: "stop-b",
        },
      ],
    }),
    1_000,
    window,
    isMappedStop,
  );

  assert.equal(relativeOnly, null);
  assert.deepEqual(departureOnly, {
    stopId: "stop-b",
    stopSequence: 5,
    arrivalTime: 1_030,
    departureTime: 1_030,
    state: 2,
  });
});
