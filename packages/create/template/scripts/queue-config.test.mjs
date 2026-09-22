import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { queueNames, queuesEnabled, renderQueueConfig } from "./queue-config.mjs";

const wrangler = await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8");

test("Queue capability is explicitly opt-in", () => {
  assert.equal(queuesEnabled("capabilities:\n  queues: false\n  r2: false\nenvironments:\n  - preview\n"), false);
  assert.equal(queuesEnabled("capabilities:\n  queues: true\n  r2: false\nenvironments:\n  - preview\n"), true);
  assert.throws(() => queuesEnabled("capabilities:\n  r2: false\n"), /must declare capabilities.queues/u);
});

test("preview Queue names are isolated and bounded even for long Worker names", () => {
  const first = queueNames("example-worker-pr-12");
  const second = queueNames("example-worker-pr-13");
  assert.deepEqual(first, { primary: "example-worker-pr-12-events", deadLetter: "example-worker-pr-12-events-dlq" });
  assert.notEqual(first.primary, second.primary);
  const long = queueNames(`example-${"a".repeat(55)}`);
  assert.ok(long.primary.length <= 63);
  assert.ok(long.deadLetter.length <= 63);
  assert.notEqual(long.primary, long.deadLetter);
  assert.throws(() => queueNames("INVALID"), /invalid Worker name/u);
});

test("rendered Worker config binds producer, consumer, DLQ, and cron only to target environment", () => {
  const rendered = JSON.parse(renderQueueConfig(wrangler, "preview", "example-worker-pr-12"));
  assert.deepEqual(rendered.env.preview.queues, {
    producers: [{ binding: "TRESTLE_EVENTS", queue: "example-worker-pr-12-events" }],
    consumers: [{ queue: "example-worker-pr-12-events", max_batch_size: 10, max_retries: 5, dead_letter_queue: "example-worker-pr-12-events-dlq" }],
  });
  assert.deepEqual(rendered.env.preview.triggers.crons, ["* * * * *"]);
  assert.equal(rendered.env.preview.name, "example-worker-pr-12");
  assert.equal(rendered.env.staging.queues, undefined);
  assert.equal(rendered.env.production.queues, undefined);
  assert.throws(() => renderQueueConfig(wrangler, "local", "example-worker"), /requires preview/u);
});
