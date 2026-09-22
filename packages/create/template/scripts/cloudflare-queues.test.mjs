import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { queueClient } from "./cloudflare-queues.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const queueId = "abcdef0123456789abcdef0123456789";

test("Queue provisioning converges by exact name and never prints credentials", async () => {
  const queues = [];
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method ?? "GET", authorization: options.headers.authorization });
    if (options.method === "POST") {
      const { queue_name } = JSON.parse(options.body);
      queues.push({ queue_name, queue_id: queueId });
      return new Response(JSON.stringify({ success: true, result: queues.at(-1) }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: queues, result_info: { total_pages: 1 } }), { status: 200 });
  };
  const client = queueClient({ accountId, token: "private-token", fetcher });
  assert.deepEqual(await client.ensure("example-worker-pr-1-events"), { name: "example-worker-pr-1-events", state: "created" });
  assert.deepEqual(await client.ensure("example-worker-pr-1-events"), { name: "example-worker-pr-1-events", state: "existing" });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(calls.every((call) => call.authorization === "Bearer private-token"));
});

test("Queue cleanup targets the exact remote identity and accepts absence", async () => {
  const queues = [{ queue_name: "example-worker-pr-1-events", queue_id: queueId }];
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method ?? "GET" });
    if (options.method === "DELETE") { queues.pop(); return new Response(null, { status: 204 }); }
    return new Response(JSON.stringify({ success: true, result: queues, result_info: { total_pages: 1 } }), { status: 200 });
  };
  const client = queueClient({ accountId, token: "private-token", fetcher });
  assert.deepEqual(await client.remove("example-worker-pr-1-events"), { name: "example-worker-pr-1-events", state: "deleted" });
  assert.equal(calls.find((call) => call.method === "DELETE")?.url.endsWith(`/queues/${queueId}`), true);
  assert.deepEqual(await client.remove("example-worker-pr-1-events"), { name: "example-worker-pr-1-events", state: "absent" });
});

test("Queue API failures fail closed without exposing token", async () => {
  const client = queueClient({ accountId, token: "private-token", fetcher: async () => new Response(JSON.stringify({ success: false }), { status: 403 }) });
  await assert.rejects(client.ensure("example-worker-pr-1-events"), /HTTP 403/u);
  const cli = spawnSync(process.execPath, [new URL("./cloudflare-queues.mjs", import.meta.url).pathname, "delete-preview", "example-worker-staging"], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /only isolated preview Queues may be deleted/u);
});

test("disabled Queue capability does not require credentials or provision resources", () => {
  const cli = spawnSync(process.execPath, [new URL("./cloudflare-queues.mjs", import.meta.url).pathname, "ensure", "example-worker-pr-1"], {
    encoding: "utf8", env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Queues disabled; no resources changed/u);
});
