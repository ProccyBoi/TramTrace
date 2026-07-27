import assert from "node:assert/strict";
import test from "node:test";

import { decodeFeedMessage } from "../worker/gtfs-realtime.ts";

// Generated from the standard GTFS-Realtime schema. It contains one CSELR L2
// vehicle with trip, direction, coordinates, stop sequence/status and timestamp.
const VEHICLE_FIXTURE =
  "CgsKAzIuMBigrfDSBhI6CgJ2MSI0ChQKBnRyaXAtMSoIQ1NFTFJfTDIwARIKDR+FB8IVwzUXQxgMIAEonq3w0gY6BnN0b3AtMQ==";
const IDENTIFIED_VEHICLE_FIXTURE =
  "CgsKAzIuMBiErvDSBhJQCghyZWNvcmQtMiJECigKBnRyaXAtMhIIMTI6MzQ6MDAaCDIwMjYwNzIwKghDU0VMUl9MMzAAGA0og67w0gY6BnN0b3AtMkIICgYxMTg0NjY=";
// One canceled L4 TripUpdate with two stop-time updates. It exercises both
// event times, every retained TripDescriptor field and an optional vehicle ID.
const TRIP_UPDATE_FIXTURE =
  "Cg0KAzIuMBAAGKCt8NIGEpQBCgt0dS1yZWNvcmQtMRAAGoIBCjoKEDQyNjg2LTEwMDIwOjEwMDASCDEyOjM0OjAwGggyMDI2MDcyNyADKg5JU0QtMTctNjcyMF9MNDAAEh0ICBIGEISu8NIGGgYQoq7w0gYiBzIxNTAxMzIoABIVCAkSBhCwsPDSBiIHMjE1MDEzNSgBGggKBjExODQ2NiClrfDSBg==";
// A deliberately sparse TripUpdate proves that the vehicle descriptor,
// arrival event and TripUpdate timestamp remain optional.
const MINIMAL_TRIP_UPDATE_FIXTURE =
  "CgUKAzIuMBI2Cgt0dS1yZWNvcmQtMhonCg4KDG1pbmltYWwtdHJpcBIVCAoaBhCUsfDSBiIHMjE1MDE0OSgC";
// A differential feed containing one deleted TripUpdate and one deleted
// VehiclePosition verifies FeedEntity.is_deleted propagation for both types.
const DELETED_DIFFERENTIAL_FIXTURE =
  "Cg0KAzIuMBABGPix8NIGEjIKCmRlbGV0ZWQtdHUQARoiCiAKDGRlbGV0ZWQtdHJpcCoOSVNELTE3LTY3MjBfTDQwARJhCgpkZWxldGVkLXZwEAEiUQooChRkZWxldGVkLXZlaGljbGUtdHJpcCoOSVNELTE3LTY3MjBfTDQwACACKPOx8NIGOgcyMTUwMTMyQhQKEmRlbGV0ZWQtdmVoaWNsZS1pZA==";
// TfNSW Trip Updates include signed delay fields. Negative int32 values use a
// ten-byte protobuf varint, which must be skipped without unsigned conversion.
const SIGNED_DELAY_FIXTURE =
  "CgUKAzIuMBJDCgxzaWduZWQtZGVsYXkaMwoTChFzaWduZWQtZGVsYXktdHJpcBIcEhEI4v//////////ARCErvDSBiIHMjE1MDEzMg==";

test("decodes the GTFS-Realtime vehicle fields TramTrace uses", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(VEHICLE_FIXTURE, "base64")),
  );

  assert.equal(decoded.headerTimestamp, 1_784_420_000);
  assert.equal(decoded.incrementality, 0);
  assert.equal(decoded.vehicles.length, 1);
  assert.equal(decoded.tripUpdates.length, 0);
  const vehicle = decoded.vehicles[0];
  assert.equal(vehicle.entityId, "v1");
  assert.equal(vehicle.isDeleted, false);
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
  assert.equal(decoded.incrementality, 0);
  assert.equal(decoded.tripUpdates.length, 0);
  const vehicle = decoded.vehicles[0];
  assert.equal(vehicle.entityId, "record-2");
  assert.equal(vehicle.isDeleted, false);
  assert.equal(vehicle.vehicleId, "118466");
  assert.deepEqual(vehicle.trip, {
    tripId: "trip-2",
    startTime: "12:34:00",
    startDate: "20260720",
    routeId: "CSELR_L3",
    directionId: 0,
  });
});

test("decodes the GTFS-Realtime TripUpdate fields TramTrace uses", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(TRIP_UPDATE_FIXTURE, "base64")),
  );

  assert.equal(decoded.headerTimestamp, 1_784_420_000);
  assert.equal(decoded.incrementality, 0);
  assert.equal(decoded.vehicles.length, 0);
  assert.deepEqual(decoded.tripUpdates, [
    {
      entityId: "tu-record-1",
      isDeleted: false,
      trip: {
        tripId: "42686-10020:1000",
        startTime: "12:34:00",
        startDate: "20260727",
        scheduleRelationship: 3,
        routeId: "ISD-17-6720_L4",
        directionId: 0,
      },
      timestamp: 1_784_420_005,
      stopTimeUpdates: [
        {
          stopSequence: 8,
          arrivalTime: 1_784_420_100,
          departureTime: 1_784_420_130,
          stopId: "2150132",
          scheduleRelationship: 0,
        },
        {
          stopSequence: 9,
          arrivalTime: 1_784_420_400,
          stopId: "2150135",
          scheduleRelationship: 1,
        },
      ],
      vehicleId: "118466",
    },
  ]);
});

test("keeps optional TripUpdate fields absent", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(MINIMAL_TRIP_UPDATE_FIXTURE, "base64")),
  );

  assert.equal(decoded.headerTimestamp, undefined);
  assert.equal(decoded.incrementality, 0);
  assert.equal(decoded.vehicles.length, 0);
  assert.deepEqual(decoded.tripUpdates, [
    {
      entityId: "tu-record-2",
      isDeleted: false,
      trip: {
        tripId: "minimal-trip",
      },
      stopTimeUpdates: [
        {
          stopSequence: 10,
          departureTime: 1_784_420_500,
          stopId: "2150149",
          scheduleRelationship: 2,
        },
      ],
    },
  ]);
});

test("decodes differential incrementality and deleted entities", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(DELETED_DIFFERENTIAL_FIXTURE, "base64")),
  );

  assert.equal(decoded.headerTimestamp, 1_784_420_600);
  assert.equal(decoded.incrementality, 1);
  assert.deepEqual(decoded.tripUpdates, [
    {
      entityId: "deleted-tu",
      isDeleted: true,
      trip: {
        tripId: "deleted-trip",
        routeId: "ISD-17-6720_L4",
        directionId: 1,
      },
      stopTimeUpdates: [],
    },
  ]);
  assert.deepEqual(decoded.vehicles, [
    {
      entityId: "deleted-vp",
      isDeleted: true,
      vehicleId: "deleted-vehicle-id",
      trip: {
        tripId: "deleted-vehicle-trip",
        routeId: "ISD-17-6720_L4",
        directionId: 0,
      },
      stopId: "2150132",
      currentStatus: 2,
      timestamp: 1_784_420_595,
    },
  ]);
});

test("skips negative signed delays while retaining absolute event times", () => {
  const decoded = decodeFeedMessage(
    Uint8Array.from(Buffer.from(SIGNED_DELAY_FIXTURE, "base64")),
  );

  assert.deepEqual(decoded.tripUpdates[0]?.stopTimeUpdates, [
    {
      arrivalTime: 1_784_420_100,
      stopId: "2150132",
    },
  ]);
});

test("rejects truncated protobuf input", () => {
  assert.throws(
    () => decodeFeedMessage(Uint8Array.from([0x0a, 0x08, 0x1a])),
    /truncated protobuf/,
  );
});
