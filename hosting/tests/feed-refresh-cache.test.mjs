import assert from "node:assert/strict";
import test from "node:test";

import {
  FeedRefreshCache,
  allFailureBackoffSeconds,
} from "../worker/feed-refresh-cache.ts";

const failure = {
  updates: [],
  errors: { innerwest: "HTTP 429" },
};

test("an empty-cache failure is suppressed until its retry is due", async () => {
  const cache = new FeedRefreshCache();
  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
    return failure;
  };

  await assert.rejects(cache.getSnapshot(100, 15, refresh));
  await assert.rejects(cache.getSnapshot(103, 15, refresh));
  await assert.rejects(cache.getSnapshot(114.999, 15, refresh));
  assert.equal(refreshes, 1);

  await assert.rejects(cache.getSnapshot(115, 15, refresh));
  await assert.rejects(cache.getSnapshot(144.999, 15, refresh));
  assert.equal(refreshes, 2);

  await assert.rejects(cache.getSnapshot(145, 15, refresh));
  assert.equal(refreshes, 3);
});

test("concurrent requests coalesce into one upstream refresh", async () => {
  const cache = new FeedRefreshCache();
  let refreshes = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const refresh = async () => {
    refreshes += 1;
    await pending;
    return {
      updates: [["innerwest", { version: 1 }]],
      errors: {},
    };
  };

  const first = cache.getSnapshot(100, 15, refresh);
  const second = cache.getSnapshot(100, 15, refresh);
  const third = cache.getSnapshot(101, 15, refresh);
  assert.equal(refreshes, 1);

  release();
  const snapshots = await Promise.all([first, second, third]);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.parts),
    [
      [{ version: 1 }],
      [{ version: 1 }],
      [{ version: 1 }],
    ],
  );
});

test("the next refresh is timed from request completion", async () => {
  const cache = new FeedRefreshCache();
  let currentTime = 100;
  let refreshes = 0;
  const refresh = async () => {
    refreshes += 1;
    currentTime += refreshes === 1 ? 12 : 3;
    return {
      updates: [["innerwest", { version: refreshes }]],
      errors: {},
    };
  };
  const clock = () => currentTime;

  const first = await cache.getSnapshot(100, 15, refresh, clock);
  assert.equal(first.attemptedAt, 112);
  assert.equal(first.nextAttemptAt, 127);

  const cached = await cache.getSnapshot(126.999, 15, refresh, clock);
  assert.deepEqual(cached.parts, [{ version: 1 }]);
  assert.equal(refreshes, 1);

  currentTime = 127;
  const second = await cache.getSnapshot(127, 15, refresh, clock);
  assert.deepEqual(second.parts, [{ version: 2 }]);
  assert.equal(second.attemptedAt, 130);
  assert.equal(second.nextAttemptAt, 145);
});

test("a success resets all-feed failure backoff to the normal interval", async () => {
  const cache = new FeedRefreshCache();
  const outcomes = [
    failure,
    failure,
    {
      updates: [["innerwest", { version: 1 }]],
      errors: {},
    },
    {
      updates: [["innerwest", { version: 2 }]],
      errors: {},
    },
  ];
  let refreshes = 0;
  const refresh = async () => outcomes[refreshes++];

  await assert.rejects(cache.getSnapshot(100, 15, refresh));
  await assert.rejects(cache.getSnapshot(115, 15, refresh));
  const recovered = await cache.getSnapshot(145, 15, refresh);
  assert.deepEqual(recovered.parts, [{ version: 1 }]);

  const cached = await cache.getSnapshot(159.999, 15, refresh);
  assert.deepEqual(cached.parts, [{ version: 1 }]);
  assert.equal(refreshes, 3);

  const refreshed = await cache.getSnapshot(160, 15, refresh);
  assert.deepEqual(refreshed.parts, [{ version: 2 }]);
  assert.equal(refreshes, 4);
});

test("partial success updates that feed and preserves other last-good data", async () => {
  const cache = new FeedRefreshCache();
  const initial = await cache.getSnapshot(100, 15, async () => ({
    updates: [
      ["innerwest", { version: 1 }],
      ["cbdandsoutheast", { version: 1 }],
      ["parramatta", { version: 1 }],
    ],
    errors: {},
  }));
  assert.equal(initial.parts.length, 3);

  const partial = await cache.getSnapshot(115, 15, async () => ({
    updates: [["innerwest", { version: 2 }]],
    errors: {
      cbdandsoutheast: "HTTP 429",
      parramatta: "HTTP 429",
    },
  }));
  assert.deepEqual(partial.parts, [
    { version: 2 },
    { version: 1 },
    { version: 1 },
  ]);
  assert.deepEqual(partial.errors, {
    cbdandsoutheast: "HTTP 429",
    parramatta: "HTTP 429",
  });

  const afterAllFail = await cache.getSnapshot(130, 15, async () => failure);
  assert.deepEqual(afterAllFail.parts, partial.parts);
});

test("all-feed failure backoff is exponential and bounded", () => {
  assert.equal(allFailureBackoffSeconds(15, 1), 15);
  assert.equal(allFailureBackoffSeconds(15, 2), 30);
  assert.equal(allFailureBackoffSeconds(15, 5), 240);
  assert.equal(allFailureBackoffSeconds(15, 6), 300);
  assert.equal(allFailureBackoffSeconds(15, 20), 300);
});
