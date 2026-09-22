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
pnpm exec trestle workflow list <name> --env staging
pnpm exec trestle workflow status <name> <instance-id> --env staging
pnpm exec trestle workflow retry <name> <instance-id> --env staging --yes
```

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
