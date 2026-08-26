import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateVehicleCandidates } from "../worker/vehicle-dedupe.ts";

function candidate(overrides = {}) {
  return {
    identityKeys: [],
    route: "L1",
    direction: 0,
    stationIndex: 0,
    stationName: "Central",
    reported: true,
    distance: null,
    state: 3,
    timestamp: 100,
    currentStopSequence: 1,
    entityId: "record-a",
    ...overrides,
  };
}

test("one vehicle can win only one station regardless of feed order", () => {
  const older = candidate({
    identityKeys: ["innerwest:vehicle:118466", "innerwest:trip:trip-1||"],
    stationIndex: 0,
    stationName: "Central",
    timestamp: 100,
    currentStopSequence: 1,
    entityId: "older",
  });
  const newer = candidate({
    identityKeys: ["innerwest:vehicle:118466", "innerwest:trip:trip-1||"],
    stationIndex: 1,
    stationName: "Bank Street",
    timestamp: 101,
    currentStopSequence: 2,
    entityId: "newer",
  });

  assert.deepEqual(
    deduplicateVehicleCandidates([older, newer]).map(
      (item) => item.stationName,
    ),
    ["Bank Street"],
  );
  assert.deepEqual(
    deduplicateVehicleCandidates([newer, older]).map(
      (item) => item.stationName,
    ),
    ["Bank Street"],
  );
});

test("vehicle and trip aliases reconcile mixed duplicate records", () => {
  const winner = candidate({
    identityKeys: ["source:vehicle:beacon", "source:trip:run||"],
    stationName: "Winner",
    timestamp: 103,
  });
  const tripOnly = candidate({
    identityKeys: ["source:trip:run||"],
    stationName: "Trip duplicate",
    timestamp: 102,
  });
  const vehicleOnly = candidate({
    identityKeys: ["source:vehicle:beacon"],
    stationName: "Vehicle duplicate",
    timestamp: 101,
  });

  assert.deepEqual(
    deduplicateVehicleCandidates([tripOnly, vehicleOnly, winner]).map(
      (item) => item.stationName,
    ),
    ["Winner"],
  );
});

test("newer inactive observation suppresses an older lit ghost", () => {
  const older = candidate({
    identityKeys: ["source:vehicle:beacon"],
    stationName: "Old station",
    state: 3,
    timestamp: 100,
  });
  const newest = candidate({
    identityKeys: ["source:vehicle:beacon"],
    stationName: "No longer in range",
    state: 0,
    timestamp: 101,
  });

  const [winner] = deduplicateVehicleCandidates([older, newest]);
  assert.equal(winner.state, 0);
  assert.equal(winner.stationName, "No longer in range");
});

test("distinct and unidentified vehicles are never collapsed", () => {
  const distinct = deduplicateVehicleCandidates([
    candidate({
      identityKeys: ["source:vehicle:a"],
      stationName: "A",
    }),
    candidate({
      identityKeys: ["source:vehicle:b"],
      stationName: "B",
    }),
  ]);
  assert.equal(distinct.length, 2);

  const unidentified = deduplicateVehicleCandidates([
    candidate({ identityKeys: [], stationName: "Anonymous A" }),
    candidate({ identityKeys: [], stationName: "Anonymous B" }),
  ]);
  assert.equal(unidentified.length, 2);
});

test("equal timestamps deterministically prefer the later stop sequence", () => {
  const earlier = candidate({
    identityKeys: ["source:trip:run||"],
    stationName: "Earlier",
    currentStopSequence: 4,
  });
  const later = candidate({
    identityKeys: ["source:trip:run||"],
    stationName: "Later",
    currentStopSequence: 5,
    state: 1,
  });

  const [winner] = deduplicateVehicleCandidates([earlier, later]);
  assert.equal(winner.stationName, "Later");
  assert.equal(winner.state, 1);
});

test("an extended-range L4 vehicle still wins only one station", () => {
  const oldStation = candidate({
    identityKeys: ["parramatta:vehicle:lrv-42"],
    route: "L4",
    stationIndex: 0,
    stationName: "Carlingford",
    distance: 100,
    state: 3,
    timestamp: 100,
    currentStopSequence: 1,
  });
  const reportedNextStation = candidate({
    identityKeys: ["parramatta:vehicle:lrv-42"],
    route: "L4",
    stationIndex: 1,
    stationName: "Telopea",
    distance: 1_490,
    state: 1,
    timestamp: 101,
    currentStopSequence: 2,
  });

  const winners = deduplicateVehicleCandidates([
    oldStation,
    reportedNextStation,
  ]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].stationName, "Telopea");
});
