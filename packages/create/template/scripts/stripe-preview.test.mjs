import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { previewWebhookUrl, provisionPreviewWebhook, removePreviewWebhook, stripePreviewClient } from "./stripe-preview.mjs";

const apiUrl = "https://example-worker-pr-11.example.workers.dev";
const webhookUrl = `${apiUrl}/webhooks/stripe`;
const first = { id: "we_old123", url: webhookUrl, livemode: false, status: "enabled" };
const unrelated = { id: "we_other123", url: "https://example-worker-staging.example.workers.dev/webhooks/stripe", livemode: false };

test("only exact isolated preview Worker URLs and test credentials are accepted", () => {
  assert.equal(previewWebhookUrl(apiUrl), webhookUrl);
  for (const url of ["https://example-worker-staging.example.workers.dev", "https://example-worker-pr-11.evil.test", "http://example-worker-pr-11.example.workers.dev", `${apiUrl}/other`]) {
    assert.throws(() => previewWebhookUrl(url), /isolated preview/u);
  }
  assert.throws(() => stripePreviewClient({ apiKey: "sk_live_sensitive" }), /test-mode/u);
  assert.throws(() => stripePreviewClient({ apiKey: "" }), /test-mode/u);
});

test("provision binds the new signing secret before removing only the old exact endpoint", async () => {
  const calls = [];
  const client = {
    list: async () => [first, unrelated],
    create: async (url, key) => { calls.push(["create", url, key]); return { id: "we_new123", secret: "whsec_new123", url, livemode: false }; },
    remove: async (id) => { calls.push(["remove", id]); },
  };
  const result = await provisionPreviewWebhook({
    client, apiUrl, idempotencyKey: "stable-run",
    putSecret: async (secret) => { calls.push(["secret", secret]); },
  });
  assert.deepEqual(result, { id: "we_new123", url: webhookUrl, state: "provisioned" });
  assert.deepEqual(calls, [["create", webhookUrl, "stable-run"], ["secret", "whsec_new123"], ["remove", first.id]]);
});

test("failed secret binding removes the newly created endpoint and preserves the prior endpoint", async () => {
  const removed = [];
  const client = {
    list: async () => [first],
    create: async () => ({ id: "we_new123", secret: "whsec_new123", url: webhookUrl, livemode: false }),
    remove: async (id) => { removed.push(id); },
  };
  await assert.rejects(provisionPreviewWebhook({ client, apiUrl, putSecret: async () => { throw new Error("binding unavailable"); } }), /binding unavailable/u);
  assert.deepEqual(removed, ["we_new123"]);
});

test("cleanup deletes only the exact test-mode preview webhook, accepting absence", async () => {
  const removed = [];
  const client = { list: async () => [first, unrelated, { ...first, id: "we_live123", livemode: true }], remove: async (id) => { removed.push(id); } };
  assert.deepEqual(await removePreviewWebhook({ client, apiUrl }), { url: webhookUrl, removed: 1 });
  assert.deepEqual(removed, [first.id]);
  assert.deepEqual(await removePreviewWebhook({ client: { list: async () => [], remove: async () => {} }, apiUrl }), { url: webhookUrl, removed: 0 });
});

test("Stripe client uses test authorization, paginates, and normalizes failures without leaking credentials", async () => {
  const requests = [];
  const client = stripePreviewClient({ apiKey: "sk_test_private123", fetcher: async (url, options) => {
    requests.push({ url, method: options.method ?? "GET", authorization: options.headers.authorization });
    if (requests.length === 1) return Response.json({ data: [first], has_more: true });
    if (requests.length === 2) return Response.json({ data: [unrelated], has_more: false });
    return new Response(JSON.stringify({ error: { message: "sk_test_private123 bad request" } }), { status: 400 });
  } });
  assert.deepEqual((await client.list()).map((endpoint) => endpoint.id), [first.id, unrelated.id]);
  assert.ok(requests[1].url.includes("starting_after=we_old123"));
  assert.ok(requests.every((request) => request.authorization === "Bearer sk_test_private123"));
  await assert.rejects(client.remove(first.id), (error) => {
    assert.match(error.message, /HTTP 400/u);
    assert.doesNotMatch(error.message, /sk_test_private123/u);
    return true;
  });
  const cli = spawnSync(process.execPath, [new URL("./stripe-preview.mjs", import.meta.url).pathname, "delete", "https://example-worker-staging.example.workers.dev"], { encoding: "utf8", env: { ...process.env, STRIPE_SECRET_KEY: "sk_test_private123" } });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /isolated preview/u);
});
