import assert from "node:assert/strict";
import test from "node:test";

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

async function freshWorker(label) {
  const workerUrl = new URL(
    `../dist/server/index.js?${label}=${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  return (await import(workerUrl.href)).default;
}

test("a cold deployment reports ready without contacting an upstream feed", async () => {
  const worker = await freshWorker("cold-health");
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("health must not fetch upstream data");
  };

  try {
    const response = await worker.fetch(
      new Request("https://tramtrace.test/healthz"),
      {
        TFNSW_API_TOKEN: "configured-token",
        TRAMTRACE_BOARD_KEY: "configured-board-key",
      },
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(fetchCount, 0);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.match(
      response.headers.get("Content-Security-Policy") || "",
      /frame-ancestors 'none'/,
    );
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.live_data_ready, false);
    assert.equal(health.token_configured, true);
    assert.equal(health.static_loaded, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health fails when the TfNSW credential is not configured", async () => {
  const worker = await freshWorker("missing-token");
  const response = await worker.fetch(
    new Request("https://tramtrace.test/healthz"),
    { TRAMTRACE_BOARD_KEY: "configured-board-key" },
    context,
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test("a present malformed authorization header cannot downgrade to a query key", async () => {
  const worker = await freshWorker("auth-downgrade");
  const response = await worker.fetch(
    new Request(
      "https://tramtrace.test/tramtrace_payload?board_id=configured-board-key",
      { headers: { Authorization: "Basic configured-board-key" } },
    ),
    {
      TFNSW_API_TOKEN: "configured-token",
      TRAMTRACE_BOARD_KEY: "configured-board-key",
    },
    context,
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});
