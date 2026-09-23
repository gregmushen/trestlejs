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
pricing links into the hydrated React application. Preview, staging, and
production deploy workflows run `pnpm test:deployed` against their actual
HTTPS URLs after the existing HTTP smoke gate. The deployed browser test is
read-only and checks public navigation, API access from the app origin, and
an application deep link; it does not claim to verify deployed sign-up or
provider email delivery, which remain separate beta gates.

```yaml
BETTER_AUTH_SECRET: <randomly generated>
BETTER_AUTH_URL: http://localhost:42069
DATABASE_DRIVER: postgres-js
DATABASE_URL: postgres://trestle:trestle@localhost:55432/__TRESTLE_PROJECT_NAME__
```

Email is captured locally by default. Use `pnpm exec trestle email list`,
`pnpm exec trestle email show <id>`, `pnpm exec trestle email open <id>`, and
`pnpm exec trestle email clear` while the
Worker is running. Staging and production use the Resend adapter with
`RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` stored through `trestle secrets`;
`EMAIL_FROM`, `EMAIL_REPLY_TO`, and the staging redirect recipient are typed
non-secret deployment configuration.

Verify provider lifecycle and staging safety with `pnpm exec trestle email
doctor --env staging`. The generated protected provider workflow performs a
read-only Resend-domain and Stripe-test-account check when manually dispatched.

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
`CLOUDFLARE_WORKERS_SUBDOMAIN`.

Trusted pull requests receive isolated, deterministically named Workers and
Pages projects. Closing the pull request deletes those Cloudflare resources.
Use a long-lived token scoped to the same Cloudflare account as
`CLOUDFLARE_ACCOUNT_ID`, with `Workers Scripts Write` and `Pages Write`
permissions in each GitHub deployment environment; an interactive
Wrangler OAuth access token is not a durable CI credential.
If `capabilities.queues` is enabled, grant `Queues Write` on that same account.
The deployment workflows then provision per-environment Queues, render a
producer/consumer binding with a dead-letter queue and cron dispatcher, and
isolate preview Queue names by pull request. Preview cleanup deletes only its
own Queues after deleting its Worker. Queues remain opt-in until this hosted
path has been verified against a real account.
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
retire recovered IDs. Ready-artifact retention remains an application policy.
Queue delivery is at least once. The PostgreSQL event inbox prevents a completed
logical event from running its handler again and leases in-progress work for
recovery. Handlers that call external services must still pass the event's
stable `idempotencyKey`: a crash after an external side effect but before the
inbox completion record can cause that operation to be retried.

Define application events in `packages/events/src/application-catalog.ts` with
`defineEvent(...)` and `defineEventCatalog(...)`. Internal event payloads have
runtime schemas and are private by default. An explicit `webhook` projection
adds a separately versioned, validated public contract with examples and
projection fixtures. The generated database now includes tenant-owned endpoint,
subscription, message, delivery, attempt, and encrypted signing-secret tables.
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
redirects. It is not yet connected to Queue dispatch, so native mode remains
disabled until the full delivery path is verified.
When enabling outbound delivery, set the optional encrypted Worker credential
`WEBHOOK_SECRET_KEY` to at least 32 random bytes per environment through
`trestle secrets edit`; it encrypts endpoint secrets at rest. Endpoint secrets
are disclosed once at issuance or rotation. Do not expose the internal
`activeForDelivery` method through customer or admin routes.
If `capabilities.workflows` is enabled, the deployment config binds the
application-owned `TrestleWorkflow` class. Queue delivery starts a Workflow
using the event ID as its stable instance ID; a repeated Queue delivery
reuses the existing instance. The Workflow validates the versioned event,
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
preview can deploy; provider access alone does not mark a preview as ready.

Validate the checked-in delivery contract locally with:

```bash
pnpm exec trestle ci validate
pnpm exec trestle env status --env staging
pnpm exec trestle logs --env staging --status error
```

## Operations and recovery

Local development is deterministic. `trestle dev` applies the idempotent
default seed; `trestle dev --fresh --yes` removes only this project's declared
Compose volumes and Wrangler local state before migrating and reseeding. Use
`pnpm exec trestle db seed --scenario demo` or `tenant-isolation` for explicit
fixtures. Tests can use the fixed, advanceable clock exported by the context
package without sleeping.

The application console is tenant-bound and read-only by default:

```bash
pnpm exec trestle console --tenant <slug>
pnpm exec trestle console --tenant <slug> --write
pnpm exec trestle console --platform-admin
```

Tenant and platform access are separate authority planes. The console exposes
curated application helpers rather than a raw database handle, records session
audit events, and requires explicit confirmation for remote environments.

Queue and Cloudflare Workflow operations are similarly explicit:

```bash
pnpm exec trestle queue dlq list --env staging
pnpm exec trestle queue dlq redrive <id> --env staging
pnpm exec trestle queue prune --env staging --before 2026-01-01T00:00:00Z
pnpm exec trestle queue prune --env staging --before 2026-01-01T00:00:00Z --limit 1000 --apply
pnpm exec trestle workflow list <name> --env staging
pnpm exec trestle workflow status <name> <instance-id> --env staging
pnpm exec trestle workflow retry <name> <instance-id> --env staging --yes
```

`queue prune` reports eligible records unless `--apply` is passed. It removes
only succeeded outbox records processed before the explicit UTC cutoff, in
bounded batches; pending, leased, and dead-lettered records are never pruned.
Outbox failures record only a sanitized error category, never the error
message, so provider secrets echoed in exceptions are not persisted.

Neon recovery policy lives in `.trestle/recovery.json`. Provider history alone
is not accepted as proof of recovery. `backup verify` creates an isolated
point-in-time branch, verifies migration history, Better Auth integrity,
forced RLS, the restricted runtime role, and adversarial tenant isolation,
writes non-secret evidence, and deletes the drill branch:

```bash
pnpm exec trestle backup status --env production
pnpm exec trestle backup verify --env production --to restore-test --yes
pnpm exec trestle restore create --env production --to restore-test --at <iso-time> --yes
pnpm exec trestle restore delete --env production --target restore-test --yes
```

The generated weekly `backup-verify.yml` workflow runs the same protected drill
and records evidence in the GitHub Actions summary. Configure `NEON_PROJECT_ID`,
`NEON_DATABASE`, `NEON_MIGRATION_ROLE`, and `DATABASE_RUNTIME_ROLE` as protected
environment variables; keep `NEON_API_KEY` in Trestle encrypted credentials and
provide `TRESTLE_MASTER_KEY` only to the protected GitHub environment.

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
  --read-permission resource:read \
  --write-permission resource:write
pnpm exec trestle resource add-field Article archived:boolean? --yes
```

`pnpm db:generate` preserves a strictly increasing migration journal timestamp,
including when an older checked-in migration was future-dated. A generated
release canary checks that running it without schema changes creates no drift.

Generated screens use application-owned typed API clients rather than local
unvalidated fetch helpers. List endpoints use bounded cursor pagination, and
every generated operation declares its application permission before reaching
the repository. `resource add-field` refuses required additions: add, backfill,
verify, and only then tighten a database constraint deliberately.

Organization membership and product-resource access are separate authority
planes. A new member receives the application's starter `contributor` role
(resource read/write); changing the organization role does not change that
application role. Clearing `member.application_role` revokes resource access
without removing membership. Applications should replace this starter policy
with domain-specific roles before granting sensitive product actions.

Project upgrades are dry-run first and preserve application-owned source and
custom skill guidance:

```bash
pnpm exec trestle upgrade plan
pnpm exec trestle upgrade check
pnpm exec trestle upgrade apply --yes
pnpm exec trestle architecture check
```

Upgrade state and framework compatibility are versioned under `.trestle`.
Static architecture checks detect direct provider leakage into application or
domain code, missing declared resource source, missing forced RLS, and stale
managed-guidance markers. CI runs those checks on every change.
