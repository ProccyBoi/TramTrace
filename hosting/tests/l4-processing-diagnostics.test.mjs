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

function tripDescriptor({ tripId, directionId }) {
  const fields = [];
  if (tripId) {
    fields.push(stringField(1, tripId));
  }
  if (directionId !== undefined) {
    fields.push(varintField(6, directionId));
  }
  return Buffer.concat(fields);
}

function vehiclePosition({
  tripId,
  directionId,
  latitude,
  longitude,
  stopSequence,
  currentStatus,
  timestamp,
  stopId,
  vehicleId,
}) {
  const fields = [
    bytesField(1, tripDescriptor({ tripId, directionId })),
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
  const originalLog = console.log;
  const logs = [];
  globalThis.fetch = async (input) => {
    fetchCount += 1;
    const url = String(input);
    return new Response(url.includes("parramatta") ? l4Feed : emptyFeed, {
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
    assert.equal(fetchCount, 3);

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
    assert.equal(fetchCount, 3);
    const healthText = await healthResponse.text();
    assert.doesNotMatch(
      healthText,
      /active-a|tram-a|live-trip|test-token|test-board/,
    );
    const health = JSON.parse(healthText);
    const healthDiagnostic = { ...diagnostic };
    delete healthDiagnostic.event;
    delete healthDiagnostic.feed_age_seconds;
    assert.deepEqual(health.l4_processing, healthDiagnostic);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
