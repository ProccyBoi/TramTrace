import assert from "node:assert/strict";
import test from "node:test";

import { decodeFeedMessage } from "../worker/gtfs-realtime.ts";

// Generated from the standard GTFS-Realtime schema. It contains one CSELR L2
// vehicle with trip, direction, coordinates, stop sequence/status and timestamp.
const VEHICLE_FIXTURE =
  "CgsKAzIuMBigrfDSBhI6CgJ2MSI0ChQKBnRyaXAtMSoIQ1NFTFJfTDIwARIKDR+FB8IVwzUXQxgMIAEonq3w0gY6BnN0b3AtMQ==";
const IDENTIFIED_VEHICLE_FIXTURE =
  "CgsKAzIuMBiErvDSBhJQCghyZWNvcmQtMiJECigKBnRyaXAtMhIIMTI6MzQ6MDAaCDIwMjYwNzIwKghDU0VMUl9MMzAAGA0og67w0gY6BnN0b3AtMkIICgYxMTg0NjY=";

test("decodes the GTFS-Realtime vehicle fields TramTrace uses", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(VEHICLE_FIXTURE, "base64")),
  );

  assert.equal(decoded.headerTimestamp, 1_784_420_000);
  assert.equal(decoded.vehicles.length, 1);
  const vehicle = decoded.vehicles[0];
  assert.equal(vehicle.entityId, "v1");
  assert.deepEqual(vehicle.trip, {
    tripId: "trip-1",
    routeId: "CSELR_L2",
    directionId: 1,
  });
  assert.equal(vehicle.currentStopSequence, 12);
  assert.equal(vehicle.stopId, "stop-1");
  assert.equal(vehicle.currentStatus, 1);
  assert.equal(vehicle.timestamp, 1_784_419_998);
  assert.ok(Math.abs(vehicle.latitude - -33.88) < 0.00001);
  assert.ok(Math.abs(vehicle.longitude - 151.21) < 0.00001);
});

test("decodes stable vehicle and trip-instance identifiers", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(IDENTIFIED_VEHICLE_FIXTURE, "base64")),
  );

  assert.equal(decoded.vehicles.length, 1);
  const vehicle = decoded.vehicles[0];
  assert.equal(vehicle.entityId, "record-2");
  assert.equal(vehicle.vehicleId, "118466");
  assert.deepEqual(vehicle.trip, {
    tripId: "trip-2",
    startTime: "12:34:00",
    startDate: "20260720",
    routeId: "CSELR_L3",
    directionId: 0,
  });
});

test("rejects truncated protobuf input", () => {
  assert.throws(
    () => decodeFeedMessage(Uint8Array.from([0x0a, 0x08, 0x1a])),
    /truncated protobuf/,
  );
});
