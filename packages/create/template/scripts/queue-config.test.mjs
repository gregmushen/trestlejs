import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { artifactBucketName, FRAMEWORK_CRONS, FRAMEWORK_MAINTENANCE_CRON, FRAMEWORK_SWEEP_CRON, queueNames, queuesEnabled, r2Enabled, renderQueueConfig, SCHEDULER_BINDING, SCHEDULER_MIGRATION, workflowsEnabled } from "./queue-config.mjs";

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
  assert.equal(rendered.env.preview.triggers, undefined);
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

test("rendered Worker config binds producer, consumer, and DLQ without a preview cron", () => {
  const rendered = JSON.parse(renderQueueConfig(wrangler, "preview", "example-worker-pr-12"));
  assert.deepEqual(rendered.env.preview.queues, {
    producers: [{ binding: "TRESTLE_EVENTS", queue: "example-worker-pr-12-events" }],
    consumers: [{ queue: "example-worker-pr-12-events", max_batch_size: 10, max_retries: 10, dead_letter_queue: "example-worker-pr-12-events-dlq" }],
  });
  assert.equal(rendered.env.preview.triggers, undefined);
  assert.equal(rendered.env.preview.name, "example-worker-pr-12");
  assert.equal(rendered.env.staging.queues, undefined);
  assert.equal(rendered.env.production.queues, undefined);
  assert.throws(() => renderQueueConfig(wrangler, "local", "example-worker"), /requires preview/u);
});

test("staging gets the safety sweep and hourly maintenance instead of an every-minute tick", () => {
  assert.deepEqual(FRAMEWORK_CRONS, ["*/15 * * * *", "7 * * * *"]);
  assert.equal(FRAMEWORK_SWEEP_CRON, "*/15 * * * *");
  assert.equal(FRAMEWORK_MAINTENANCE_CRON, "7 * * * *");
  const rendered = JSON.parse(renderQueueConfig(wrangler, "staging", "example-worker-staging", { queues: true, r2: true, workflows: true }));
  assert.deepEqual(rendered.env.staging.triggers.crons, ["*/15 * * * *", "7 * * * *"]);
  assert.ok(!rendered.env.staging.triggers.crons.includes("* * * * *"));
  assert.equal(rendered.env.preview.triggers, undefined);
});

test("Queues or R2 bind the due-time scheduler Durable Object with an additive SQLite migration", () => {
  assert.deepEqual(SCHEDULER_BINDING, { name: "TRESTLE_SCHEDULER", class_name: "TrestleScheduler" });
  assert.deepEqual(SCHEDULER_MIGRATION, { tag: "trestle-scheduler-v1", new_sqlite_classes: ["TrestleScheduler"] });
  for (const capabilities of [{ queues: true, r2: false, workflows: false }, { queues: false, r2: true, workflows: false }]) {
    for (const environment of ["preview", "staging", "production"]) {
      const rendered = JSON.parse(renderQueueConfig(wrangler, environment, `example-worker-${environment}`, capabilities));
      assert.deepEqual(rendered.env[environment].durable_objects, { bindings: [SCHEDULER_BINDING] });
      assert.deepEqual(rendered.env[environment].migrations, [SCHEDULER_MIGRATION]);
    }
  }
  const workflowsOnly = JSON.parse(renderQueueConfig(wrangler, "staging", "example-worker-staging", { queues: false, r2: false, workflows: true }));
  assert.equal(workflowsOnly.env.staging.durable_objects, undefined);
  assert.equal(workflowsOnly.env.staging.migrations, undefined);
});

test("cron-free preview still binds the scheduler, so its events dispatch without a cron", () => {
  const rendered = JSON.parse(renderQueueConfig(wrangler, "preview", "example-worker-pr-12", { queues: true, r2: false, workflows: false }, { cron: false }));
  assert.equal(rendered.env.preview.triggers, undefined);
  assert.deepEqual(rendered.env.preview.durable_objects, { bindings: [SCHEDULER_BINDING] });
});

test("application Durable Objects and migrations are kept in order and the scheduler is appended once", () => {
  const config = JSON.parse(wrangler);
  config.env.staging.durable_objects = { bindings: [{ name: "ROOMS", class_name: "Room" }] };
  config.env.staging.migrations = [{ tag: "v1", new_sqlite_classes: ["Room"] }, { tag: "v2", renamed_classes: [{ from: "Room", to: "Room" }] }];
  const source = JSON.stringify(config);
  const once = renderQueueConfig(source, "staging", "example-worker-staging", { queues: true, r2: false, workflows: false });
  const rendered = JSON.parse(once);
  assert.deepEqual(rendered.env.staging.durable_objects.bindings, [{ name: "ROOMS", class_name: "Room" }, SCHEDULER_BINDING]);
  assert.deepEqual(rendered.env.staging.migrations.map((migration) => migration.tag), ["v1", "v2", "trestle-scheduler-v1"]);
  assert.equal(renderQueueConfig(once, "staging", "example-worker-staging", { queues: true, r2: false, workflows: false }), once);
  assert.deepEqual(JSON.parse(source), config);
});

test("a conflicting scheduler binding or malformed migrations are reported, never replaced", () => {
  const conflicting = JSON.parse(wrangler);
  conflicting.env.staging.durable_objects = { bindings: [{ name: "TRESTLE_SCHEDULER", class_name: "Other" }] };
  assert.throws(() => renderQueueConfig(JSON.stringify(conflicting), "staging", "example-worker-staging"), /TRESTLE_SCHEDULER/u);
  const malformed = JSON.parse(wrangler);
  malformed.env.staging.migrations = { tag: "v1" };
  assert.throws(() => renderQueueConfig(JSON.stringify(malformed), "staging", "example-worker-staging"), /migrations/u);
  const changed = JSON.parse(wrangler);
  changed.env.staging.migrations = [{ tag: "trestle-scheduler-v1", new_classes: ["TrestleScheduler"] }];
  assert.throws(() => renderQueueConfig(JSON.stringify(changed), "staging", "example-worker-staging"), /trestle-scheduler-v1/u);
});

test("local development binds the scheduler so Durable Object alarms run under wrangler dev", () => {
  const config = JSON.parse(wrangler);
  assert.deepEqual(config.durable_objects, { bindings: [SCHEDULER_BINDING] });
  assert.deepEqual(config.migrations, [SCHEDULER_MIGRATION]);
});

function withStagingCrons(crons) {
  const config = JSON.parse(wrangler);
  config.env.staging.triggers = { crons };
  return JSON.stringify(config);
}

test("staging keeps application crons and appends the framework crons", () => {
  const source = withStagingCrons(["0 * * * *", "30 9 * * 1"]);
  const rendered = JSON.parse(renderQueueConfig(source, "staging", "example-worker-staging", { queues: true, r2: false, workflows: false }));
  assert.deepEqual(rendered.env.staging.triggers.crons, ["0 * * * *", "30 9 * * 1", ...FRAMEWORK_CRONS]);
  assert.deepEqual(rendered.env.production.triggers, JSON.parse(source).env.production.triggers);
});

test("framework crons are not duplicated and application order is kept", () => {
  const rendered = JSON.parse(renderQueueConfig(withStagingCrons([FRAMEWORK_SWEEP_CRON, "0 * * * *", "0 * * * *"]), "staging", "example-worker-staging", { queues: false, r2: true, workflows: false }));
  assert.deepEqual(rendered.env.staging.triggers.crons, [FRAMEWORK_SWEEP_CRON, "0 * * * *", FRAMEWORK_MAINTENANCE_CRON]);
  // A former framework minute tick is now just an application cron, and is kept.
  const legacy = JSON.parse(renderQueueConfig(withStagingCrons(["* * * * *"]), "staging", "example-worker-staging", { queues: true, r2: false, workflows: false }));
  assert.deepEqual(legacy.env.staging.triggers.crons, ["* * * * *", ...FRAMEWORK_CRONS]);
});

test("application crons survive when no capability needs maintenance", () => {
  const rendered = JSON.parse(renderQueueConfig(withStagingCrons(["0 * * * *"]), "staging", "example-worker-staging", { queues: false, r2: false, workflows: true }));
  assert.deepEqual(rendered.env.staging.triggers.crons, ["0 * * * *"]);
});

test("rendering is idempotent", () => {
  const once = renderQueueConfig(withStagingCrons(["0 * * * *"]), "staging", "example-worker-staging", { queues: true, r2: true, workflows: false });
  assert.equal(renderQueueConfig(once, "staging", "example-worker-staging", { queues: true, r2: true, workflows: false }), once);
});

test("malformed cron lists are reported rather than replaced", () => {
  assert.throws(() => renderQueueConfig(withStagingCrons("0 * * * *"), "staging", "example-worker-staging"), /triggers\.crons/u);
  assert.throws(() => renderQueueConfig(withStagingCrons(["0 * * * *", 5]), "staging", "example-worker-staging"), /triggers\.crons/u);
});

test("the Worker routes framework work by the same crons and exports the scheduler class", async () => {
  const worker = await readFile(new URL("../apps/worker/src/index.ts", import.meta.url), "utf8");
  const escape = (cron) => cron.replaceAll("*", "\\*").replaceAll("/", "\\/");
  assert.match(worker, new RegExp(`export const frameworkSweepCron = "${escape(FRAMEWORK_SWEEP_CRON)}";`, "u"));
  assert.match(worker, new RegExp(`export const frameworkMaintenanceCron = "${escape(FRAMEWORK_MAINTENANCE_CRON)}";`, "u"));
  const entry = await readFile(new URL("../apps/worker/src/worker-entry.ts", import.meta.url), "utf8");
  assert.match(entry, new RegExp(`export \\{ ${SCHEDULER_BINDING.class_name} \\}`, "u"));
});

test("preview can explicitly omit cron without losing Queue and Workflow bindings", () => {
  const rendered = JSON.parse(renderQueueConfig(wrangler, "preview", "example-worker-pr-12", { queues: true, r2: true, workflows: true }, { cron: false }));
  assert.equal(rendered.env.preview.triggers, undefined);
  assert.ok(rendered.env.preview.queues);
  assert.ok(rendered.env.preview.r2_buckets);
  assert.ok(rendered.env.preview.workflows);
});
