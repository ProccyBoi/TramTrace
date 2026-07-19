import assert from "node:assert/strict";
import test from "node:test";

import { decodeFeedMessage } from "../worker/gtfs-realtime.ts";

// Generated from the standard GTFS-Realtime schema. It contains one CSELR L2
// vehicle with trip, direction, coordinates, stop sequence/status and timestamp.
const VEHICLE_FIXTURE =
  "CgsKAzIuMBigrfDSBhI6CgJ2MSI0ChQKBnRyaXAtMSoIQ1NFTFJfTDIwARIKDR+FB8IVwzUXQxgMIAEonq3w0gY6BnN0b3AtMQ==";

test("decodes the GTFS-Realtime vehicle fields TramTrace uses", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(VEHICLE_FIXTURE, "base64")),
  );

  assert.equal(decoded.headerTimestamp, 1_784_420_000);
  assert.equal(decoded.vehicles.length, 1);
  const vehicle = decoded.vehicles[0];
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

test("rejects truncated protobuf input", () => {
  assert.throws(
    () => decodeFeedMessage(Uint8Array.from([0x0a, 0x08, 0x1a])),
    /truncated protobuf/,
  );
});
