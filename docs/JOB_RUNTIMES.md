# Job runtimes

TrestleJS applications write background work once:

- event consumers, registered with `eventConsumers.register`;
- scheduled jobs, registered with `scheduledJobs.register`.

They then choose where it runs with `jobs:` in `.trestle/project.yaml`. Every
runtime receives the same committed events from the transactional outbox,
under stable event IDs. Every execution re-verifies provenance, the 14-day
replay window, and current entitlements before a handler runs.

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
  `shareWith: [jobs]`. Cloudflare-only bindings (R2, Queues, Durable Objects)
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

`trestle jobs migrate --to <runtime>` plans and performs a switch without
losing or duplicating events. See the command's help for its drain, switch,
and rollback steps.
