import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../worker/tramtrace.ts", import.meta.url);

async function defaultFor(environmentName) {
  const source = await readFile(sourceUrl, "utf8");
  const pattern = new RegExp(
    `env\\.${environmentName},\\s*([\\d_]+),\\s*0,\\s*5_000`,
  );
  const match = pattern.exec(source);
  assert.ok(match, `missing numeric fallback for ${environmentName}`);
  return Number(match[1].replaceAll("_", ""));
}

test("uses the tightened live-light distance defaults", async () => {
  assert.deepEqual(
    {
      atStation: await defaultFor("TRAMTRACE_AT_STATION_METRES"),
      approaching: await defaultFor("TRAMTRACE_APPROACHING_METRES"),
      far: await defaultFor("TRAMTRACE_FAR_METRES"),
    },
    {
      atStation: 120,
      approaching: 450,
      far: 800,
    },
  );
});

test("enforces a 15-second minimum upstream feed refresh", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(
    source,
    /env\.TRAMTRACE_FEED_CACHE_SECONDS,\s*15,\s*15,\s*60/,
  );
});
