# Job runtimes

TrestleJS applications write background work once:

- event consumers, registered with `eventConsumers.register`;
- scheduled jobs, registered with `scheduledJobs.register`.

They then choose where it runs with `jobs:` in `.trestle/project.yaml`. Every
runtime receives the same committed events from the transactional outbox,
under stable event IDs. Every execution re-verifies provenance, the 14-day
replay window, and current entitlements before a handler runs.

## Choosing a runtime

| | Cloudflare (default) | trigger.dev | Inngest |
| --- | --- | --- | --- |
| Where job code runs | your Worker, Queues, Workflows | trigger.dev machines (Node), or yours when self-hosted | your Worker; Inngest calls a signed endpoint |
| Best for | no extra vendor, lowest cost, light and frequent work | long or heavy jobs, Node libraries, Python scripts, many sequences | step functions and sequences while keeping Worker bindings (R2, Queues, Durable Objects) |
| Visibility | outbox and Workflow views in the platform admin | trigger.dev dashboard | Inngest dashboard |
| Trade-offs | Worker CPU and time limits; basic tooling | a separate `trestle_jobs` database login; secrets, including `RESEND_API_KEY`, synced to the engine; Cloudflare bindings only through a signed internal route | another vendor; a signed endpoint on your Worker |

Frequent schedules alone are not a reason to leave Cloudflare. Due work runs
on the scheduler Durable Object's alarm, not a per-minute cron, so a job due
every minute uses no cron triggers and an idle project makes no database
queries. Each run still costs Worker time, which is where heavy per-minute
work favors another runtime.

Stripe and Resend webhooks always arrive at the Worker, whichever runtime is
selected: their verified events go through the outbox to the selected
runtime. Email sequences (`defineSequence`, see the README) run on all three;
trigger.dev and Inngest add a per-run dashboard for their waits and exits.

The platform admin's **Jobs** view shows the selected runtime, its hosting and
dispatch health, links to its dashboard, and switches runtimes (see
[From the platform admin](#from-the-platform-admin)).

## Support matrix

A profile is **supported** only when its evidence exists. Anything else is
**experimental** and says what is missing.

| Runtime | Hosting | Where work runs | Status | Evidence |
| --- | --- | --- | --- | --- |
| `cloudflare` (default) | Cloudflare | Worker, Queues, Workflows | Supported | Conformance 9/9, required in CI; deployed canaries |
| `trigger` | trigger.dev cloud | trigger.dev machines (Node) | Experimental | The engine passes conformance 9/9 (self-hosted v4). No hosted canary yet: it needs a trigger.dev account |
| `trigger` | self-hosted (Docker) | your machines | Supported for `trigger dev` execution; the container supervisor is unverified | Conformance 9/9 against self-hosted v4; crash recovery; app event end to end; approved Python script |
| `inngest` | Inngest cloud | your Worker (signed endpoint) | Experimental | The engine passes conformance 9/9 (Dev Server, required in CI). No hosted canary yet: it needs an Inngest account |
| `inngest` | self-hosted (Docker, PostgreSQL + Redis) | your Worker | Supported | Conformance 9/9 against `infra/inngest/docker-compose.yml`; crash recovery with Redis |
| `inngest` | self-hosted, PostgreSQL only | your Worker | **Not supported** | A crash lost the in-flight run (see below) |
| `inngest` | Cloudflare Container + Neon (+ Redis) | your Worker | Experimental (`--experimental`) | Same image as the Docker profile, but never deployed |

## What every runtime guarantees

The conformance suite (`apps/worker/src/job-conformance*.ts`) checks these
guarantees through PostgreSQL only, so the same suite runs against engines
in other processes:

1. A committed event runs exactly once, under its own tenant.
2. A transient failure is retried until the handler completes once.
3. A duplicate delivery runs once.
4. A resend after a lost dispatch acknowledgement never completes twice.
5. An entitlement revoked before a retry skips the handler.
6. Expired provenance is rejected permanently, without retries.
7. Fan-out to several tenants keeps each run under its own authority.
8. Accepted work survives an executor restart.
9. In-flight work completes exactly once across a deploy.

How in-flight runs meet new code differs by runtime:

| Runtime | During a deploy |
| --- | --- |
| Cloudflare Workflows | resume on the new code (`new-code`) |
| Inngest | resume on the new code (`new-code`) |
| trigger.dev | finish on the version they started on (`pinned`) |

## Email sequences

`defineSequence` (apps/worker/src/sequences.ts) is written once. Its runtime-
neutral core, `runSequenceStep` (sequence-runtime.ts), executes one step of
one run: it reloads the run and the committed trigger event, re-verifies
authority before every send, checks the run is still active and the recipient
not suppressed, sends with the Resend idempotency key `seq:<runId>:<step>`, and
records the send in the transaction that advances the run. Every change is
fenced on the run's current step, so a retried or replayed step returns what
the run already recorded. `driveSequenceRun` loops over steps with each
engine's own durable primitives:

| | Cloudflare | trigger.dev | Inngest |
| --- | --- | --- | --- |
| a run | one Workflow instance `seq-<runId>` on `TRESTLE_WORKFLOW` (`TrestleWorkflow` branches on the params) | one `trestle-sequence` task run, idempotency key `trestle-sequence:<runId>` | one `trestle-sequence` function run, event ID `trestle-sequence:<runId>` |
| a step | `step.do` (5 retries) | called directly; the database fences a replay after a retried attempt | `step.run` |
| a wait | `step.sleepUntil(wake time)` | `wait.until({ date })` (checkpointed) | `step.sleepUntil(wake time)` |
| exit on event | the consumer marks runs `exited`, then terminates the instance | the consumer marks runs `exited`, then cancels the run (`POST /api/v2/runs/:id/cancel`) | the consumer marks runs `exited`, then sends `trestle/sequence.exited`, which the function's `cancelOn` matches on `data.runId` |
| authority failure | `NonRetryableError` | `AbortTaskRunError` | `NonRetriableError` |

The wake time is computed once, when the wait step runs, and stored on the
run (`next_at`): calendar-day waits keep the recipient's local time of day
(IANA zone, UTC when unknown), and a send due inside quiet hours (default
21:00–08:00) moves to their end. A retried or resumed step sleeps until the
same instant. Cancellation is best effort everywhere: the next step's active
check is what guarantees an exit during a wait prevents the next send.

New runs start on the configured runtime (`TRESTLE_JOB_RUNTIME`; trigger.dev
tasks default to `trigger`); an exit cancels a run on the engine it started on.
Sequences on Cloudflare need Workflows (`TRESTLE_WORKFLOWS_ENABLED` and the
`TRESTLE_WORKFLOW` binding); without them the trigger event's consumer fails
and retries, then dead-letters, rather than silently dropping the run.

The conformance suite adds five sequence cases on every harness: wait then
send, exit during a wait prevents the next send, suppression before send,
authority revoked between steps ends the run, and a send whose response was
lost is not duplicated (the real Resend adapter against a recorded fake of
Resend's HTTP API that honors idempotency keys). They pass on Cloudflare
(in process, required in CI) and on the Inngest Dev Server (required in CI);
the trigger.dev harness implements them but they have not yet been run against
a trigger.dev engine.

## Settlement

trigger.dev and Inngest can end a run without success. Examples:

- an operator cancels it;
- `trigger dev` stops, which cancels in-flight runs (the conformance suite
  found this);
- a self-hosted Inngest without Redis crashes.

The Worker's 15-minute safety sweep handles this with
`PostgresOutboxStore.settleUnconsumed`. Events dispatched more than 30
minutes ago that no consumer completed are re-dispatched under the next
generation, bounded by the dead-letter cap. The event and generation form the
runtime's idempotency key, so resends deduplicate while re-dispatches start
fresh runs. The inbox still guarantees a handler never completes twice.

## Data and authority

- **Only the event ID leaves the application.** trigger.dev tasks and Inngest
  functions load the committed envelope from the outbox, so payloads are never
  stored by the job runtime.
- **trigger.dev tasks run outside Workers** with the Worker's restricted
  runtime database login. Tenant work stays under forced RLS. Push it with
  `trestle jobs env push`, which sends only secrets marked
  `shareWith: [jobs]`, plus `RESEND_API_KEY` wherever email delivery requires
  it, since tasks send email themselves. Cloudflare-only bindings (R2, Queues, Durable Objects)
  are not available in tasks.
- **Inngest runs inside the Worker** through `/api/jobs/inngest`, verified with
  `INNGEST_SIGNING_KEY`. That endpoint is never published in OpenAPI.

## Self-hosting evidence

Gathered on 2026-09-26 on Docker Desktop, with the pinned versions:
trigger.dev v4.6.4, and Inngest v1.45.1 with the Node SDK 4.21.0.

- **Inngest, crash recovery.** A function with a 15-second step received an
  event. The server was `docker kill`ed mid-step and restarted with the same
  configuration.
  - PostgreSQL only: the step finished in the app, but the next step never
    ran. The run was lost.
  - PostgreSQL plus Redis (AOF): the run finished after the restart.

  Redis is therefore required for this profile, and `infra/inngest/README.md`
  says so.
- **Inngest, self-hosted conformance.** The scaffolded
  `infra/inngest/docker-compose.yml` (server plus Redis, external PostgreSQL)
  passed 9/9 with signed keys (`TRESTLE_INNGEST_URL`).
- **trigger.dev, crash recovery.** A 20-second run was in progress when the
  self-hosted webapp and its Redis were killed and restarted. The run
  completed.
- **trigger.dev, product path.** A committed `resource.article.created` event
  was dispatched by the Worker's publisher. It ran in `trestle-event` with the
  application's own consumer, and the inbox shows it completed.
- **Approved Python scripts.** Through self-hosted trigger.dev, `echo-input`
  ran and returned its validated input. A request for `../../bin/sh` failed
  permanently (`AbortTaskRunError`) with no retries.
- **Not verified here:**
  - Deploying `apps/jobs` to a self-hosted trigger.dev container supervisor.
    Locally, the image build's indexing step could not reach an API bound to
    `localhost`; on a server with a DNS name this is the documented path.
  - The Cloudflare Container profile, which needs a Cloudflare account.
  - Hosted trigger.dev and Inngest, which need accounts.

## Running the suites

```bash
# Cloudflare (always), with a database:
TRESTLE_RLS_TEST_DATABASE_URL=… pnpm --filter ./apps/worker exec vitest run src/job-conformance.cloudflare.integration.test.ts

# trigger.dev (hosted or self-hosted):
TRIGGER_ACCESS_TOKEN=… TRESTLE_TRIGGER_API_URL=… TRESTLE_TRIGGER_SECRET_KEY=tr_dev_… TRESTLE_TRIGGER_PROJECT_REF=proj_… \
  TRESTLE_RLS_TEST_DATABASE_URL=… pnpm --filter ./apps/worker exec vitest run src/job-conformance.trigger.integration.test.ts

# Inngest: the Dev Server by default, or a self-hosted server with TRESTLE_INNGEST_URL, _SIGNING_KEY, _EVENT_KEY:
TRESTLE_INNGEST_CONFORMANCE=1 TRESTLE_RLS_TEST_DATABASE_URL=… pnpm --filter ./apps/worker exec vitest run src/inngest/conformance.integration.test.ts
```

Record hosted and deployed runs as `deployed` claims with
`trestle evidence record <id> --env <env> --url <run>`.

## Switching runtimes

`trestle jobs migrate --to <runtime> --env <env>` prints the outbox inventory
(pending, dispatched but not completed, dead-lettered) and the ordered steps:

1. Switch the source (`trestle jobs use <runtime> --yes`).
2. Configure the new runtime's secrets (trigger.dev: deploy `apps/jobs` first).
3. Deploy the Worker. The dispatcher is the only sender, so this deploy moves
   dispatch to the new runtime atomically.
4. Let the old runtime drain the runs it already accepted. Its code and
   bindings stay deployed.
5. `--settle --yes` re-dispatches events the old runtime accepted but no
   consumer completed (for example a cancelled run). The safety sweep does the
   same after 30 minutes; `--older-than` controls the age.
6. Remove the old runtime only when `--check` passes.

A permanently rejected event (for example, expired provenance) is
dead-lettered, not counted as unconsumed, so it never blocks `--check`.
Redrive it explicitly if it should run.

The migration test (`apps/worker/src/inngest/migration.integration.test.ts`)
checks this against the real Inngest engine: Cloudflare → Inngest → Cloudflare
with in-flight, pending, and lost work, asserting that every event completes
exactly once. It is required in CI. Rolling back is the same procedure in the
other direction.

### From the platform admin

The admin **Jobs** view (`/operations/jobs`) runs the same flow without a
deploy, for operators with `platform.jobs.manage`:

1. **Review switch** plans the change and writes nothing: the target must be
   installed in the deployed Worker, its endpoint must be https (http only for
   localhost), a trigger.dev project looks like `proj_…`, and every credential
   the engine needs must be set. The Worker reports which adapters it has and
   whether each credential is set (never a value); a missing one shows the
   `pnpm exec trestle secrets set <NAME> --env <env>` command. Secrets are not
   edited from admin.
2. **Confirm** takes a reason and a fresh step-up, and an experimental engine
   needs an explicit acknowledgement. The change is written as an override
   (`job_runtime_config.override_*`) at the version that was reviewed; a
   concurrent change returns 409. Every change is audited with its before and
   after.
3. The Worker's dispatcher reads the override at most every 30 seconds per
   isolate and sends pending events only to the new engine; event IDs are
   kept. If the override cannot be read, dispatch falls back to
   `TRESTLE_JOB_RUNTIME`; an override naming an engine whose adapter is not
   installed is logged and ignored. Consumers keep accepting work from every
   engine, so the old engine's accepted runs drain.
4. The view shows the migration while the previous engine still has
   unconsumed events. **Settle now** re-dispatches what it never completed
   (after 30 minutes, up to 100 at a time, dead-lettering events at the attempt
   cap), as `--settle` does.
5. **Revert to deploy config** clears the override. To make a switch
   permanent, run `trestle jobs use <runtime>` and deploy, then revert.

**Pause dispatch** stops the Worker sending committed events (they stay
pending and are counted in the view) until it is resumed. It is the only
runtime setting the admin edits: the Worker has no other job setting it
honors at runtime today, so concurrency, retry defaults, and schedule
switches are deferred rather than shown as knobs that do nothing.
