import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transitDataUrl = new URL(
  "../worker/generated-transit-data.json",
  import.meta.url,
);

function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function tag(field, wire) {
  return varint(field * 8 + wire);
}

function bytesField(field, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
}

function stringField(field, value) {
  return bytesField(field, Buffer.from(value, "utf8"));
}

function varintField(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function floatField(field, value) {
  const bytes = Buffer.alloc(4);
  bytes.writeFloatLE(value);
  return Buffer.concat([tag(field, 5), bytes]);
}

function tripDescriptor({
  tripId,
  directionId,
  startTime,
  startDate,
  scheduleRelationship,
  routeId,
}) {
  const fields = [];
  if (tripId) {
    fields.push(stringField(1, tripId));
  }
  if (startTime) {
    fields.push(stringField(2, startTime));
  }
  if (startDate) {
    fields.push(stringField(3, startDate));
  }
  if (scheduleRelationship !== undefined) {
    fields.push(varintField(4, scheduleRelationship));
  }
  if (routeId) {
    fields.push(stringField(5, routeId));
  }
  if (directionId !== undefined) {
    fields.push(varintField(6, directionId));
  }
  return Buffer.concat(fields);
}

function vehiclePosition({
  tripId,
  directionId,
  startTime,
  startDate,
  latitude,
  longitude,
  stopSequence,
  currentStatus,
  timestamp,
  stopId,
  vehicleId,
}) {
  const fields = [
    bytesField(
      1,
      tripDescriptor({ tripId, directionId, startTime, startDate }),
    ),
  ];
  if (latitude !== undefined && longitude !== undefined) {
    fields.push(
      bytesField(
        2,
        Buffer.concat([
          floatField(1, latitude),
          floatField(2, longitude),
        ]),
      ),
    );
  }
  if (stopSequence !== undefined) {
    fields.push(varintField(3, stopSequence));
  }
  if (currentStatus !== undefined) {
    fields.push(varintField(4, currentStatus));
  }
  if (timestamp !== undefined) {
    fields.push(varintField(5, timestamp));
  }
  if (stopId) {
    fields.push(stringField(7, stopId));
  }
  if (vehicleId) {
    fields.push(bytesField(8, stringField(1, vehicleId)));
  }
  return Buffer.concat(fields);
}

function entity(entityId, vehicle) {
  const fields = [];
  if (entityId) {
    fields.push(stringField(1, entityId));
  }
  fields.push(bytesField(4, vehiclePosition(vehicle)));
  return Buffer.concat(fields);
}

function stopTimeUpdate({
  stopSequence,
  arrivalTime,
  departureTime,
  stopId,
  scheduleRelationship,
}) {
  const fields = [];
  if (stopSequence !== undefined) {
    fields.push(varintField(1, stopSequence));
  }
  if (arrivalTime !== undefined) {
    fields.push(bytesField(2, varintField(2, arrivalTime)));
  }
  if (departureTime !== undefined) {
    fields.push(bytesField(3, varintField(2, departureTime)));
  }
  if (stopId) {
    fields.push(stringField(4, stopId));
  }
  if (scheduleRelationship !== undefined) {
    fields.push(varintField(5, scheduleRelationship));
  }
  return Buffer.concat(fields);
}

function tripUpdateEntity({
  entityId,
  trip,
  stopTimeUpdates,
  vehicleId,
  timestamp,
}) {
  const tripUpdateFields = [bytesField(1, tripDescriptor(trip))];
  for (const update of stopTimeUpdates) {
    tripUpdateFields.push(bytesField(2, stopTimeUpdate(update)));
  }
  if (vehicleId) {
    tripUpdateFields.push(bytesField(3, stringField(1, vehicleId)));
  }
  if (timestamp !== undefined) {
    tripUpdateFields.push(varintField(4, timestamp));
  }
  return Buffer.concat([
    stringField(1, entityId),
    bytesField(3, Buffer.concat(tripUpdateFields)),
  ]);
}

function feedMessage(timestamp, entities) {
  return Buffer.concat([
    bytesField(1, varintField(3, timestamp)),
    ...entities.map((value) => bytesField(2, value)),
  ]);
}

test("reports the exact L4 processing funnel without another upstream fetch", async () => {
  const transitData = JSON.parse(await readFile(transitDataUrl, "utf8"));
  const station = transitData.routes.L4.stations[0];
  const nextStation = transitData.routes.L4.stations[1];
  const stops = transitData.sources.parramatta.stops.L4;
  const stopId = Object.keys(stops).find((key) => stops[key] === 0);
  const nextStopId = Object.keys(stops).find((key) => stops[key] === 1);
  assert.ok(stopId);
  assert.ok(nextStopId);

  const now = Math.floor(Date.now() / 1000);
  const l4Feed = feedMessage(now, [
    entity("active-a", {
      tripId: "live-trip",
      directionId: 0,
      latitude: station[1],
      longitude: station[2],
      stopSequence: 1,
      currentStatus: 1,
      timestamp: now,
      stopId,
      vehicleId: "tram-a",
    }),
    entity("active-a-newer-record", {
      tripId: "live-trip",
      directionId: 0,
      latitude: nextStation[1],
      longitude: nextStation[2],
      stopSequence: 2,
      currentStatus: 1,
      timestamp: now,
      stopId: nextStopId,
      vehicleId: "tram-a",
    }),
    entity("stale", {
      directionId: 0,
      timestamp: now - 120,
      stopId,
    }),
    entity("unknown-direction", {
      tripId: "trip-not-in-static-data",
      timestamp: now,
      stopId,
    }),
    entity("no-station", {
      directionId: 0,
      timestamp: now,
    }),
    entity(null, {
      directionId: 0,
      latitude: 0,
      longitude: 0,
      timestamp: now,
    }),
  ]);
  const emptyFeed = feedMessage(now, []);
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalLog = console.log;
  const logs = [];
  const edgeEntries = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        return edgeEntries.get(request.url)?.clone();
      },
      async put(request, response) {
        edgeEntries.set(request.url, response.clone());
      },
    },
  };
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    const url = String(input);
    return new Response(url.includes("vehiclepos/lightrail/parramatta") ? l4Feed : emptyFeed, {
      status: 200,
      headers: { "Content-Type": "application/x-protobuf" },
    });
  };
  console.log = (...values) => logs.push(values.join(" "));

  try {
    const workerUrl = new URL(
      `../dist/server/index.js?diagnostics=${Date.now()}`,
      import.meta.url,
    );
    const worker = (await import(workerUrl.href)).default;
    const env = {
      TFNSW_API_TOKEN: "test-token",
      TRAMTRACE_BOARD_KEY: "test-board",
      TRAMTRACE_MAX_VEHICLE_AGE_SECONDS: "90",
      TRAMTRACE_FUTURE_TOLERANCE_SECONDS: "30",
    };
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    };
    const payloadResponse = await worker.fetch(
      new Request(
        "https://tramtrace.test/tramtrace_payload?board_id=test-board",
      ),
      env,
      context,
    );
    assert.equal(payloadResponse.status, 200);
    assert.equal(fetchCount, 4);
    const cachedPayloadResponse = await worker.fetch(
      new Request(
        "https://tramtrace.test/tramtrace_payload?board_id=test-board",
      ),
      env,
      context,
    );
    assert.equal(cachedPayloadResponse.status, 200);
    assert.equal(fetchCount, 4);
    const unauthorizedCachedResponse = await worker.fetch(
      new Request(
        "https://tramtrace.test/tramtrace_payload?board_id=wrong-board",
      ),
      env,
      context,
    );
    assert.equal(unauthorizedCachedResponse.status, 401);
    assert.equal(fetchCount, 4);

    const diagnosticLog = logs.find((line) =>
      line.includes('"event":"tramtrace_l4_processing"'),
    );
    assert.ok(diagnosticLog);
    const diagnostic = JSON.parse(diagnosticLog);
    assert.deepEqual(
      {
        raw: diagnostic.raw_vehicle_records,
        accepted: diagnostic.age_accepted_records,
        resolved: diagnostic.resolved_route_direction_records,
        reported: diagnostic.reported_station_records,
        nearest: diagnostic.nearest_station_records,
        candidates: diagnostic.candidate_records,
        unidentified: diagnostic.unidentified_candidate_records,
        states: diagnostic.candidate_state_records,
        unique: diagnostic.unique_vehicle_records,
        dark: diagnostic.dark_unique_vehicle_records,
        visible: diagnostic.visible_vehicle_records,
        slots: diagnostic.active_station_direction_slots,
        coalesced: diagnostic.coalesced_visible_vehicle_records,
        filtered: diagnostic.filtered,
      },
      {
        raw: 6,
        accepted: 5,
        resolved: 4,
        reported: 2,
        nearest: 1,
        candidates: 3,
        unidentified: 1,
        states: { off: 1, far: 0, approaching: 0, at_station: 2 },
        unique: 2,
        dark: 1,
        visible: 1,
        slots: 1,
        coalesced: 0,
        filtered: {
          deleted_records: 0,
          stale_records: 1,
          future_records: 0,
          unresolved_route_or_direction_records: 1,
          no_station_records: 1,
          unknown_station_records: 0,
          outside_visibility_range_records: 1,
          outside_reported_station_range_records: 0,
          outside_nearest_station_range_records: 1,
          duplicate_records: 1,
        },
      },
    );

    const healthResponse = await worker.fetch(
      new Request("https://tramtrace.test/healthz"),
      env,
      context,
    );
    assert.equal(healthResponse.status, 200);
    assert.equal(fetchCount, 4);
    const healthText = await healthResponse.text();
    assert.doesNotMatch(
      healthText,
      /active-a|tram-a|live-trip|test-token|test-board/,
    );
    const health = JSON.parse(healthText);
    const healthDiagnostic = { ...diagnostic };
    delete healthDiagnostic.event;
    delete healthDiagnostic.feed_age_seconds;
    delete healthDiagnostic.trip_update_feed_age_seconds;
    assert.deepEqual(health.l4_processing, healthDiagnostic);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
    console.log = originalLog;
  }
});

test("uses one close Trip Update stop when the matching L4 position is stale", async () => {
  const transitData = JSON.parse(await readFile(transitDataUrl, "utf8"));
  const tripId = "42686-10007:1000";
  const firstStation = transitData.routes.L4.stations[0];
  const secondStation = transitData.routes.L4.stations[1];
  const stops = transitData.sources.parramatta.stops.L4;
  const firstStopId = Object.keys(stops).find((key) => stops[key] === 0);
  const secondStopId = Object.keys(stops).find((key) => stops[key] === 1);
  assert.ok(firstStopId);
  assert.ok(secondStopId);

  const now = Math.floor(Date.now() / 1000);
  const l4VehicleFeed = feedMessage(now, [
    entity("stale-position", {
      tripId,
      currentStatus: 1,
      timestamp: now - 120,
      stopId: secondStopId,
      vehicleId: "tram-fallback",
    }),
  ]);
  const l4TripUpdateFeed = feedMessage(now, [
    tripUpdateEntity({
      entityId: "fallback-update",
      trip: { tripId },
      vehicleId: "tram-fallback",
      timestamp: now,
      stopTimeUpdates: [
        {
          stopSequence: 5,
          arrivalTime: now + 30,
          departureTime: now + 40,
          stopId: firstStopId,
        },
        {
          stopSequence: 4,
          arrivalTime: now + 60,
          departureTime: now + 70,
          stopId: secondStopId,
        },
      ],
    }),
  ]);
  const emptyFeed = feedMessage(now, []);
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalLog = console.log;
  const edgeEntries = new Map();
  const logs = [];
  let fetchCount = 0;
  globalThis.caches = {
    default: {
      async match(request) {
        return edgeEntries.get(request.url)?.clone();
      },
      async put(request, response) {
        edgeEntries.set(request.url, response.clone());
      },
    },
  };
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    const url = String(input);
    const body = url.includes("vehiclepos/lightrail/parramatta")
      ? l4VehicleFeed
      : url.includes("realtime/lightrail/parramatta")
        ? l4TripUpdateFeed
        : emptyFeed;
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/x-protobuf" },
    });
  };
  console.log = (...values) => logs.push(values.join(" "));

  try {
    const workerUrl = new URL(
      `../dist/server/index.js?fallback=${Date.now()}`,
      import.meta.url,
    );
    const worker = (await import(workerUrl.href)).default;
    const env = {
      TFNSW_API_TOKEN: "fallback-token",
      TRAMTRACE_BOARD_KEY: "fallback-board",
      TRAMTRACE_MAX_VEHICLE_AGE_SECONDS: "90",
    };
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    };
    const requestUrl =
      "https://fallback.test/tramtrace_payload?board_id=fallback-board";
    const response = await worker.fetch(
      new Request(requestUrl),
      env,
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(fetchCount, 4);
    const payload = await response.json();
    assert.deepEqual(payload.states.L4[firstStation[0]], [0, 2]);
    assert.deepEqual(payload.states.L4[secondStation[0]], [0, 0]);
    assert.equal(
      Object.values(payload.states.L4).filter(
        (directions) => directions[0] > 0 || directions[1] > 0,
      ).length,
      1,
    );

    const diagnostic = JSON.parse(
      logs.find((line) =>
        line.includes('"event":"tramtrace_l4_processing"'),
      ),
    );
    assert.equal(diagnostic.raw_vehicle_records, 1);
    assert.equal(diagnostic.filtered.stale_records, 1);
    assert.equal(diagnostic.trip_update_fallback.feed_records, 1);
    assert.equal(diagnostic.trip_update_fallback.close_stop_records, 1);
    assert.equal(diagnostic.trip_update_fallback.candidate_records, 1);
    assert.equal(
      diagnostic.trip_update_fallback
        .suppressed_by_fresh_vehicle_position_records,
      0,
    );
    assert.equal(diagnostic.active_station_direction_slots, 1);

    const cachedResponse = await worker.fetch(
      new Request(requestUrl),
      env,
      context,
    );
    assert.equal(cachedResponse.status, 200);
    assert.equal(fetchCount, 4);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
    console.log = originalLog;
  }
});

test("fresh dark L4 positions retain authority over Trip Updates", async () => {
  const transitData = JSON.parse(await readFile(transitDataUrl, "utf8"));
  const tripId = "42686-10007:1000";
  const conflictingTripId = "42686-10013:1000";
  const stops = transitData.sources.parramatta.stops.L4;
  const stopId = Object.keys(stops).find((key) => stops[key] === 0);
  assert.ok(stopId);

  const now = Math.floor(Date.now() / 1000);
  const l4VehicleFeed = feedMessage(now, [
    entity("fresh-position", {
      tripId,
      latitude: 0,
      longitude: 0,
      currentStatus: 2,
      timestamp: now,
      stopId,
      vehicleId: "tram-authority",
    }),
    entity("conflicting-instance-position", {
      tripId: conflictingTripId,
      startDate: "20260727",
      latitude: 0,
      longitude: 0,
      currentStatus: 2,
      timestamp: now,
      stopId,
      vehicleId: "position-only-identity",
    }),
  ]);
  const l4TripUpdateFeed = feedMessage(now, [
    tripUpdateEntity({
      entityId: "suppressed-update",
      trip: { tripId },
      vehicleId: "tram-authority",
      timestamp: now,
      stopTimeUpdates: [
        {
          stopSequence: 5,
          arrivalTime: now + 30,
          departureTime: now + 40,
          stopId,
        },
      ],
    }),
    tripUpdateEntity({
      entityId: "ambiguous-instance-update",
      trip: {
        tripId: conflictingTripId,
        startDate: "20260728",
      },
      vehicleId: "update-only-identity",
      timestamp: now,
      stopTimeUpdates: [
        {
          stopSequence: 5,
          arrivalTime: now + 30,
          departureTime: now + 40,
          stopId,
        },
      ],
    }),
  ]);
  const emptyFeed = feedMessage(now, []);
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originalLog = console.log;
  const edgeEntries = new Map();
  const logs = [];
  let fetchCount = 0;
  globalThis.caches = {
    default: {
      async match(request) {
        return edgeEntries.get(request.url)?.clone();
      },
      async put(request, response) {
        edgeEntries.set(request.url, response.clone());
      },
    },
  };
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    const url = String(input);
    const body = url.includes("vehiclepos/lightrail/parramatta")
      ? l4VehicleFeed
      : url.includes("realtime/lightrail/parramatta")
        ? l4TripUpdateFeed
        : emptyFeed;
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/x-protobuf" },
    });
  };
  console.log = (...values) => logs.push(values.join(" "));

  try {
    const workerUrl = new URL(
      `../dist/server/index.js?suppression=${Date.now()}`,
      import.meta.url,
    );
    const worker = (await import(workerUrl.href)).default;
    const env = {
      TFNSW_API_TOKEN: "suppression-token",
      TRAMTRACE_BOARD_KEY: "suppression-board",
    };
    const context = {
      waitUntil() {},
      passThroughOnException() {},
    };
    const response = await worker.fetch(
      new Request(
        "https://suppression.test/tramtrace_payload?board_id=suppression-board",
      ),
      env,
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(fetchCount, 4);
    const payload = await response.json();
    assert.equal(
      Object.values(payload.states.L4).filter(
        (directions) => directions[0] > 0 || directions[1] > 0,
      ).length,
      0,
    );

    const diagnostic = JSON.parse(
      logs.find((line) =>
        line.includes('"event":"tramtrace_l4_processing"'),
      ),
    );
    assert.equal(diagnostic.candidate_state_records.off, 2);
    assert.equal(diagnostic.trip_update_fallback.candidate_records, 0);
    assert.equal(
      diagnostic.trip_update_fallback
        .suppressed_by_fresh_vehicle_position_records,
      1,
    );
    assert.equal(
      diagnostic.trip_update_fallback.filtered
        .ambiguous_identity_records,
      1,
    );
    assert.equal(diagnostic.active_station_direction_slots, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
    console.log = originalLog;
  }
});
