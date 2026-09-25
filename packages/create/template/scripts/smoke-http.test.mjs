import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetchSameOriginWithRetry } from "./smoke-http.mjs";

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => await new Promise((resolve) => server.close(resolve)) };
}

test("read-only smoke retries a transient Pages 522", async () => {
  let requests = 0;
  const server = await serve((_request, response) => {
    requests += 1;
    response.statusCode = requests === 1 ? 522 : 200;
    response.end();
  });
  try {
    assert.equal((await fetchSameOriginWithRetry(server.url, {}, { attempts: 3, delayMs: 0 })).status, 200);
    assert.equal(requests, 2);
  } finally { await server.close(); }
});

test("persistent Pages 522 fails after a bounded number of requests", async () => {
  let requests = 0;
  const server = await serve((_request, response) => {
    requests += 1;
    response.statusCode = 522;
    response.end();
  });
  try {
    assert.equal((await fetchSameOriginWithRetry(server.url, {}, { attempts: 3, delayMs: 0 })).status, 522);
    assert.equal(requests, 3);
  } finally { await server.close(); }
});

test("unsafe requests and cross-origin redirects are not retried", async () => {
  let requests = 0;
  const server = await serve((request, response) => {
    requests += 1;
    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("location", "https://attacker.example/phish");
    } else response.statusCode = 522;
    response.end();
  });
  try {
    assert.equal((await fetchSameOriginWithRetry(server.url, { method: "POST" }, { attempts: 3, delayMs: 0 })).status, 522);
    assert.equal(requests, 1);
    await assert.rejects(fetchSameOriginWithRetry(`${server.url}/redirect`, {}, { attempts: 3, delayMs: 0 }), /Cross-origin redirect rejected/u);
    assert.equal(requests, 2);
  } finally { await server.close(); }
});
