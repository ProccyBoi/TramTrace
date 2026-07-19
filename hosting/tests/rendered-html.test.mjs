import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the TramTrace status page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>TramTrace/);
  assert.match(html, /Sydney light rail feed/);
  assert.match(html, /Dulwich Hill Line/);
  assert.match(html, /Randwick Line/);
  assert.match(html, /Kingsford Line/);
  assert.match(html, /Westmead &amp; Carlingford Line/);
  assert.match(html, /href="\/healthz"/);
  assert.doesNotMatch(html, /TFNSW_API_TOKEN|TRAMTRACE_BOARD_KEY/);
});
