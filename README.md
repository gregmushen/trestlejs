# TrestleJS

> A Rails-inspired TypeScript application stack for durable, multi-tenant
> products on Cloudflare.

[![npm version](https://img.shields.io/npm/v/create-trestlejs?label=create-trestlejs&color=2764b8)](https://www.npmjs.com/package/create-trestlejs)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TrestleJS assembles React, TanStack, Better Auth, Hono, Drizzle, PostgreSQL,
and Cloudflare into one production-shaped application architecture. It favors
strong conventions, secure defaults, and application-owned generated source
over a large magical runtime.

```text
Browser
  ├─ Astro marketing site
  └─ React + TanStack Router / Query / Form + Tailwind
                    │
                    ▼
          Cloudflare Worker + Hono
                    │
          Better Auth + Zod contracts
                    │
                    ▼
       Drizzle + PostgreSQL + forced RLS
```

**The governing rule:** Cloudflare owns execution. PostgreSQL owns relational
truth and tenant isolation.

> [!IMPORTANT]
> TrestleJS `0.1.0-beta.1` is an opt-in beta candidate, **not a
> production-readiness claim**. Local, preview, and staging paths have
> evidence, while production deployment and several hosted capabilities
> remain unverified. Read the [testing ledger](docs/BETA_CANDIDATE_TESTING_LEDGER.md)
> before evaluating it. APIs and project structure may still change before v1.

[Quick start](#quick-start) · [What you get](#what-you-get) ·
[Resource generation](#generate-a-tenant-safe-resource) ·
[Setup plans](#plans-humans-and-agents-can-review) ·
[CLI](#cli-at-a-glance) · [Architecture specification](docs/TRESTLEJS_SPEC.md)
· [Roadmap](docs/ROADMAP.md) · [Beta testing ledger](docs/BETA_CANDIDATE_TESTING_LEDGER.md)

## Quick start

You need Node.js 22+, pnpm 10+, and Docker Desktop for local PostgreSQL.

```bash
npx create-trestlejs@next my-app
cd my-app
pnpm dev
```

The `next` tag opts into the prerelease; the unqualified npm `latest` tag is
not the beta candidate. `pnpm dev` starts the complete local system:

| Surface | Local address |
| --- | --- |
| Southwind Astro site | `http://localhost:42068` |
| Authenticated React app | `http://localhost:42069` |
| Hono Worker API | `http://localhost:8787` |
| PostgreSQL | `localhost:55432` |

No Cloudflare, Neon, Resend, or Stripe account is required to develop locally.
Trestle creates local encrypted credentials, starts PostgreSQL, applies
migrations, and boots all three application surfaces.

Open the authenticated app, create an account, inspect the locally captured
verification email, and create your first organization. You now have the same
identity and tenancy shape the application will use in production.

## What you get

A new project is a pnpm monorepo with clear architectural boundaries:

```text
apps/
  site/          Astro + Southwind public site
  app/           React + TanStack + Tailwind application
  worker/        Cloudflare Worker + Hono API

packages/
  auth/          Better Auth configuration
  authz/         application authorization
  billing/       plans and entitlement projection
  context/       request and execution context
  contracts/     shared Zod boundaries
  data/          repository interfaces
  db/            Drizzle schema, migrations, and RLS tests
  domain/        application-owned domain logic
  events/        event contracts
  integrations/  email and payments adapters
  theme/         shared design tokens and Tailwind theme
```

The starter includes:

- email/password authentication, verification, password reset, sessions,
  organizations, and invitations through Better Auth;
- PostgreSQL-backed application state with Drizzle migrations and forced
  row-level security for tenant-owned records;
- a React application using TanStack Router, Query, and Form;
- a static Astro marketing site with sign-in and pricing handoff to the app;
- Tailwind CSS v4 with application-owned, editable UI source;
- local transactional email capture and a provider-neutral email contract,
  with Resend as the production adapter;
- local deterministic billing and a provider-neutral billing contract, with
  Stripe Checkout, Customer Portal, and signed webhooks as the golden path;
- encrypted, Rails-style credentials that you can deliberately edit or print;
- GitHub Actions for CI, previews, staging, production, diagnostics, and
  environment secret projection;
- a project-local `trestle-setup` agent skill for architecture discovery,
  reviewed setup plans, explicit mutation approval, and verification.

## Generate a tenant-safe resource

Trestle generators write ordinary source code into your application. There is
no hidden CRUD runtime to learn or fight.

```bash
pnpm exec trestle generate resource Article
pnpm exec trestle db migrate
pnpm check
```

That creates an application-owned vertical slice containing:

- Zod create, update, and response contracts;
- a domain service and repository boundary;
- a Drizzle table and tracked migration;
- a forced PostgreSQL RLS policy and tenant-isolation test;
- authenticated Hono list/create/read/update/delete routes;
- private, transactional create/update/delete events with revisioned update
  identity and no duplicate event for an unchanged retry;
- optional, explicit `--webhook-event created|updated|deleted` selections that
  generate versioned, metadata-only public projections while other events stay private;
- a deterministic generated-app test that follows an opted-in event through
  local Queue/Workflow processing into one signed, inspectable webhook attempt;
- a TanStack Query/Form screen at `/articles`;
- contract tests and read-only resource metadata.

Remote native outbound webhook delivery is a [known issue](docs/WEBHOOK_EGRESS_RUNTIME.md): Cloudflare Workers reject the current IP-pinned HTTPS socket transport. It is disabled by default in preview, staging, and production, and Doctor blocks enabling it. Local signed delivery capture and tests remain available.

Inspect what Trestle sees without spelunking through the repository:

```bash
pnpm exec trestle resources
pnpm exec trestle routes
pnpm exec trestle doctor
```

The generated code remains yours. Rename it, restyle it, extend it, or replace
it as the product grows.

## Plans humans and agents can review

Trestle architecture can be expressed as a versioned, secret-free
`.trestle/setup.json`. Plans separate architectural intent from mutation:

```bash
pnpm exec trestle plan validate .trestle/setup.json
pnpm exec trestle plan diff .trestle/setup.json
pnpm exec trestle apply .trestle/setup.json --yes
pnpm exec trestle plan status .trestle/setup.json
```

Plan output classifies work as `already correct`, `create`, `update`, `delete`,
`blocked`, or `unknown`. Apply is explicit, resumable, and convergent. It
performs only the mutations the installed CLI supports: generating declared
resources and enabling the platform admin. Anything else in a plan, including
deletions and external provider resources, is reported and blocked rather than
attempted.

Every generated project also contains
`.agents/skills/trestle-setup/SKILL.md`. A compatible coding agent uses the
same manifest, plan, Doctor checks, and source-derived inspection commands as
a human operator.

## Secrets you can actually inspect

Trestle credentials behave like Rails encrypted credentials: ciphertext can
live in the repository, while the key remains local or in the deployment
environment.

```bash
pnpm exec trestle secrets edit
pnpm exec trestle secrets get BETTER_AUTH_SECRET
pnpm exec trestle secrets show
pnpm exec trestle secrets check
```

`edit` decrypts into a protected temporary file and opens `$EDITOR`, so `vi`
works exactly as expected. `get`, `show`, and `export` reveal plaintext only
when explicitly requested.

Local credentials use:

```text
config/credentials.yml.enc   # encrypted values; safe to commit
config/master.key            # local decryption key; never commit
```

Preview, staging, and production have separate encrypted documents and keys.
Secret names and requirements are declared in `.trestle/project.yaml`; values
never belong in a SetupPlan, generic status output, or logs.

## Email without emailing real people

Local authentication and application email is captured in memory by the
Worker:

```bash
pnpm exec trestle email list
pnpm exec trestle email show <id>
pnpm exec trestle email open <id>
pnpm exec trestle email clear
pnpm exec trestle email doctor --env staging
```

Application code depends on `EmailService`, templates are application-owned
React Email components, and production uses the Resend adapter. Preview and
staging require recipient redirection so test traffic does not silently reach
real users.

## Billing without a Stripe account

Local billing is deterministic and writes to the same canonical PostgreSQL
subscription and entitlement projections used by the application. Staging
uses Stripe test mode; production uses live mode.

```bash
pnpm exec trestle payments stripe doctor
pnpm exec trestle payments stripe sync --env staging
```

Use the Stripe CLI directly for local webhook forwarding:
`stripe listen --forward-to localhost:8787/webhooks/stripe`. Run the billing
package's own tests with `pnpm --filter <project>/billing test`.

Application code depends on `BillingService`, never Stripe SDK types. Verified
webhooks update local subscription state, and authorization reads local
entitlements rather than making live Stripe requests.

For a deployed webhook, first review the exact endpoint URL using a Stripe
management key on standard input. `status` and `doctor` cannot prove that an
existing encrypted `whsec_` matches Stripe's endpoint: Stripe returns that
secret only when the endpoint is created.

```bash
trestle payments stripe webhook configure --env staging \
  --url https://your-worker.example.com/webhooks/stripe --api-key-stdin
```

After review, add `--apply --operation-id <stable-id>` to create the endpoint
and store its signing secret in encrypted staging credentials. To rotate an
existing destination, also name its exact ID with `--replace-endpoint-id`;
Trestle disables only that endpoint after local secret storage succeeds. Keep
the same operation ID and add `--resume` if interrupted. Push the encrypted
credentials to the Worker, then prove delivery with a provider-signed test
event. Production additionally requires `--yes`. The management key is never
stored with the application's restricted runtime key.

## The TrestleJS way

Trestle deliberately chooses one excellent path:

| Concern | Convention |
| --- | --- |
| UI | React + TanStack Router, Query, and Form |
| Styling | Tailwind CSS v4 |
| Public site | Astro + Southwind starter |
| HTTP | Cloudflare Workers + Hono |
| Identity | Better Auth |
| Runtime contracts | Zod |
| Persistence | Drizzle + PostgreSQL; Neon by default remotely |
| Multi-tenancy | Organization ownership + forced PostgreSQL RLS |
| Transactional email | `EmailService` + React Email; Resend adapter |
| Billing | `BillingService` + local entitlements; Stripe adapter |
| Delivery | GitHub Actions + Wrangler |
| Local infrastructure | Docker Compose PostgreSQL + local adapters |

Some consequences are intentional:

1. PostgreSQL, not a client claim, is the final tenant-isolation boundary.
2. Authentication and authorization remain separate concerns.
3. Domain code does not depend on Hono, Resend, or Stripe.
4. Generated source is explicit, typed, testable, and application-owned.
5. Local development does not require paid provider accounts.
6. Read-only inspection never performs opportunistic repair.
7. Remote, destructive, and paid operations require conspicuous intent.

Read the complete [TrestleJS architecture specification](docs/TRESTLEJS_SPEC.md)
for the reasoning behind those decisions.

## CLI at a glance

```text
trestle dev                         boot the complete local application
trestle dev --fresh --yes           reset only declared local state and reseed
trestle doctor [--env <env>]        verify project and environment health
trestle console --tenant <slug>     open the audited tenant-safe TS console
trestle db ...                      operate local PostgreSQL
trestle secrets ...                 manage encrypted credentials
trestle email ...                   inspect local transactional email
trestle payments stripe ...         operate the Stripe golden path
trestle generate email <Name>       generate a React Email template
trestle generate resource <Name>    generate a tenant-safe vertical slice
trestle generate resource <Name> --webhook-event created updated
                                    expose only selected public event contracts
trestle plan ...                    validate and inspect setup intent
trestle apply <plan> --yes          apply reviewed supported mutations
trestle resources                   inspect declared domain resources
trestle routes                      inspect API routes and auth posture
trestle logs --env <env>            tail safe semantic Worker events
trestle queue dlq list --env <env>  inspect dead-lettered outbox delivery
trestle workflow status <name> <id> inspect a Cloudflare Workflow instance
trestle backup verify ... --yes     prove an isolated Neon restore and RLS
trestle architecture check          enforce static application boundaries
trestle upgrade plan                preview an application-preserving upgrade
trestle upgrade apply --yes         update metadata only after source-version review
trestle upgrade diff                inventory target-template source changes
trestle upgrade migrations          compare journal order and SQL identities without writes
trestle upgrade source-apply --yes  apply pristine adjacent-alpha source only
trestle upgrade source-finalize --yes  run local checks and certify source parity
trestle resource add-field ...      add an optional field and tracked migration
```

This is a representative subset. `pnpm exec trestle --help` and each
subcommand's `--help` are authoritative for your installed release. The
architecture specification describes the v1 target as well as shipped
behavior; it is not a claim that every future command is already implemented.

Updating the CLI with pnpm updates the package and lockfile, but a project
whose `.trestle/framework.json` records an older template version remains a
manual-review upgrade until its source migration is reviewed. `upgrade
source-apply` can copy pristine source only from the immediately preceding
alpha when a matching generation baseline exists. It refuses application edits,
missing files, symlinks, and configuration or migration changes. It also
reports generated files retired by the new template and refuses to proceed
until any still-present retired paths are reviewed. Neither source apply nor
package installation relabels the application source as current. Once source
parity is exact, `upgrade source-finalize --yes` runs the project's `pnpm check`,
rechecks source, and advances its version marker and checksum baseline. It does
not certify deployed providers; follow with `trestle upgrade plan` and the
remaining deployment and recovery gates.
Freshly generated projects record checksums of their generated files in
`.trestle/template-baseline.json`. `trestle upgrade diff` compares those files
with the target template without changing them. Older projects without a
matching baseline receive an unverified inventory rather than an automatic
overwrite recommendation.
`trestle upgrade migrations` compares the application's journal and SQL files
with the bundled target template. It identifies the first divergent index,
missing or unjournaled files, and appended histories without changing either
chain. `--check` exits unsuccessfully for any difference. A matching audit is
not proof that migrations were applied in a deployed
database; a divergence requires an isolated replay and schema review, never a
journal overwrite.

## Repository packages

This repository contains the TrestleJS toolchain:

| Package | Purpose |
| --- | --- |
| [`create-trestlejs`](https://www.npmjs.com/package/create-trestlejs) | project generator and canonical application template |
| [`trestlejs`](https://www.npmjs.com/package/trestlejs) | the `trestle` command-line interface, plus versioned manifests, SetupPlan schema, and deterministic shared logic |

## Working on TrestleJS

```bash
git clone https://github.com/gregmushen/trestlejs.git
cd trestlejs
pnpm install
pnpm check
```

`pnpm check` builds all publishable packages, typechecks the workspace, and
runs the test suite. Release maintainers should follow the
[publishing guide](docs/PUBLISHING.md).

## Project status

The conceptual architecture is frozen for the first vertical slice, and the
core local path is operational. Before v1, expect continued work on the
remaining generators, remote lifecycle commands, upgrade tooling, broader
system tests, and documentation. The [roadmap](docs/ROADMAP.md) distinguishes
the current release from the aspirational v1 surface in the specification.

The installed CLI is always authoritative. If an operation described in the
specification is absent from `trestle --help`, it has not shipped yet.

## License

TrestleJS is available under the [MIT License](LICENSE). Copyright © 2026 Greg
Mushen.
