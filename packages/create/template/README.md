# __TRESTLE_PROJECT_NAME__

A TrestleJS application.

```bash
pnpm dev
```

The generator creates encrypted, local-only credentials with a random Better
Auth secret and development database defaults. Use `pnpm exec trestle secrets
edit` to inspect or change them in your editor; use `pnpm exec trestle secrets
show` when you intentionally want to print their plaintext values.

The Southwind Astro site runs on `http://localhost:42068`, the authenticated
application runs on `http://localhost:42069`, and the Worker runs on
`http://localhost:8787`. Southwind's authentication and pricing links use
`APP_URL` and default locally to `http://localhost:42069`.

The project-local `trestle-setup` agent skill lives at
`.agents/skills/trestle-setup`. It guides an agent from product discovery
through architecture review, explicit mutation approval, and verification.

The starter includes email/password sign-up and sign-in, database-backed
sessions, a protected dashboard, and organization creation. Replace the
local credentials before using the app outside local development. The generated
local document has this shape:

CI runs a Chromium product test against a freshly migrated PostgreSQL database.
It signs up through the app, opens the locally captured verification link,
signs in, creates two organizations, and checks that switching organizations
also switches the visible billing state. If an Article resource is generated,
the release canary additionally exercises browser CRUD and cross-tenant denial.
To run it locally, migrate an isolated local database, run `pnpm build` to
produce the Astro site, install Chromium with
`pnpm exec playwright install --only-shell chromium`, then run
`TRESTLE_BROWSER_DATABASE_URL=<local-postgres-url> pnpm test:browser`.
The test starts its own Worker and app on ports 8787 and 42069; it refuses to
reuse an unrelated service already listening on either port. It is separate
from `pnpm check` because it requires a real browser and database.
The same browser suite also loads the Astro site and follows its sign-in and
pricing links into the hydrated React application. Preview and production
deploy workflows run the read-only `pnpm test:deployed` against their actual
HTTPS URLs. Preview and staging deploys run site-handoff browser checks.
Preview also signs in with a unique verified test account created directly in
its isolated database, then exercises tenant isolation, test Checkout, and
webhook-projected entitlements without sending email. Staging rotates a dedicated
verified fixture account and automatically checks sign-in, tenant switching,
cross-tenant denial, and forced Article RLS when Article is declared. This
staging check does not send email. The separate, explicit
`pnpm test:staging:live-email` gate signs up with a unique
`example.test` address, locates only that account's redirected verification
message through Resend's sent-email API, verifies the link without printing
the token, signs in, and checks that two organizations stay distinct. When the
application declares an Article resource, staging also creates, edits, reads,
and deletes one through the deployed app and API, checks cross-tenant
read/write denial, and verifies each organization's list remains isolated. If
Queues are declared with Article, staging uses the restricted runtime
`DATABASE_URL` to wait for that Article's committed outbox event to be sent
and its Queue or Workflow consumer receipt to complete; this does not add a
public introspection route. When R2 is declared, staging also uploads an
artifact, reads a signed URL, rejects
a forged tenant and cross-tenant access, and verifies deletion revokes that
URL. This requires a staging Resend key with sent-email list/read access. The test
confirms provider acceptance and redirection, not inbox delivery; staging
canary accounts remain in the staging database until the application's
retention policy removes them. `pnpm test:preview:live-email` sends one
redirected verification message and exercises preview signup and sign-in;
the automatic preview product check covers billing separately. Neither live-email command is run
by an automatic workflow: each invocation consumes Resend quota and creates a
new test account. Local browser and CI tests use local email capture instead.
Production never runs these mutating tests.

```yaml
BETTER_AUTH_SECRET: <randomly generated>
BETTER_AUTH_URL: http://localhost:42069
DATABASE_DRIVER: postgres-js
DATABASE_URL: postgres://trestle:trestle@localhost:55432/__TRESTLE_PROJECT_NAME__
```

Email is captured locally by default. Use `pnpm exec trestle email list`,
`pnpm exec trestle email show <id>`, `pnpm exec trestle email open <id>`, and
`pnpm exec trestle email clear` while the
Worker is running. Preview, staging, and production use the Resend adapter with
`RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` stored through `trestle secrets`;
`EMAIL_FROM`, `EMAIL_REPLY_TO`, and the preview/staging redirect recipient are
typed non-secret deployment configuration. Preview and staging require that
redirect: direct provider delivery to the original recipient is reserved for
production.

Verify provider lifecycle and staging safety with `pnpm exec trestle email
doctor --env staging`. The generated protected provider workflow performs a
real staging test only when manually dispatched: it authenticates the provider
keys, sends one harmless Resend message through the recipient redirect and
verifies the accepted recipient and idempotent retry, then creates a Stripe
test-mode Checkout session and verifies its idempotent retry. It sends no
email to the original `example.test` address and completes no payment.

Cloud deployments use Neon's Worker-native WebSocket driver so interactive
PostgreSQL transactions work. The legacy `neon-http` driver setting is treated
as a compatibility alias for the transactional serverless driver. Local development
sets `DATABASE_DRIVER=postgres-js` in encrypted credentials so the same app can
use the Compose PostgreSQL instance directly. No persistent `.dev.vars` file is
created by `trestle dev`.

Staging and production use separate database credentials:

- `DATABASE_MIGRATION_URL` is available only to the protected deployment job;
- `DATABASE_URL` is the restricted Worker runtime credential; and
- the GitHub environment variable `DATABASE_RUNTIME_ROLE` names that runtime
  PostgreSQL login role.

The generated deployment workflow grants that login permission to assume the
non-login `trestle_app` role, rejects superuser or `BYPASSRLS` runtime roles,
runs migrations with the migration credential, and verifies the runtime
credential before deploying. Create the restricted login and write its generated
connection URL directly into encrypted credentials with:

```bash
pnpm exec trestle db roles bootstrap --env staging --role trestle_runtime --yes
pnpm exec trestle db roles bootstrap --env production --role trestle_runtime --yes
```

The command never prints the generated password or connection URL. Preview
bootstraps an equivalent restricted login inside its isolated Neon branch and
passes the masked URL only between deployment steps. Configure `APP_URL`, `API_URL`, `SITE_URL`, and
`DATABASE_RUNTIME_ROLE` independently in the `preview`, `staging`, and
`production` GitHub environments. Preview also requires
`CLOUDFLARE_WORKERS_SUBDOMAIN`. When `capabilities.admin` is true, staging and
production also need `ADMIN_URL`, `ADMIN_API_URL`, and
`DATABASE_ADMIN_RUNTIME_ROLE`; see `apps/admin/README.md`.

Trusted pull requests receive isolated, deterministically named Workers and
Pages projects. Closing the pull request deletes those Cloudflare resources.
Use a long-lived token scoped to the same Cloudflare account as
`CLOUDFLARE_ACCOUNT_ID`, with `Workers Scripts Write` and `Pages Write`
permissions in each GitHub deployment environment; an interactive
Wrangler OAuth access token is not a durable CI credential.
If `capabilities.queues` is enabled, grant `Queues Write` on that same account.
The deployment workflows then provision per-environment Queues, render a
producer/consumer binding with a dead-letter queue and the due-time scheduler
(see "Scheduling"), and isolate preview Queue names by pull request. Preview cleanup deletes only its
own Queues after deleting its Worker. Queues remain opt-in until this hosted
path has been verified against a real account.
If a Cloudflare account has exhausted its cron-trigger quota, a preview-only
Worker can be rendered with
`node scripts/queue-config.mjs render preview <worker-name> --without-cron`.
This keeps Queue, R2, Workflow and scheduler bindings for deployment and browser
checks: committed events still dispatch and due work still runs, but the
safety sweep and hourly maintenance do not. Use the same rendered config for
secret uploads and deployment. Staging and production still require the cron
triggers; a cron-free preview does not verify them or establish production
readiness.
Staging and production check account-wide cron capacity before provisioning,
database migration, or Worker upload. The check assumes the Cloudflare Workers
Free plan (five triggers) unless the deployment environment sets
`CLOUDFLARE_WORKERS_PLAN=paid` (250 triggers). It reads schedules and credits
an existing trigger on the target Worker during redeployment; it does not
change or remove other Workers' schedules. A full account must gain capacity
before the cron-enabled deployment can proceed.
Application crons declared under an environment's `triggers.crons` in
`apps/worker/wrangler.jsonc` are kept, in order, and the framework's two crons
(the `*/15 * * * *` safety sweep and `7 * * * *` hourly maintenance) are
appended only when Queues or R2 need them. Each cron counts toward the
capacity check; the framework's two per environment leave one Free-plan
trigger for staging and production together. The Worker's `scheduled` handler
runs framework work only on those two expressions; handle your own crons
there, keyed on `event.cron`, or better, register due work (see
"Scheduling"). Preview Workers still receive no crons.

### Scheduling

An idle project makes no database queries. Nothing polls PostgreSQL on a short
timer: work runs when it is due, through one Durable Object, `TrestleScheduler`
(`apps/worker/src/scheduler-object.ts`), bound as `TRESTLE_SCHEDULER`.

- **Dispatch on commit.** When a request commits outbox rows (through
  `ctx.events`), the Worker makes the outbox due immediately and the scheduler
  publishes it to the Queue within milliseconds. The outbox stays the durable
  source; the wake-up is only an optimization.
- **Due-time alarms.** Code that creates future work records its due time with
  the scheduler. The object keeps one alarm for the earliest due time; the
  alarm runs what is due and re-arms only while work remains. With nothing
  pending there is no alarm and no database connection. Outbox publish
  retries, local webhook retries and application jobs all run this way.
- **Safety sweep.** Every 15 minutes a cron drains the outbox, repairs native
  webhook handoffs, and re-records every job's next due time, so a lost
  notification is late by at most one sweep, never dropped. Artifact and
  webhook-payload maintenance runs hourly.

`wrangler.jsonc` binds the scheduler for local development, so its alarms run
under `wrangler dev`; `GET /api/dev/scheduler` shows what it holds (local
only). `scripts/queue-config.mjs` adds the binding and its SQLite class
migration, `trestle-scheduler-v1`, to every deployed environment that enables
Queues or R2, preview included. Durable Object migrations are append-only:
never edit or remove one after it is deployed.

Register application due work in `apps/worker/src/jobs.ts` instead of adding
a cron:

```ts
import { dailyAt, every } from "./scheduler.js";

// "Every 15 minutes": pure arithmetic, no query to decide when it is due.
scheduledJobs.register("weather.refresh", {
  requires: { capability: "queues" },  // skipped, never run, without a Queue
  next: every({ minutes: 15 }),
  limit: 50,                           // items per run
  run: async (job) => {
    for (const garden of await dueGardens(job.limit)) {
      if (job.signal.aborted) return { more: true };  // the lease is ending
      const { data, events } = job.tenant(garden.organizationId);
      await data.transaction(async (transaction) => {
        await transaction.execute(events.statement("weather.evaluation.requested",
          { gardenId: garden.id }, { idempotencyKey: `weather:${garden.id}:${job.dueAt.toISOString()}` }));
      });
    }
  },
});

// "At 07:00 local time", or "whenever my own table says": next() may read one indexed row.
scheduledJobs.register("digests.daily", {
  next: async ({ environment }) => await earliestDigestDueAt(environment),  // Date | null
  run: async (job) => { /* claim due digests, send, record; bounded by job.limit */ },
});
```

- `next()` returns when the job is next due, or `null` when nothing is
  pending. It runs after every run and on the safety sweep; keep it to one
  indexed query or to `every()` / `dailyAt({ hour, minute, timeZone })`.
- `run()` is bounded: process at most `job.limit` items, stop when
  `job.signal` aborts, and return `{ more: true }` to continue immediately.
- Runs are lease-safe. A PostgreSQL lease (`scheduled_job`) lets one run of a
  job proceed at a time, fenced by `job.lease.token`, and a due slot that
  completed is never run again, so an overlapping or repeated trigger is a
  no-op. A crash mid-run repeats the slot, so derive item idempotency keys from
  `job.dueAt`.
- Emit events only through `job.tenant(organizationId).events` inside a
  `data.transaction`. They take the committed-event path: the outbox,
  verification and the 14-day replay window, like any request's events. Never
  send to the Queue directly.
- When a request creates future work, commit it first, then call
  `await scheduledJobs.notify(context.env, "digests.daily", dueAt)`. Notifying
  before the commit can wake the job before the work is visible.
- `requires: { capability }` (`queues`, `r2` or `workflows`) skips the job when
  that binding is absent. A deployed environment with registered jobs and no
  scheduler binding fails its safety sweep loudly.
- As with event handlers, `job.environment` is the raw Worker environment:
  the job context is the supported seam, not a sandbox.
The automatic preview browser gate checks deployed sign-in, organization
isolation, test-mode Checkout, and signed Stripe webhook entitlements without
sending email. It creates a verified credential fixture directly in the
isolated preview database, so it does not prove provider email delivery. The
explicit `pnpm test:preview:live-email` gate verifies redirected email signup
and verification; run it sparingly when fresh Resend evidence is required.
`BETTER_AUTH_URL` in deployed preview must be the Worker API origin so
verification and reset links reach the auth handler; the Pages app origin is
passed separately as `WEB_ORIGIN` for trusted browser requests.
If `capabilities.r2` is enabled, grant `Workers R2 Storage Write`. The workflows
provision a separate bucket per environment; preview cleanup deletes its bucket
only when empty and never purges application artifacts.
Set the encrypted Worker secret `ARTIFACT_SIGNING_SECRET` to at least 32 random
bytes in each R2-enabled remote environment. The Worker stores tenant-owned
artifact metadata in PostgreSQL, serves uploads through `POST /api/artifacts`,
and issues short-lived download links through `GET /api/artifacts/:id/access`.
Artifact IDs are single-use, including after deletion, so an old signed link
cannot become valid for a replacement object. R2 uploads reserve tenant-owned
metadata in a pending state before writing a uniquely keyed object. Pending
artifacts cannot be read or signed; successful writes move to ready. If the
upload fails, the reservation is released only after R2 deletion is confirmed;
an uncertain finalization retires the ID. These links are
bearer capabilities: do not log or share them. Local development
uses an in-memory store and the local auth secret for signing if no dedicated
artifact signing secret is set.
The R2 adapter exposes bounded `recoverIncomplete(organizationId, before, limit)`.
Scheduled maintenance pages through organizations and uses tenant-scoped recovery
to claim stale pending records, delete their exact R2 keys, retry failures, and
retire recovered IDs. It also audits bounded pages of ready PostgreSQL references
using metadata-only R2 HEAD requests under tenant-scoped database access.
Missing or mismatched objects fail the scheduled run and are logged by artifact
ID and organization ID without object keys or contents; the audit never deletes
anything. A second bounded audit lists old R2 objects by tenant prefix, checks
for any live PostgreSQL reservation under tenant RLS, and reports unreferenced
objects by key fingerprint only. It never deletes an orphan automatically.
The protected restore drill also checks every ready reference in its isolated
PostgreSQL branch against the declared production bucket using read-only S3
HEAD requests. Missing objects, metadata drift, or provider errors fail the
drill. Ready-object retention is opt-in: set the non-secret Worker variable
`ARTIFACT_READY_RETENTION_DAYS` to an integer from 1 to 3650 in each desired
R2-enabled Worker environment. Without it, ready objects are retained indefinitely. Once set,
objects older than that many 24-hour days become unreadable immediately; a
bounded tenant-scoped scheduled sweep claims and deletes them from R2. Failed
R2 deletes remain inaccessible and are retried by incomplete-object recovery.
Choose the period deliberately: enabling it also applies to existing ready
objects older than the cutoff. The value is a duration, not a calendar-day rule.
Queue delivery is at least once. The PostgreSQL event inbox prevents a completed
logical event from running its handler again and leases in-progress work for
recovery. Handlers that call external services must still pass the event's
stable `idempotencyKey`: a crash after an external side effect but before the
inbox completion record can cause that operation to be retried.

A Queue or Workflow message only refers to committed work. Before any handler
runs, the Worker reloads the committed outbox row by event ID and requires an
exact match on identity, type, version, resource, payload, idempotency and
correlation data. The handler receives the committed event, and the tenant
always comes from the committed row, never from the message.

Register a handler with the authority it needs:

| Registration | `context.organizationId` | `context.data` |
| --- | --- | --- |
| `eventConsumers.register(event, handler)` (undeclared, `"verified"`) | the committed organization | none |
| `eventConsumers.register(event, handler, { authority: "tenant" })` | the committed organization | a database scoped to that organization under forced RLS, opened when first read and closed after the handler |
| `eventConsumers.register(event, handler, { authority: "system" })` | none (work without a tenant) | none |

This is not a sandbox: handlers still receive the raw Worker `environment`,
including `DATABASE_URL`, and could use it to bypass their declared
authority. The scoped context is the supported seam.

Generated resource handlers declare `"tenant"`. An event without a committed
organization never reaches a verified or tenant handler. Handlers are called
as `(payload, envelope, environment, context)`; `context` also carries
`event`, `authority`, a correlated secret-redacting `log`, and an injectable
`clock`.

`{ requires: { entitlement: "..." } }` checks the tenant's current plan
entitlements each time the handler would run. If the tenant lacks it, only
that handler is skipped (logged as `event.handler.skipped`, reason
`not_entitled`); webhook projection still runs and the event completes. The
handler is not re-run if the entitlement is granted later.

Handlers run only while the committed event is at most 14 days old, measured
from its committed `occurredAt`: this covers first delivery, retries,
dead-letter replay and Workflow resumption, and Workflows reverify at every
execution of the consume step. Committed provenance is kept for 30 days, so pruning never
removes a row that permitted work can still need. Messages whose
provenance is missing, mismatched, expired or tenantless never reach the
handler: the Queue path logs
`queue.event.rejected` with the event ID and reason (never the payload) and
retries the message into Cloudflare's dead-letter queue; a Workflow fails
with a non-retryable error (`workflow.event.rejected`). Rejected messages are
never acknowledged as handled. Database outages and other transient errors
stay retryable.

Define application events in `packages/events/src/application-catalog.ts` with
`defineEvent(...)` and `defineEventCatalog(...)`. Internal event payloads have
runtime schemas and are private by default. An explicit `webhook` projection
adds a separately versioned, validated public contract with examples and
projection fixtures. The generated database now includes tenant-owned endpoint,
subscription, message, delivery, attempt, and encrypted signing-secret tables.
For a domain mutation, compose `execution.events.statement(name, payload,
{ schemaVersion, idempotencyKey })` with the mutation inside one
`execution.data.transaction(...)`, executing the returned statement through
that transaction. The event publisher validates the internal schema, resolves
the resource from the application catalog, and binds organization and
correlation from the authenticated execution context. The idempotency key is
scoped to that organization. The statement does not publish directly or commit
on its own; if the domain transaction rolls back, the event rolls back too.
Do not send a provider webhook inside the transaction.
New resources generated by `trestle generate resource` register private
`resource.<name>.created`, `resource.<name>.updated`, and
`resource.<name>.deleted` application events. Create, changed update, and
delete operations commit their mutation and outbox row in one transaction.
Updates increment a persisted revision; an identical retry is a no-op and
does not emit another event. A repeated delete does not emit another event.
`PATCH` and `DELETE` accept an optional `If-Match: "<revision>"` header; when
the stored revision differs they write nothing and return `409` with
`error: "revision_conflict"` and the `currentRevision`. The generated screen
and API client send the revision they loaded, so a concurrent edit is reported
rather than silently overwritten. Omitting the header keeps last-write-wins.
These internal events are not automatically exposed as customer webhooks.
At initial generation, `--webhook-event created updated` explicitly selects
versioned, metadata-only public projections for those event kinds; unselected
events remain private. The same selection can be declared as `webhookEvents`
in a resource SetupPlan. Generated public schemas, examples, and projection
fixtures belong to the application and should be reviewed before deployment.
Changing exposure for an existing generated resource is a deliberate
application-owned catalog edit, not an implicit regeneration.
The generated system test can exercise the opted-in Article path with
`TRESTLE_SYSTEM_TEST_WEBHOOKS=1`: it registers a local endpoint, captures a
signed attempt without network delivery, and verifies retry idempotency and
inspection redaction. This requires `TRESTLE_SYSTEM_TEST_ARTICLES=1` and a
dedicated test PostgreSQL database.
With `WEBHOOK_DELIVERY_MODE=local` in a local environment and Queues enabled,
the Worker projects catalog-declared events after outbox dispatch, then
automatically captures a signed local attempt for each active subscribed
endpoint within the Queue inbox retry boundary. Duplicate Queue deliveries do
not duplicate completed attempts. An advanceable-clock local flush processes
later due retries without sleeping. Disabled mode is the default. Native and
Svix modes fail closed until their delivery adapters ship. Local capture never
sends a remote webhook request.
Scheduled local maintenance erases public payloads and captured signed request
material after 30 days for standard events or seven days for short events.
Delivery and attempt status metadata remains; expired pending work is stopped,
and an active delivery lease delays erasure until the lease ends. Applications
should review these default retention periods against their own policy.
The native egress policy validates HTTPS destinations and resolves both DNS
address families anew for each attempt. It rejects the entire response if any
address is non-public. A future transport must connect only to an approved
address while using the original hostname for TLS verification. The included
pinned HTTPS transport has bounded timeouts and headers and never follows
redirects. Native Queue dispatch is wired but remains opt-in. Known issue:
Cloudflare Workers cannot use this project's IP-pinned socket transport for
ordinary HTTPS destinations on port 443, while Workers `fetch` cannot
guarantee that the approved DNS address is the one contacted. Native
production delivery therefore remains fail-closed; a verified egress design
is deferred. Do not enable native mode for production until that guarantee is
implemented and tested on Cloudflare.
When enabling outbound delivery, set the optional encrypted Worker credential
`WEBHOOK_SECRET_KEY` to at least 32 random bytes per environment through
`trestle secrets edit`; it encrypts endpoint secrets at rest. Endpoint secrets
are disclosed once at issuance or rotation. Do not expose the internal
`activeForDelivery` method through customer or admin routes.
Organization owners and admins can register destinations at
`/settings/webhooks` after the application declares at least one public event
projection. Registration requires the signing key, an HTTPS public destination,
and an eligible event subscription; it returns the signing secret once. New
endpoints start disabled. Activation is offered only when the corresponding
local or native delivery mode is configured. The catalog, registration, and
state APIs require an authenticated selected organization, and the mutation
routes verify the browser origin. Do not put signing keys into application logs
or endpoint URLs.
The endpoint detail screen can replace its complete public-event subscription
set. Changes are validated against the current event catalog and plan
entitlements and affect future events only; previously created deliveries
retain their committed identity and status.
A failed delivery can be replayed by the organization or the platform admin
only while its source event is at most 14 days old and its committed outbox
record is still retained; otherwise the replay is refused with a conflict
error. Both delivery views report such a delivery as `provenance_expired` and
disable the replay action with that explanation; the server's refusal remains
authoritative. Platform replay runs through a SECURITY DEFINER function owned
by `trestle_webhook_replay`, a NOLOGIN role that no login is a member of and
that can read and write only the webhook columns replay needs. A native delivery whose source event passes the 14-day window, or whose
outbox record is gone, is settled as `exhausted` with the terminal reason
`provenance_expired` (by its Queue consumer, or by the safety sweep's recovery) instead
of waiting in retry.
If `capabilities.workflows` is enabled, the deployment config binds the
application-owned `TrestleWorkflow` class. Queue delivery starts a Workflow
using the event ID as its stable instance ID; a repeated Queue delivery
reuses the existing instance. The Queue consumer verifies and authorizes the
committed event before creating the instance, so a forged message cannot claim
its ID and an event the Workflow would reject goes to the dead-letter queue. The
Workflow validates and reverifies the event at every execution of the
consume step,
executes the registered handler as a retryable step, and records completion
through the PostgreSQL inbox. Local development keeps direct Queue handling
and offers an advanceable-clock Workflow scheduler for deterministic tests.
Inspect or restart failed remote instances with Wrangler's Workflow commands;
provider retention is not a substitute for PostgreSQL's completion record.
`CLOUDFLARE_WORKERS_SUBDOMAIN` is the account label before `.workers.dev`; it
is used to derive the Worker URL exercised by the preview smoke gate. Preview
preflight verifies that it matches the configured Cloudflare account. Preview
database branching is a separate provider lifecycle and must be configured
with `NEON_PROJECT_ID`, `NEON_DATABASE`, `NEON_MIGRATION_ROLE`, and the
encrypted CI credential `NEON_API_KEY`. Each trusted pull request then receives
an isolated Neon branch and unpooled runtime URL (required for PostgreSQL
startup role options); closure deletes that branch. The preview workflow checks
Cloudflare and Neon access independently before Doctor or resource creation.
Doctor then requires real Resend and Stripe test-mode configuration before the
preview can deploy. A read-only provider preflight checks that the encrypted
Resend and Stripe keys are active and have the required read access before
provisioning; the email doctor also verifies that the configured sender domain
belongs to and is verified in the chosen Resend account. Provider access alone
does not mark a preview as ready.
Stripe readiness requires a price ID for every declared plan, a matching
test/live publishable key, and a safe HTTPS billing return URL. An empty or
partial `STRIPE_PRICES` map is not deployment-ready. `trestle payments stripe
sync --env staging` reports the intended mapping before it is applied to the
environment configuration.
The Stripe server key may be a full `sk_test_`/`sk_live_` key or a restricted
`rk_test_`/`rk_live_` key with the permissions your application actually uses.
Doctor checks the environment prefix; deployment preflight checks live API
read access, and the protected staging provider gate checks a redirected send
and test-mode Checkout. Verify write permissions through a controlled
test-mode Checkout and webhook run before treating billing as production-ready.
A signed subscription webhook is a notification, not state. The Worker
commits the verified receipt and a durable reconciliation request in one
PostgreSQL transaction and only then answers 2xx; it does not wait for
Stripe. With a Queue binding the request is a private, tenantless outbox
event (`billing.subscription.reconciliation_requested`) handled with
`{ authority: "system" }` after committed-event verification. Enable Queues
for Stripe test and live mode; without a Queue the Worker runs the same
reconciler after the commit and answers 503 on provider failure, so Stripe's
redelivery retries it. The reconciler leases the subscription's request,
retrieves the current subscription with no database transaction open, and
commits the subscription, entitlements, and billing event together only while
it still holds the lease. A slower or stalled lookup is fenced and cannot
overwrite newer state, even after its lease expires; a webhook that arrives
mid-reconciliation causes another pass. Provider failures keep the last
confirmed projection and leave a retryable, redacted receipt. A subscription
Stripe reports missing, or one without a known organization and plan, is
rejected and logged (`billing.reconciliation.rejected`) without changing
billing. Local mode takes the same path: the local payment adapter changes
local provider state and reconciles it through the same durable request,
inline and deterministically, and signed fixtures work without a Stripe
account.
The provider subscription ID is also bound permanently to one organization.
Another tenant cannot claim it through webhook metadata, an active subscription
cannot be silently replaced by a second ID, and late events from a canceled
subscription cannot reactivate it after a replacement.
Verified subscription changes also append an internal billing event in the
same PostgreSQL transaction as the subscription, entitlements, and processed
webhook receipt. These events carry normalized plan and status, not Stripe
customer IDs or credentials, and are not public outbound webhooks.

Validate the checked-in delivery contract locally with:

```bash
pnpm exec trestle ci validate
pnpm exec trestle env status --env staging
pnpm exec trestle logs --env staging --status error
```

`trestle logs` projects Cloudflare's raw tail into validated semantic event
records. It displays only timestamp, level, event, UUID correlation ID, status,
and duration; request URLs, headers, exception text, arbitrary console output,
and unknown metadata are withheld. `--search` filters event names locally, not
raw provider payloads. Use `--format json` for the same bounded fields as JSON.
Direct `wrangler tail` is a separate trusted diagnostic operation and may
expose sensitive data.

## Operations and recovery

Local development is deterministic. `trestle dev` applies the idempotent
default seed; `trestle dev --fresh --yes` removes only this project's declared
Compose volumes and Wrangler local state before migrating and reseeding. Use
`pnpm exec trestle db seed --scenario demo` or `tenant-isolation` for explicit
fixtures. Tests can use the fixed, advanceable clock exported by the context
package without sleeping.

The console, queue, Workflow, backup, restore and platform admin commands are
experimental during beta: they run only when the invocation passes
`--experimental` or the environment sets `TRESTLE_EXPERIMENTAL=1`.

The application console is tenant-bound and read-only by default:

```bash
pnpm exec trestle --experimental console --tenant <slug>
pnpm exec trestle --experimental console --tenant <slug> --write
pnpm exec trestle --experimental console --platform-admin
```

Tenant and platform access are separate authority planes. The console exposes
curated application helpers rather than a raw database handle, records session
audit events, and requires explicit confirmation for remote environments.

Queue and Cloudflare Workflow operations are similarly explicit:

```bash
pnpm exec trestle --experimental queue dlq list --env staging
pnpm exec trestle --experimental queue dlq redrive <id> --env staging
pnpm exec trestle --experimental queue prune --env staging --before 2026-01-01T00:00:00Z
pnpm exec trestle --experimental queue prune --env staging --before 2026-01-01T00:00:00Z --limit 1000 --apply
pnpm exec trestle --experimental workflow list <name> --env staging
pnpm exec trestle --experimental workflow status <name> <instance-id> --env staging
pnpm exec trestle --experimental workflow retry <name> <instance-id> --env staging --yes
```

`queue prune` reports eligible records unless `--apply` is passed. It removes
only succeeded outbox records processed before the explicit UTC cutoff, in
bounded batches; pending, leased, and dead-lettered records are never pruned.
The cutoff must be at least 30 days old, and records still referenced by an
active inbox claim or an unfinished webhook delivery are kept. The command
reports the age of the oldest succeeded record kept. A succeeded record has
only been sent to the Queue; its handler may not have run yet. `queue prune`
and `queue dlq` run as the migration role (`DATABASE_MIGRATION_URL`, falling
back to `DATABASE_URL`). Pruning calls two SECURITY DEFINER functions owned by
`trestle_retention`, a NOLOGIN role that can read only the columns the
retention checks need across tenants and delete outbox records; only the
migration role may execute them, and no login is a member of the role.
Outbox failures record only a sanitized error category, never the error
message, so provider secrets echoed in exceptions are not persisted.

Neon recovery policy lives in `.trestle/recovery.json`. Provider history alone
is not accepted as proof of recovery. `backup verify` creates an isolated
point-in-time branch, verifies migration history, Better Auth integrity,
forced RLS, the restricted runtime role, and adversarial tenant isolation,
then verifies every ready artifact against the declared R2 bucket, writes
non-secret evidence, and deletes the drill branch:

```bash
pnpm exec trestle --experimental backup status --env production
pnpm exec trestle --experimental backup verify --env production --to restore-test --yes
pnpm exec trestle --experimental restore create --env production --to restore-test --at <iso-time> --yes
pnpm exec trestle --experimental restore delete --env production --target restore-test --yes
```

The generated weekly `backup-verify.yml` workflow runs the same protected drill
and records evidence in the GitHub Actions summary. Configure `NEON_PROJECT_ID`,
`NEON_DATABASE`, `NEON_MIGRATION_ROLE`, and `DATABASE_RUNTIME_ROLE` as protected
environment variables; keep `NEON_API_KEY` in Trestle encrypted credentials and
provide `TRESTLE_MASTER_KEY` only to the protected GitHub environment.
If the restored database has ready artifacts, also configure a bucket-scoped,
read-only R2 S3 key pair as `R2_RECOVERY_ACCESS_KEY_ID` and
`R2_RECOVERY_SECRET_ACCESS_KEY` in the production Trestle encrypted credentials,
and provide `CLOUDFLARE_ACCOUNT_ID` to the protected GitHub environment. Review
`artifactBucket` in `.trestle/recovery.json` against the actual production R2
binding before relying on the result. Neither key nor object names are written
to recovery evidence. A historical restore may fail if the application has
deleted an object since that point; a retention policy is still required.

## Evolving a Trestle project

Resource generation accepts additive field, relationship, authorization, and
cursor-pagination declarations. Extra fields start optional so the first
migration is safe for existing rows; relationships start nullable for the same
reason.

```bash
pnpm exec trestle generate resource Author
pnpm exec trestle generate resource Article \
  --field summary:text? \
  --field published:boolean? \
  --field authorId:relation?:Author:set-null \
  --read-permission resource.read \
  --write-permission resource.write
pnpm exec trestle resource add-field Article archived:boolean? --yes
```

Field types are `string`, `text`, `integer`, `boolean`, `datetime`, `json`,
`decimal(precision,scale)`, `enum(value|value)` and `relation`, for example
`--field meta:json? price:decimal(10,2)? status:enum(draft|published)?`.
Decimals travel as strings in the contracts so no digits are lost; enum values
are also enforced by a database check constraint. Generated repositories stamp
`updatedAt` with the execution context's clock, so fixed-clock tests are
deterministic.

A relationship is a composite foreign key from `(organization_id, author_id)`
to the parent's `(organization_id, id)`, so a row can only reference a parent
in its own tenant. Relations generated before TrestleJS 0.1.0-beta.2 referenced
the parent by ID alone; `trestle doctor` reports them. Adopt the composite keys
with `trestle resource migrate-relations`: the dry run lists the relations and
runs a read-only preflight counting cross-tenant links and missing parents
(`--env <environment>` checks that environment's database). It never repairs,
reassigns or deletes rows; correct any it reports first. `--yes` rewrites the
schemas and generates a migration that adds each composite key `NOT VALID`,
validates it, and only then drops the ID-only key. `drizzle-kit migrate` applies
it in one transaction, so writes to both tables wait until it commits: apply it
in a quiet window, and preflight every environment before deploying it.

Shared reference data, such as a catalog every organization reads, uses
`trestle generate resource Crop --shared`. The table has no `organization_id`.
Forced RLS lets the tenant runtime role only read it, and only the
`trestle_platform` role may write. Customer routes and screens are read-only.
The generator registers a platform permission (`platform.crops.manage`) and a
platform editor in `packages/db/src/crop-editor.ts`. Each editor change needs a
reason and the expected revision, and is audited in the same transaction. With
the platform admin enabled, it also generates an admin view and admin Worker
routes that require that permission and fresh step-up. No platform role
includes the permission until you add it to one in
`packages/authz/src/role-definitions.ts`. Tenant resources may reference a
shared resource (`cropId:relation?:Crop:restrict`) with a plain foreign key,
because the shared parent has no tenant to match. Shared resources cannot
reference tenant resources.

The platform admin cannot read tenant resources by default. To let operators
browse one across organizations, declare it with
`trestle resource admin-read Article --yes`. That registers
`platform.articles.read` and adds an RLS select policy and a `SELECT` grant for
`trestle_platform` only; it never grants writes. It also generates admin Worker
routes and a list/detail view (filter by organization, cursor pagination).
Opening a record writes `platform.article.viewed` to that organization's audit
history. Changes to tenant data stay in the customer application's own
operations. As with shared resources, add the permission to a platform role
before anyone can use it.

`pnpm db:generate` preserves a strictly increasing migration journal timestamp,
including when an older checked-in migration was future-dated. A generated
release canary checks that running it without schema changes creates no drift.

### Local status and ports

`pnpm exec trestle status` reports every local service with one of these
states: `healthy`, `starting`, `failed`, `disabled`, or `unconfigured`. It
covers the site, app, API, admin and admin API, the database, migrations
applied against the journal, the email sink, the scheduler, and the email and
billing providers. Each problem comes with a repair command. `--json` gives the
same data in machine-readable form, and the command exits non-zero while any
service is unhealthy. A port answered by another project's server is reported
as a failure, not as this project's service.

Before starting, `trestle dev` checks its fixed ports (42068, 42069, 42070,
8787, and 8788) and names any process holding one:

- `--reclaim` stops stale processes that belong to this project.
- An unrelated process is never stopped unless you name its port with
  `--takeover <port>`.

After a partial start, run `trestle status` to see which service failed, then
rerun `trestle dev --reclaim`.

### Development accounts and seed data

`pnpm exec trestle dev-account dev@example.test --password-stdin --organization acme --app-role editor --platform-role platform_operator`
creates or finds a verified local account. Pipe the password on standard input;
it is never printed or logged. The command also creates or joins the
organization (`--org-role owner|admin|member`), grants application roles
(tenant authority), and grants platform roles (operator authority in the
platform admin). It is idempotent: rerun it to add roles, and it never removes
anything. It refuses non-local databases.

The data commands are separate:

- `trestle db seed --scenario <name>` is additive. It upserts only the
  scenario's own fixed rows and keeps your development accounts and
  application data.
- `trestle db reset --yes` deletes the local database volume.
- `trestle dev --fresh --yes` removes declared project-local state before
  startup.
- `trestle dev` migrates and applies the additive default seed on every start,
  so it never deletes data.

### Upgrading a customized project

Upgrades keep your changes. After installing the new CLI:

1. `pnpm exec trestle upgrade diff` classifies every template file:
   - `unchanged`: you never edited it, so it is updated.
   - `kept`: you edited it and the framework did not, so your version stays.
   - `modified`: both changed it, so it is merged three ways.
2. If you generated migrations since the last release,
   `pnpm exec trestle upgrade migrations --rebase --yes` adopts the framework's
   new migrations and renumbers yours after them. It keeps their SQL and
   timestamps and merges the schema snapshots.
3. `pnpm exec trestle upgrade source-apply --yes` applies the changes.
   Deployment and configuration files (workflows, `wrangler.jsonc`, `config/`)
   change only when you name them with `--accept <file>` after reviewing
   `pnpm exec trestle upgrade diff --path <file>`. A real conflict is left
   marked with `<<<<<<<`.
4. `pnpm db:migrate` refuses migrations that Drizzle would silently skip. That
   happens when a database already applied your migration and the framework's
   are older. Apply them once with `pnpm db:migrate -- --apply-skipped`.
5. `pnpm exec trestle upgrade source-finalize --yes` runs `pnpm check` and
   records the new baseline. Your edits stay yours for the next upgrade.

### API contracts

The OpenAPI documents are generated from the route policies in
`packages/authz/src/routes.ts` and the operation contracts in
`packages/contracts/src/api.ts`, not maintained separately. Generated
resources register their operations there automatically. Each operation
declares its Zod params, query, body, and responses, a stable
`operationId`, and a classification: `public`, `browser-internal`,
`admin-internal`, `webhook`, or `machine`. The route policy supplies
authentication, the permission, and the standard 401 and 403 errors.

- Locally, `GET /api/openapi.json` documents every route and `/api/docs` is an
  interactive reference. Elsewhere only `public` and `machine` routes are
  published, and `/api/docs` is not served.
- The admin document is at `GET /api/admin/openapi.json`. It requires
  `platform.overview.read`.
- `pnpm exec trestle api spec --out openapi/app.json` writes the document.
  `--check` fails when a committed copy has drifted, and `--report` lists
  routes without schemas, excluded routes, and contracts with no route.
- `validateApiResponse(operation, status, body)` checks a real response
  against its contract in tests. Generating the document does not validate
  runtime output.
- Better Auth's `/api/auth/*` handler is excluded; see the Better Auth API
  reference.

External consumers can generate a typed client with
`pnpm dlx openapi-typescript openapi/app.json -o openapi/app.d.ts`. In-repo
screens import the Zod contracts directly.

Generated screens use application-owned typed API clients rather than local
unvalidated fetch helpers. List endpoints use bounded cursor pagination, and
every generated operation declares its application permission before reaching
the repository. `resource add-field` refuses required additions: add, backfill,
verify, and only then tighten a database constraint deliberately.

Organization membership and product access are separate authority planes.
Every permission is registered once, in one plane, in
`packages/authz/src/permissions.ts`. Organization roles (`owner`, `admin`,
`member`) come from membership and govern the account: billing, webhooks, and
members. Application roles (`app_admin`, `editor`, `reader`) are stored
separately in `application_role_assignment` and govern product actions, so an
organization Owner has no product authority without one. Creating an
organization makes you its `app_admin`; members who join later have no
application role until one is granted (`packages/authz/src/policies.ts`). Application administrators change
roles with `PUT /api/tenant/users/:userId/application-roles`, and
`GET /api/tenant/access` explains your own effective access. Every Worker route
declares its authority in `packages/authz/src/routes.ts`, and the middleware
enforces it before the handler runs.

Project upgrades are dry-run first and preserve application-owned source and
custom skill guidance:

```bash
pnpm exec trestle upgrade plan
pnpm exec trestle upgrade plan --check
pnpm exec trestle upgrade apply --yes
pnpm exec trestle architecture check
```

Upgrade state and framework compatibility are versioned under `.trestle`.
Static architecture checks detect direct provider leakage into application or
domain code, missing declared resource source, missing forced RLS, and stale
managed-guidance markers. CI runs those checks on every change.

Upgrading a project generated before scheduled backup verification required
opting in to experimental commands: `trestle upgrade plan` will flag it for
manual review, so add `TRESTLE_EXPERIMENTAL: "1"` to the `env:` of the
`trestle backup verify` step in `.github/workflows/backup-verify.yml`.

Upgrading a project generated before durable billing reconciliation: billing
source is application-owned, so `trestle upgrade` does not rewrite it. Copy the
template's `packages/db/src/billing-schema.ts`, `billing-events.ts` and
`outbox.ts`, migration `0036` (with its snapshot and journal entry),
`packages/billing/src/reconciliation.ts` and its export,
`packages/integrations/src/payments/adapters/local.ts` and `events.ts`, and
the Worker's `billing-reconciliation.ts`, `services.ts`, Stripe route and
`billingReconciliationRequestedEvent` registration. Apply the migration before
deploying the code, and enable Queues for Stripe test and live mode. See
Platform Hardening Specification §5 for the details.
