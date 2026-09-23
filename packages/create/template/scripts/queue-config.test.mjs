import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { artifactBucketName, queueNames, queuesEnabled, r2Enabled, renderQueueConfig, workflowsEnabled } from "./queue-config.mjs";

const wrangler = await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8");

test("Queue capability is explicitly opt-in", () => {
  assert.equal(queuesEnabled("capabilities:\n  queues: false\n  r2: false\nenvironments:\n  - preview\n"), false);
  assert.equal(queuesEnabled("capabilities:\n  queues: true\n  r2: false\nenvironments:\n  - preview\n"), true);
  assert.throws(() => queuesEnabled("capabilities:\n  r2: false\n"), /must declare capabilities.queues/u);
});

test("R2 capability is explicitly opt-in and creates isolated bucket names", () => {
  assert.equal(r2Enabled("capabilities:\n  queues: false\n  r2: false\n"), false);
  assert.equal(r2Enabled("capabilities:\n  queues: false\n  r2: true\n"), true);
  assert.throws(() => r2Enabled("capabilities:\n  queues: false\n"), /must declare capabilities.r2/u);
  assert.equal(artifactBucketName("example-worker-pr-12"), "example-worker-pr-12-artifacts");
  assert.notEqual(artifactBucketName("example-worker-pr-12"), artifactBucketName("example-worker-pr-13"));
  assert.ok(artifactBucketName(`example-${"a".repeat(55)}`).length <= 63);
});

test("Workflow capability is opt-in and binds a same-script exported class", () => {
  assert.equal(workflowsEnabled("capabilities:\n  workflows: false\n"), false);
  assert.equal(workflowsEnabled("capabilities:\n  workflows: true\n"), true);
  assert.throws(() => workflowsEnabled("capabilities:\n  queues: true\n"), /must declare capabilities.workflows/u);
  const rendered = JSON.parse(renderQueueConfig(wrangler, "preview", "example-worker-pr-12", { queues: true, r2: false, workflows: true }));
  assert.deepEqual(rendered.env.preview.workflows, [{ binding: "TRESTLE_WORKFLOW", name: "example-worker-pr-12-workflow", class_name: "TrestleWorkflow" }]);
  assert.equal(rendered.env.preview.vars.TRESTLE_WORKFLOWS_ENABLED, "true");
  assert.equal(rendered.env.staging.workflows, undefined);
  assert.equal(rendered.env.staging.vars.TRESTLE_WORKFLOWS_ENABLED, undefined);
});

test("R2-only Worker config binds the bucket without enabling Queues", () => {
  const rendered = JSON.parse(renderQueueConfig(wrangler, "preview", "example-worker-pr-12", { queues: false, r2: true }));
  assert.deepEqual(rendered.env.preview.r2_buckets, [{ binding: "TRESTLE_ARTIFACTS", bucket_name: "example-worker-pr-12-artifacts" }]);
  assert.equal(rendered.env.preview.queues, undefined);
  assert.deepEqual(rendered.env.preview.triggers.crons, ["* * * * *"]);
  assert.equal(rendered.env.staging.r2_buckets, undefined);
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
    consumers: [{ queue: "example-worker-pr-12-events", max_batch_size: 10, max_retries: 10, dead_letter_queue: "example-worker-pr-12-events-dlq" }],
  });
  assert.deepEqual(rendered.env.preview.triggers.crons, ["* * * * *"]);
  assert.equal(rendered.env.preview.name, "example-worker-pr-12");
  assert.equal(rendered.env.staging.queues, undefined);
  assert.equal(rendered.env.production.queues, undefined);
  assert.throws(() => renderQueueConfig(wrangler, "local", "example-worker"), /requires preview/u);
});
