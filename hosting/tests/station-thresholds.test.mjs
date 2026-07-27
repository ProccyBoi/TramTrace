import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_L4_FAR_METRES,
  farMetresForCandidate,
} from "../worker/station-thresholds.ts";

const transitDataUrl = new URL(
  "../worker/generated-transit-data.json",
  import.meta.url,
);

function haversineMetres(left, right) {
  const radians = Math.PI / 180;
  const radius = 6_371_000;
  const latitudeLeft = left[1] * radians;
  const latitudeRight = right[1] * radians;
  const deltaLatitude = latitudeRight - latitudeLeft;
  const deltaLongitude = (right[2] - left[2]) * radians;
  const value =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitudeLeft) *
      Math.cos(latitudeRight) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

test("the L4 reported-stop threshold covers every adjacent station gap", async () => {
  const transitData = JSON.parse(await readFile(transitDataUrl, "utf8"));
  const stations = transitData.routes.L4.stations;
  const gaps = stations
    .slice(0, -1)
    .map((station, index) =>
      haversineMetres(station, stations[index + 1]),
    );
  const maximumGap = Math.max(...gaps);

  assert.ok(maximumGap > 800);
  assert.ok(maximumGap < DEFAULT_L4_FAR_METRES);
  assert.ok(maximumGap > 1_490 && maximumGap < 1_492);
});

test("the extended range applies only to a reported L4 station", () => {
  assert.equal(
    farMetresForCandidate("L4", true, 800, DEFAULT_L4_FAR_METRES),
    1_700,
  );
  assert.equal(
    farMetresForCandidate("L4", false, 800, DEFAULT_L4_FAR_METRES),
    800,
  );
  assert.equal(
    farMetresForCandidate("L1", true, 800, DEFAULT_L4_FAR_METRES),
    800,
  );
});
