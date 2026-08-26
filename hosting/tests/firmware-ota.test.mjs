import assert from "node:assert/strict";
import test from "node:test";

const manifest = {
  schema: 1,
  product: "tramtrace-esp32",
  version: "0.3.0",
  size: 8,
  md5: "0123456789abcdef0123456789abcdef",
  sha256: "a".repeat(64),
  signature_algorithm: "ecdsa-p256-sha256",
  signing_key: "tramtrace-ota-2026-01",
  signature: "MEUCIQD8aGVsbG90cmFtdHJhY2VzaWduYXR1cmV0ZXN0MQIgdGVzdA==",
  url: "https://github.com/ProccyBoi/TramTrace/releases/download/v0.3.0/tramtrace-0.3.0.bin",
};

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const environment = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};
const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("serves a same-site signed OTA manifest only for newer firmware", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(manifest, {
      headers: { "content-length": String(JSON.stringify(manifest).length) },
    });
  try {
    const worker = await loadWorker();
    const response = await worker.fetch(
      new Request("https://tramtrace.example/firmware_manifest?current=0.2.5"),
      environment,
      context,
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.update_available, true);
    assert.equal(payload.version, "0.3.0");
    assert.equal(
      payload.url,
      "https://tramtrace.example/firmware.bin?version=0.3.0",
    );
    assert.equal(payload.signature, manifest.signature);

    const sameVersion = await worker.fetch(
      new Request("https://tramtrace.example/firmware_manifest?current=0.3.0"),
      environment,
      context,
    );
    assert.equal((await sameVersion.json()).update_available, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxies only the current immutable release binary", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("manifest.json")) {
      return Response.json(manifest);
    }
    assert.equal(url, manifest.url);
    return new Response(new Uint8Array(8), {
      headers: { "content-length": "8" },
    });
  };
  try {
    const worker = await loadWorker();
    const response = await worker.fetch(
      new Request("https://tramtrace.example/firmware.bin?version=0.3.0"),
      environment,
      context,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "8");
    assert.equal(response.headers.get("x-firmware-sha256"), manifest.sha256);

    const missing = await worker.fetch(
      new Request("https://tramtrace.example/firmware.bin?version=0.2.5"),
      environment,
      context,
    );
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed when the upstream manifest is not from TramTrace releases", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ ...manifest, url: "https://example.com/firmware.bin" });
  try {
    const worker = await loadWorker();
    const response = await worker.fetch(
      new Request("https://tramtrace.example/firmware_manifest?current=0.2.5"),
      environment,
      context,
    );
    assert.equal(response.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
