# TrestleJS Specification

**Status:** Living architecture specification. Shipped behavior is authoritative
in `trestle --help` and the code; [ROADMAP](ROADMAP.md) tracks what is planned.\
**Purpose:** An opinionated, Rails-inspired TypeScript stack for
durable, multi-tenant applications on Cloudflare.

## 1. Executive Summary

TrestleJS composes proven technologies into a production-shaped
architecture with strong conventions, generators, and a deliberately
small runtime.

``` text
Frontend: React + TanStack Router + TanStack Query + TanStack Form + Tailwind CSS
Contracts: TypeScript + Zod
Application: Cloudflare Workers + Hono + Better Auth
Persistence: Drizzle + PostgreSQL (Neon default) + native RLS
Cloudflare: R2 + Queues + Workflows + Durable Objects
Delivery: GitHub Actions
```

> **Cloudflare owns execution. PostgreSQL owns relational truth and
> tenant isolation.**

The goal is **BaaS-level developer experience without requiring a BaaS
architecture**. TrestleJS follows Rails' convention-over-configuration
philosophy while favoring explicit, typed, inspectable generated code
over a large magical runtime.

## 2. Goals

1.  Create a production-shaped TypeScript application quickly.
2.  Provide one excellent golden path rather than universal flexibility.
3.  Make secure multi-tenancy the default.
4.  Use PostgreSQL RLS as the final tenant-isolation boundary.
5.  Treat HTTP, queues, workflows, Durable Objects, and scheduled jobs
    as first-class execution contexts.
6.  Generate repetitive vertical-slice application code.
7.  Make observability, idempotency, transactions, and failure recovery
    default concerns.
8.  Support local, preview, staging, and production with the same
    topology.
9.  Keep provider-specific behavior out of domain code.
10. Permit a near-\$0 pre-revenue infrastructure posture with a clean
    path to paid scale.
11. Make application architecture quickly discoverable through stable
    conventions and versioned machine-readable interfaces.

## 3. Non-Goals

TrestleJS is not another React framework, ORM, auth implementation,
database, queue, workflow engine, or object store. It is not intended to
support every possible TypeScript architecture.

## 4. The TrestleJS Way

1.  PostgreSQL is canonical relational truth.
2.  PostgreSQL RLS enforces tenant isolation.
3.  Better Auth establishes identity.
4.  Application authorization and database isolation are separate.
5.  Clients identify resources, not authority.
6.  Zod owns runtime boundaries; Drizzle owns persistence.
7.  HTTP handlers are thin; domain code does not depend on Hono.
8.  Background messages carry resource IDs, not tenant authority.
9.  Queues carry small facts and identifiers, not large aggregates.
10. Workflows own process progression.
11. Durable Objects own coordinated mutable state, not workflow
    progression.
12. R2 owns blobs and large artifacts.
13. Every async operation assumes retries.
14. Every environment uses the same topology.
15. Generated code should be boring and understandable.
16. PostgreSQL provider choice is infrastructure configuration, not
    application architecture.
17. Prefer free-tier infrastructure until the application generates
    revenue.
18. Configuration names and requirements are versioned; plaintext secret
    values are never committed or logged, but authorized operators can
    deliberately decrypt, inspect, edit, export, and deploy them.
19. Humans and agents discover the same architecture from source-derived,
    versioned project metadata and read-only CLI introspection.

## 5. High-Level Architecture

``` text
Browser
  -> React + TanStack Router/Query/Form + Tailwind CSS
  -> shared Zod contracts
  -> Cloudflare Worker / Hono
  -> Better Auth
  -> ApiContext
  -> domain/services
  -> withTenant(...)
  -> Drizzle
  -> PostgreSQL / Neon + native RLS

Cloudflare side primitives:
  R2 | Queues | Workflows | Durable Objects
```

## 6. Frontend

React provides UI. TanStack Router owns navigation, route context, loaders,
redirect intent, and authenticated-route boundaries. TanStack Query owns
remote state, caching, invalidation, mutations, optimistic updates, and
synchronization. TanStack Form owns interactive form state, field validation,
submission state, and accessible error presentation for generated application
and authentication forms.

TanStack does not provide TrestleJS's authentication system. Better Auth owns
identity, sessions, organization membership, and authentication operations.
"Default TanStack auth forms" means TrestleJS-generated, application-owned React
screens built with TanStack Form and Zod and connected to the Better Auth
client. They are the golden-path UI, not a runtime-owned black box.

The default web template includes routes and forms for sign up, sign in, sign
out, email verification status and resend, forgot password, reset password,
organization creation and selection, invitation acceptance, and configured
OAuth providers. Generated forms include correct autocomplete attributes,
disabled/pending submission behavior, field and form error mapping,
redirect-back behavior, keyboard operation, labels, and baseline accessible
markup. Applications own and may restyle or replace the generated source.

### Styling

Tailwind CSS is the standard styling system. The default template uses the
current Tailwind v4 major through the official Vite plugin and CSS-first
configuration. The application imports Tailwind from its primary stylesheet;
it does not generate a legacy JavaScript configuration file unless a project
needs compatibility with a plugin that requires one.

Theme decisions live in version-controlled CSS variables and Tailwind theme
variables: color roles, typography, spacing, radii, shadows, focus treatment,
and motion. Components consume semantic roles such as background, surface,
foreground, muted, primary, destructive, border, and focus rather than
scattering product-specific palette values through generated markup. Dark
mode uses an explicit class or data-attribute variant and also supports the
system preference as the initial default.

Generated authentication, organization, resource, error, loading, empty, and
navigation UI is styled with Tailwind utility classes and remains
application-owned source. TrestleJS does not require a runtime component library
or hide styling behind a proprietary component layer. Small accessible
headless primitives may be adopted when they solve behavior that CSS alone
cannot, but Tailwind remains the visual convention.

Generated code uses statically discoverable complete class names. It avoids
runtime string construction such as `bg-${color}-500`, unbounded arbitrary
values, and large repeated class blocks when a local component abstraction is
clearer. Custom CSS, CSS Modules, and inline styles remain available for
third-party integration, dynamic values, animation, and cases where utilities
would reduce clarity; they are escape hatches rather than competing defaults.

The baseline theme meets accessible contrast and visible-focus requirements,
respects reduced-motion preferences, works with keyboard navigation, and is
tested at representative mobile and desktop widths. Generated screens must be
usable before an application applies branding.

APIs are resource-oriented (`GET /articles`, `POST /articles`) rather
than tenant-authority-oriented (`/orgs/:organizationId/articles`) when
tenant scope already comes from authenticated context.

For requests that do not identify an existing resource, the active tenant
is an explicit request-scoped selector, not an authority claim. The default
web convention is an `X-Trestle-Tenant` header populated from client-side
tenant selection. The API validates the authenticated principal's current
membership before constructing `ApiContext`. A Better Auth active
organization may provide a UI default, but it is never sufficient proof of
membership. Tenant identity must be included in every tenant-scoped TanStack
Query key, and separate browser tabs may select different tenants.

Missing tenant selection maps to a validation error. A nonexistent tenant or
revoked membership maps to `NotFound` for tenant-scoped resource access. The
server never accepts permissions, roles, or membership assertions from the
client.

## 7. Hono and Better Auth

Cloudflare Workers provide the server runtime. Hono owns HTTP routing,
middleware, typed request context, error mapping, and application
boundaries.

Better Auth is self-hosted inside Workers and owns signup, login,
sessions, verification, password reset, OAuth where required,
organizations, memberships, and identity-related roles. The same auth
service may serve customer web, admin web, internal tools, and future
clients.

Better Auth's organization and membership tables are the canonical source of
identity membership. Application roles and permissions may reference that
membership but must not silently duplicate it. Every request revalidates
membership before tenant context is established; session caching must have a
bounded revocation window. Organization lifecycle hooks coordinate creation
and deletion with application-owned tenant records through idempotent domain
operations. Better Auth schema changes participate in the same reviewed
migration pipeline as application schema changes.

Verification, password reset, invitation, and security-notification flows use
a narrow outbound email adapter with idempotency keys, delivery observability,
and a local capture sink. The core does not choose a commercial email
provider, but a working email adapter is required before those auth features
may be advertised as production-ready.

Authentication answers **who are you?** Application authorization
answers **what may you do?** PostgreSQL RLS answers **which tenant's
rows may this execution context access?**

## 8. Context Model

HTTP requests receive an `ApiContext`; background execution receives a
`SystemContext`. Both expose a common `ExecutionContext` to
domain/application services.

``` ts
type ExecutionContext<Data, Services, Access extends AccessControl = AccessControl> = Readonly<{
  principal: Principal
  tenant: TenantIdentity
  permissions: Permissions
  entitlements: Entitlements
  access: Access
  correlation: CorrelationContext
  data: Data
  log: Logger
  metrics: Metrics
  clock: Clock
  features: Features
  services: Services
}>
```

`Principal`, `TenantIdentity`, and `Permissions` are immutable values created
by trusted context factories. Callers cannot construct an
`ExecutionContext` directly. Authorization decisions that protect a write are
rechecked inside the tenant transaction when concurrent membership or role
changes could otherwise create a time-of-check/time-of-use gap.

Domain code should not depend on Hono.

`Clock` supplies `now()` for business decisions involving expiration,
publishing, invitations, scheduling, grace periods, retries, and time-based
permissions. Production uses a wall clock; tests may inject a fixed,
advanceable clock. Native timing APIs remain appropriate for infrastructure
duration measurement. Domain code must not read wall-clock time directly when
the value can change an application decision.

`Features` is a small typed feature-evaluation interface, not a feature-flag
service. Its default provider may use validated configuration or PostgreSQL,
and application code asks `ctx.features.enabled(name, context)` rather than
reading ad hoc environment flags. `Services` contains only the external
integration interfaces the application needs, such as email, payments, SMS,
or LLM services. Individual domain services should accept narrower views of
this context whenever practical; `ExecutionContext` is not intended to become
a general service locator.

## 9. Resource-Derived Tenancy

Background messages identify resources, not tenant authority.

Use `{ issueId }`, not `{ issueId, organizationId }`.

``` text
Queue / Workflow / DO
  -> resource ID
  -> constrained tenant resolver
  -> derive canonical organization
  -> SystemContext
  -> tenant-bound DB execution
  -> PostgreSQL RLS
```

The caller may say "process Issue X"; it may not assert "process Issue X
as Organization Y."

The tenant resolver is a narrow capability, not a general RLS-bypass database
handle. It may map an allowlisted resource type and opaque resource ID to its
canonical organization ID, and may return only that identity and existence
state. The default implementation is a reviewed database function or
dedicated role with no access to resource contents and no arbitrary-query
capability. Resolution is audited and tested separately from normal tenant
access.

## 10. PostgreSQL Provider Strategy

TrestleJS's database contract is PostgreSQL, not Neon. Neon is the default
because of its serverless/free-tier DX. Standard managed PostgreSQL
providers such as Azure Database for PostgreSQL and AWS RDS PostgreSQL
remain viable replacements. Cloudflare Hyperdrive may provide
pooling/connectivity to conventional regional Postgres services.

Provider-specific APIs must not leak into domain code.

## 11. Drizzle, Multi-Tenancy, and RLS

Drizzle owns tables, indexes, constraints, relations, migrations, typed
queries, and PostgreSQL RLS definitions. PostgreSQL enforces RLS.

TrestleJS defaults to shared tables with an `organization_id` (or
equivalent tenant key), not schema-per-tenant.

``` ts
export const articles = pgTable.withRLS(
  "articles",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    title: text("title").notNull(),
  },
  (table) => [tenantPolicy(table.organizationId)]
)
```

RLS is the final isolation boundary and must protect SELECT, INSERT,
UPDATE, and DELETE using appropriate `USING` and `WITH CHECK` policies.
Accidentally omitting an application tenant predicate must not expose
another tenant's data.

Generated tenant tables enable and force RLS. The application role is
`NOSUPERUSER NOBYPASSRLS`, does not own tenant tables, and receives only the
minimum schema/table/function privileges it requires. Migration ownership,
normal application access, constrained tenant resolution, and platform
administration use distinct credentials and database roles. Default
privileges are explicitly revoked before application grants are applied.

The tenant policy fails closed when tenant context is missing, malformed, or
unknown. Generated migrations define separate policies, or an equivalent
auditable policy, for SELECT, INSERT, UPDATE, and DELETE with both `USING` and
`WITH CHECK` where applicable.

Shared reference data (`trestle generate resource <Name> --shared`) is the one
generated exception to the tenant key. A shared table has no `organization_id`
and still forces RLS: the application role may only `SELECT` it, and only
`trestle_platform` may write. Writes need a registered platform permission, a
reason, the expected revision, and an audit record. Tenant resources may
reference a shared row with a plain foreign key; a shared resource never
references tenant data. Tenant defaults are never relaxed to make shared data
writable.

## 12. Tenant-Bound Transactions

Tenant state must never leak through pooled connections. All normal
tenant DB work goes through one blessed abstraction:

``` ts
await withTenant(ctx, async (tx) => {
  // database operations
})
```

Internally it begins a transaction, establishes transaction-local tenant
context, executes the callback with the transaction handle, and
commits/rolls back. Application code does not manipulate tenant session
state directly.

`withTenant` uses a transaction-local PostgreSQL setting on the same physical
database session as all callback queries. Its database adapter contract must
prove support for transactions and session-local settings; an HTTP driver or
pooling mode that cannot preserve those semantics is unsupported. Nested
tenant changes are rejected, and the transaction handle cannot escape the
callback.

Migration credentials and application credentials are separate; the
normal application role must not casually bypass RLS.

## 13. Administrative Access and Admin Application

Tenant admins remain RLS-bound with elevated in-tenant permissions. Platform
administration uses an explicit, narrowly controlled privileged capability;
"admin" never automatically means global RLS bypass.

> **Admin interfaces use application semantics, not database semantics.**

The optional admin application (`trestle admin install`) invokes application
and domain operations with their normal validation, authorization, events, and
audit behavior. Selecting a tenant context runs ordinary tenant operations
through `withTenant()` under forced RLS; cross-tenant and global operations
use separately declared platform capabilities with auditable reasons.

[`ADMIN_SPEC.md`](ADMIN_SPEC.md) is the authoritative specification for the
admin surface, platform roles, capabilities, and audit.

## 14. Resource-Hiding Semantics

-   Missing resource -\> 404.
-   Resource in another tenant -\> 404.
-   Visible in-tenant resource but operation denied -\> 403.

Internally, observability may distinguish `not_found`,
`tenant_scope_mismatch`, and `permission_denied`. Externally addressable
IDs should be opaque/non-sequential, preferably UUIDv7.

## 15. Zod Contracts

Drizzle describes persistence. Zod describes what may cross
runtime/application boundaries. Database row types are not automatically
API DTOs. Zod validates HTTP inputs, queue envelopes/payloads,
configuration, and other untrusted runtime data.

Public API conventions also define a stable error envelope, cursor
pagination, UTC RFC 3339 timestamps, request-size limits, optimistic
concurrency, request idempotency keys for retryable commands, and a
compatibility policy for changing contracts. Generated clients expose only
public DTOs and never database row types.

## 16. Monorepo Structure

``` text
TrestleJS-app/
  apps/
    app/              # React + TanStack Router/Query/Form + Tailwind CSS
    site/             # Astro marketing site
    admin/            # optional platform admin (`capabilities.admin`)
    worker/           # Hono + Better Auth + Cloudflare bindings
  packages/
    contracts/        # Zod schemas/public types
    auth/             # Better Auth configuration
    authz/            # roles/permissions/policies
    billing/          # plans, entitlements, and Stripe catalog
    context/          # Api/System/ExecutionContext
    domain/           # pure business logic
    data/             # repositories + withTenant
    db/               # Drizzle schema/RLS/migrations
    events/           # envelopes/events/outbox
    integrations/     # provider-neutral external service interfaces/adapters
    theme/            # shared CSS tokens and typography
  .agents/
    skills/
      trestle-setup/  # agent setup skill
  .github/
    workflows/
      ci.yml
      preview.yml
      deploy.yml
      secrets.yml
      diagnose.yml
      providers.yml     # protected real-provider verification
      backup-verify.yml # scheduled/manual isolated restore verification
  .trestle/
    project.yaml       # versioned architecture manifest; never secrets
    framework.json     # recorded template and guidance versions
    recovery.json      # declared backup and restore policy
  scripts/             # provider preflight, smoke, and recovery scripts
  seed/                # deterministic default and named scenarios
  tests/
    browser/           # Playwright end-to-end tests
  AGENTS.md            # generated conventions + preserved custom guidance
```

Dependency directions are explicit and enforceable. Raw database
infrastructure must not become a convenience import throughout the app.

## 17. R2

R2 owns uploads, images, source documents, generated PDFs, rendered
pages, and large intermediate artifacts. PostgreSQL stores metadata and
object references.

Object keys are server-generated and include an environment namespace and
non-authoritative tenant partition. Authorization is always checked against
PostgreSQL metadata rather than inferred from a key. Upload flows constrain
size, content type, checksum, and expiry; signed URLs are short-lived bearer
capabilities. The stack defines multipart completion, abandoned-upload
cleanup, object-metadata reconciliation, retention, malware/content scanning
hooks, and idempotent deletion. Database deletion and object deletion are
coordinated by a retryable cleanup job rather than a distributed transaction.

## 18. Queues and Message Envelope

Cloudflare Queues provides at-least-once asynchronous transport.
Consumers must be idempotent.

``` ts
type MessageEnvelope<T> = {
  schemaVersion: number
  messageId: MessageId
  correlationId: CorrelationId
  causationId?: MessageId
  occurredAt: string
  type: string
  payload: T
}
```

Consumers validate both envelope and type-specific payload with Zod.
Queues are trust boundaries.

Delivery is unordered and at least once. Every generated consumer defines
per-message acknowledgement behavior, bounded retries, exponential backoff,
a dead-letter queue, redrive tooling, and an idempotency record or naturally
idempotent write. Unknown types, unsupported schema versions, and permanently
invalid payloads are quarantined rather than retried indefinitely.

Message types and versions form a registry. Producers and consumers must
support an explicit compatibility window; breaking payload changes require a
new version and, where practical, an upcaster. Event retirement requires
proving that no retained queue, outbox, or active workflow instance can still
emit the retired version.

Scheduled triggers are control-plane entry points. A scheduled job that spans
tenants performs a constrained privileged scan for resource IDs, then fans out
resource-derived messages; it does not run arbitrary domain work with global
tenant authority. Generated schedules define overlap prevention, catch-up and
missed-run behavior, batch limits, backpressure, and an idempotency key derived
from the schedule and logical run time.

Inbound webhooks are also trust boundaries. Adapters preserve the raw body for
signature verification, enforce timestamp/replay windows, validate payloads,
persist an idempotency record before acknowledgement, and enqueue resource
identifiers for normal processing.

## 19. Transactional Outbox and Domain Events

A domain mutation, domain event, and outbox record commit in one
PostgreSQL transaction. After commit, an outbox dispatcher publishes to
Cloudflare Queues. This prevents a successful DB mutation from losing
its event if queue publication fails.

Dispatchers claim records with a lease, permit multiple dispatchers without
double ownership, retry stale leases, and publish a stable message ID derived
from the outbox record. Publication may succeed before marking a record as
published; consumers therefore remain idempotent. Attempts, last error,
availability time, publication time, and terminal state are observable.
Outbox retention, cleanup, dispatcher scheduling, and a stuck-record alert are
part of the default implementation.

Domain events describe facts (for example `SubmissionReceived`,
`ArticleGenerated`, `IssuePublished`) and do not carry implicit
authorization capabilities.

## 20. Workflows and Durable Objects

Cloudflare Workflows owns durable process progression while an execution is
active. PostgreSQL owns the durable, queryable projection of process status
and the terminal outcome after Workflow retention expires. Workflow steps
pass identifiers/references rather than large aggregates.

Durable Objects own coordinated mutable aggregates and serialization
when needed. They do not maintain a competing workflow state machine.

``` text
Workflow       -> process progression
Durable Object -> mutable coordinated aggregate
PostgreSQL     -> canonical domain state
R2             -> large artifacts
```

The Workflow owns the idempotent, retryable handoff from finalized DO
state to PostgreSQL canonical state, domain events, and outbox.

Generated workflows define stable instance-ID derivation, step idempotency
keys, timeout and retry policy, cancellation, restart and compensation
semantics, concurrent-start behavior, and compatibility rules for in-flight
instances during code deployment. Durable Object identity, eviction recovery,
storage migration, alarm retry behavior, and deletion are likewise explicit.

## 21. Error and Idempotency Model

Shared errors: `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`,
`ValidationError`, `RateLimited`, `InternalError`.

`tenant_scope_mismatch` always maps to `NotFound`; in-tenant permission
denial maps to `Forbidden`.

All async consumers and external side effects assume retries. Stable
idempotency keys are required where appropriate.

## 22. Observability

Common metadata includes `requestId`, `messageId`, `correlationId`,
`causationId`, `workflowId`, `organizationId`, `principalId`, and
relevant domain IDs. A logical operation should be reconstructable
across HTTP, PostgreSQL, outbox, Queue, Workflow, Durable Object, and
external side effects.

Structured logging is the default.

Application packages do not use `console` directly. CLI commands whose
explicit purpose is to reveal credentials are a narrow exception and do not
pass their output through the application logger.

Sensitive values, credentials, session tokens, cookies, authorization
headers, and configured personal data fields are redacted at the logging
boundary. The production template includes metrics, traces, sampling and
cardinality rules, alerting, health signals, and runbooks for database
saturation, failed migrations, stuck outbox records, DLQs, and failed or
stalled workflows. Service-level objectives and retention are application
configuration rather than hidden runtime defaults.

## 23. Secrets and Configuration

TrestleJS distinguishes four categories:

1. public build-time configuration safe to expose to the browser;
2. Worker runtime secrets used by application code;
3. deployment and migration credentials used only by CI or operators; and
4. tenant-managed credentials, which are application data and outside the
   deployment-secrets subsystem.

Secret requirements are declared by name and metadata in version-controlled
configuration. The metadata manifest never contains values; encrypted
credentials files do.

``` ts
secrets: {
  DATABASE_URL: {
    target: "worker",
    required: ["local", "preview", "staging", "production"],
  },
  DATABASE_MIGRATION_URL: {
    target: "ci",
    required: ["staging", "production"],
  },
  BETTER_AUTH_SECRET: {
    target: "worker",
    required: ["local", "preview", "staging", "production"],
    rotation: "dual-value",
  },
}
```

### Encrypted credentials source of truth

TrestleJS uses a Rails-style encrypted credentials workflow. Human-editable YAML
is encrypted at rest in version-controlled files:

``` text
config/credentials.yml.enc                 # local/default credentials
config/credentials/preview.yml.enc
config/credentials/staging.yml.enc
config/credentials/production.yml.enc
```

Each file decrypts to a mapping of declared secret names to string values. The
encrypted files are safe to commit. Their master keys are not:

``` text
config/master.key                          # local/default key
config/credentials/preview.key
config/credentials/staging.key
config/credentials/production.key
```

Key files are generated with owner-only permissions and excluded by the
generated `.gitignore`. In automation, `TRESTLE_MASTER_KEY` supplies the key
for the environment selected by the command. The environment variable takes
precedence over the corresponding key file. Losing both the key and every
authorized backup makes the credentials unrecoverable; committing either key
must be treated as disclosure and triggers key and credential rotation.

The encrypted envelope is versioned and authenticated. The v1 format uses a
cryptographically random 256-bit master key, AES-256-GCM, a fresh random
96-bit nonce for every write, a 128-bit authentication tag, and authenticated
metadata containing the format version and logical environment. Encryption
is never deterministic. Implementations use the platform cryptography API or
a reviewed library, publish interoperability test vectors, and fail closed on
authentication, version, environment, or schema errors.

The stable deployment provider remains per-Worker Cloudflare secrets.
Cloudflare Secrets Store is an optional provider while its Workers integration
remains beta. Cloudflare stores deployed copies; it is not the editable source
of truth. The provider interface may later support other secret managers
without changing application code. Domain code receives typed configuration
and does not call the encrypted-file or remote-secret providers directly.

The CLI provides:

``` bash
trestle secrets init [--env staging]
trestle secrets edit [--env staging]
trestle secrets show [--env staging] [--format yaml|json|dotenv]
trestle secrets get NAME [--env staging] [--raw]
trestle secrets set NAME [--env staging]
trestle secrets unset NAME [--env staging]
trestle secrets import FILE [--env staging]
trestle secrets list [--env staging]
trestle secrets diff [--env staging] [--remote]
trestle secrets check [--env staging] [--remote]
trestle secrets push --env staging
trestle secrets rotate NAME --env production
trestle secrets key rotate --env production
```

Command rules (the CLI reference documents each flag):

- `edit` works in a private mode-0600 temporary file, validates before
  atomically replacing ciphertext, and never overwrites valid ciphertext on a
  validation failure; `doctor` reports stale plaintext temp files.
- `show` and `get --raw` deliberately print plaintext without masking or
  confirmation, warning on standard error when interactive. They read only the
  local encrypted source; remote Cloudflare values are never retrieved.
- New values arrive through a hidden prompt, standard input, a protected file,
  or the editor, never as command-line arguments. `list` never prints values.
- `trestle dev` injects decrypted credentials in memory and writes no
  `.dev.vars`; generated `.gitignore` rules exclude keys, plaintext exports,
  `.dev.vars*`, and `.env*`.
- `import` is strict and additive; pruning and deletion are explicit and are
  refused while the manifest still requires the name. Production mutations
  print the account, Worker, environment, and affected names first.
- `push` uploads only the entries targeted at the chosen provider without an
  intermediate plaintext file. `diff --remote` compares names and fingerprints
  or provider metadata and never claims value equality it cannot prove.
- `check` fails for missing required names, invalid bindings, secret-looking
  public configuration, or environment-crossing references, and deployment runs
  it before migration or upload. Previews never inherit staging or production
  secrets, and untrusted fork workflows receive none.
- Rotation supports application-defined overlap (accept old and new, activate,
  verify, revoke). `key rotate` re-encrypts under a new master key without
  changing the credentials themselves and says so.

CI authenticates to infrastructure with short-lived or federated credentials
where supported. Migration credentials are not installed as Worker runtime
bindings. Secret access, mutation, and deployment require separate least-
privilege roles and are covered by provider audit logs.

GitHub Environments hold `TRESTLE_MASTER_KEY` for preview, staging, and
production. The protected secrets workflow decrypts the committed encrypted
file in memory and calls `trestle secrets push`; normal deployment only checks
that encrypted credentials, manifest requirements, and deployed bindings are
consistent. Repository-level CI that does not deploy receives no master key.

## 24. Email and Transactional Messaging

TrestleJS owns the transactional-email contract and conventions. Resend is the
golden-path production adapter, React Email is the default template system, and
local development uses Trestle's non-forwarding capture adapter. Application,
domain, and Better Auth code depend on `EmailService`; they do not import a
provider SDK.

``` text
Application / Better Auth
          ↓
     EmailService
          ↓
    ┌─────┴─────┐
    ↓           ↓
Local Capture   Resend
local/test      staging/production
```

The core provider-neutral contract supports immediate delivery and delivery of
a known message at a known future time:

``` ts
interface EmailService {
  send(message: EmailMessage, options?: SendEmailOptions): Promise<EmailReceipt>
  schedule(message: EmailMessage, sendAt: Date, options?: SendEmailOptions): Promise<ScheduledEmail>
  cancel(scheduledEmailId: string): Promise<ScheduledEmail>
  reschedule(scheduledEmailId: string, sendAt: Date): Promise<ScheduledEmail>
}
```

`EmailMessage` supports `from`, `to`, `cc`, `bcc`, `replyTo`, `subject`, and a
typed application-owned `EmailTemplate`. Provider response objects and error
types never escape the adapter. `EmailReceipt.acceptedAt` means the configured
provider accepted the request; it does not claim inbox delivery. Normalized
scheduled states include `scheduled`, `cancelled`, `already_sent`, `not_found`,
and `provider_rejected`. Normalized errors include `EmailValidationError`,
`EmailProviderUnavailable`, `EmailRateLimited`, `EmailRejected`,
`EmailScheduleUnsupported`, and `EmailAlreadySent`; retry classification is an
integration-layer concern.

React Email templates are application-owned source code, accept typed props,
and render accessible HTML plus useful plain text. Generated templates include
verification, password-reset, invitation, and security-alert examples and may
be organized further by application domain. TrestleJS does not add a proprietary
template language. An application may replace React Email at the rendering
boundary without changing `EmailService`.

Better Auth uses the same service for verification, verification resend,
password reset, organization invitation, security notification, and email-
address-change notification when those capabilities are enabled. It must not
call Resend directly. An email-dependent authentication capability is not
production-ready until its deployed adapter and sender configuration have been
verified.

Immediate and scheduled operations accept a stable idempotency key. Generated
Queue and Workflow handlers derive it from the logical operation, such as
`auth-verification:<verification-id>` or
`issue-published:<issue-id>:<recipient-id>`, never from an execution attempt. A
Workflow retry must not duplicate email merely because a step executes twice.
Provider scheduling is only for a message whose content, recipient, and send
time are already known. Conditional future decisions belong in a Workflow:

``` text
Workflow → wait → reload canonical state → evaluate condition → EmailService.send()
```

For example, “in seven days, if onboarding is incomplete” is a Workflow, not a
provider-scheduled email that callers must remember to cancel. Provider limits
are exposed only through normalized capability or validation errors.
Cancellation and rescheduling are idempotent where the provider permits.

Email is an external side effect and cannot share a distributed transaction
with domain state. When delivery must follow a committed mutation, generated
code uses a PostgreSQL transaction to persist the mutation, domain event, and
outbox record, commits, and then delivers through a Queue or Workflow. It does
not send externally visible email inside a transaction and assume rollback can
undo delivery.

### Local email

`LocalEmailAdapter` requires no provider account and must never forward to real
recipients. Its capture records include delivery ID, recipients, subject,
template name and props, rendered HTML and text, creation and scheduled times,
and provider-neutral status. The local CLI exposes only the local capture store:

``` bash
trestle email list
trestle email show <id>
trestle email open <id>
trestle email clear
```

`open` displays the rendered message in a local browser. Local scheduled email
uses an injectable clock and an explicit flush operation so tests can advance
time without sleeping. It reproduces application semantics rather than every
provider implementation detail.

### Staging and production

Staging uses the production adapter where practical but applies a declared
delivery policy: allowlist, recipient redirect, or provider test mode. The safe
generated default is redirect, with the original recipient represented in a
subject prefix such as `[STAGING → customer@example.com]`; it must never deliver
to that real address. Diagnostic handling of the original recipient follows the
application's personal-data policy.

Resend is the default production adapter. `RESEND_API_KEY` and
`RESEND_WEBHOOK_SECRET` are runtime secrets. `EMAIL_FROM`, `EMAIL_REPLY_TO`, the
adapter mode, and staging delivery policy are typed non-secret configuration.
These declarations integrate with `trestle secrets`, `trestle doctor`, and
`trestle deploy`. A missing provider does not block an application with no
email capability, but does prevent an email-dependent feature from being
reported as production-ready.

`trestle doctor --env production` verifies, where possible, the configured
adapter, required secret names, sender, sender/domain verification, Better Auth
requirements, and staging/production separation.

### Observability, delivery events, and privacy

Email emits semantic `email.send.*` and `email.schedule.*` events. Useful fields include the Trestle delivery ID,
template, provider, correlation and causation IDs, organization ID, and
duration. Logs do not include API keys, raw verification/reset tokens, magic
links, authorization URLs containing secrets, provider request bodies, full
rendered messages, or full recipient addresses when an internal identifier is
available.

Provider delivery webhooks preserve the raw body for signature and replay
verification, validate the verified payload with Zod, enforce idempotency, and
normalize supported events to `accepted`, `delivered`, `bounced`, `complained`,
or `failed`. Provider delivery events are integration events, not application
domain events.

The optional admin application may show template, logical recipient or resource,
accepted and scheduled times, provider-neutral status, correlation ID, and
failure category. It never exposes credentials, authentication tokens,
password-reset or verification URLs, or unrestricted message bodies.
Operational visibility is not a mailbox.

### Generation, testing, and scope

`trestle generate email <name>` produces typed props, an application-owned
React Email template, plain-text rendering, a preview fixture, and a test.
Generated email tests cover rendering, local capture, idempotency, scheduling,
cancellation, rescheduling, error normalization, redaction, Better Auth wiring,
Workflow retries, staging protection, webhook signature rejection, and webhook
duplicate delivery. They require no live Resend account; protected provider
integration tests may run separately in staging.

TrestleJS v1 includes the provider-neutral service, Resend and local adapters,
React Email rendering, Better Auth wiring, immediate and provider-scheduled
delivery, cancellation and rescheduling, stable idempotency, semantic logging,
local inspection, safe staging delivery, typed configuration and secrets,
doctor checks, deterministic tests, and verified normalized provider webhooks
where required. Marketing campaigns, newsletter management, segmentation,
drag-and-drop design, generalized open/click analytics, multi-provider failover,
bulk orchestration, and email CRM are deferred. This subsystem is for
transactional application messaging, not email marketing.

The normative architectural rule is:

> **TrestleJS owns the email contract and conventions. Resend is the golden-path
> provider. Workflows own future business decisions.**

## 25. Payments, Billing, and Stripe

TrestleJS owns the billing contract and application projection. Stripe is the
golden-path provider. PostgreSQL owns canonical application billing state and
entitlements; Stripe owns payment mechanics. Application and domain code depend
on `BillingService`, never Stripe SDK types.

``` text
Application / Domain → BillingService → StripeAdapter → Stripe
Stripe webhook → Hono → signature + replay verification
               → normalized event → PostgreSQL subscription + entitlements
```

The v1 command namespace is deliberately provider-qualified:

``` bash
trestle payments stripe doctor [--env <env>]
trestle payments stripe webhook configure --env <env> --url <url> --api-key-stdin
trestle --experimental payments stripe sync --env <env>
trestle --experimental payments stripe seed
```

Remote mutation requires an explicit environment. The generated billing
scaffold contains application-owned source, configuration declarations,
migrations, webhook handling, local fixtures, tests, and UI without creating
live Stripe resources.
The remote webhook setup command takes a short-lived management key on standard
input, previews the exact endpoint before mutation, and captures Stripe's
signing secret at creation into TrestleJS encrypted credentials. Rotation names
the old endpoint explicitly and disables it only after secret storage succeeds.
A syntactically valid `whsec_` alone does not prove that the deployed Worker
matches a remote Stripe endpoint; provider-signed delivery remains a separate
readiness gate.

### Contract, ownership, and plans

`BillingService` provides provider-neutral checkout and portal sessions,
subscription lookup, cancellation, resumption, and plan changes. Provider
objects and errors cannot cross the adapter boundary. The default billing
subject is an organization; user billing requires an explicit application
choice.

The canonical `organization_subscription` projection stores organization,
provider identifiers, plan, normalized status, current period, cancellation
state, and update time. Normalized statuses include `active`, `trialing`,
`past_due`, `cancelled`, and `incomplete`.

Plans and entitlements are specified in
[`ADMIN_SPEC.md` §9](ADMIN_SPEC.md#9-plans-subscriptions-and-entitlements).
Domain authorization checks entitlements, never plan-name conditionals or live
Stripe responses.

Marketing and Southwind pricing links carry plan intent only. The normal flow is
pricing intent, authentication, authenticated checkout creation, Stripe
Checkout, verified webhook, committed local projection, then entitlement
activation. A Checkout success redirect is never proof of payment.

Stripe's hosted Customer Portal is the default interface for payment methods,
invoices, and routine customer-managed billing. The generated Billing settings
page renders local subscription state and creates a portal session only when the
user selects Manage billing.

### Webhooks and transaction boundary

`POST /webhooks/stripe` preserves the raw body, verifies the Stripe signature
and timestamp semantics, deduplicates provider event IDs, validates and
normalizes the event, persists its receipt, updates billing and entitlement
projections transactionally, emits required domain/outbox records, and only then
acknowledges delivery.

`billing_provider_event` has a unique `(provider, provider_event_id)` boundary
and records type, receipt and processing times, status, and a safe error
category. Stripe event names are normalized to provider-neutral billing events
and never leave the adapter.

The projection update, entitlement replacement, domain event, and outbox record
commit in one PostgreSQL transaction. External Stripe API calls do not execute
inside that transaction. Duplicate webhook delivery is safe.

Provider mutations use stable logical idempotency keys such as
`checkout:<organization>:<plan>:<request>`,
`portal:<organization>:<request>`, and
`plan-change:<subscription>:<target-plan>:<command>`. HTTP and Workflow retries
must not create duplicate sessions or mutations.

### Local, staging, and production

Local development uses `LocalBillingAdapter` and requires no Stripe account. It
supports deterministic activation, failed payment, cancellation, resumption,
and plan changes against the same canonical projection used by the application.
Tests use an advanceable clock and do not call Stripe.

Staging uses Stripe test mode by default; production uses live mode. Staging and
production credentials are not interchangeable. `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` are runtime secrets. `STRIPE_PUBLISHABLE_KEY`,
`STRIPE_MODE`, and `BILLING_RETURN_URL` are typed non-secret configuration.
`trestle doctor` rejects live keys in staging and test keys in production unless
an explicit policy permits an exception.

Local webhook forwarding uses the Stripe CLI directly
(`stripe listen --forward-to localhost:8787/webhooks/stripe`) against the local
Hono endpoint; TrestleJS does not wrap or reimplement Stripe tooling.

### Synchronization and operations

`doctor` first prints a read-only summary of adapter configuration, secret
presence, mode, webhook configuration, declared plans and mapped prices, and
the latest persisted webhook without revealing values, then runs its checks.

`sync` converges declared products and prices with Stripe and classifies each
change as `already correct`, `create`, `update metadata`, `archive`, `blocked`,
or `unknown`. It does not blindly create duplicates or automatically delete
historically important resources. Price changes normally create a replacement
price where Stripe immutability requires it. Destructive or ambiguous changes
require explicit review.

`trestle payments stripe doctor` verifies adapter enablement, secret names and
presence, environment mode, webhook configuration and route, plan validity,
complete price mappings, migrated billing tables, application-role and RLS
behavior, entitlement projection, and Southwind intent links where installed.
Doctor is read-only.

Tenant-owned subscription and entitlement records use forced RLS. Platform-wide
reconciliation requires a separately authorized capability. Client assertions,
success redirects, and publishable-key input never grant entitlements. Secret
keys and payment details never enter browser code, logs, or telemetry.

Semantic events include `billing.checkout.started`,
`billing.checkout.created`, `billing.checkout.failed`,
`billing.portal.created`, `billing.webhook.received`,
`billing.webhook.processed`, `billing.webhook.duplicate`,
`billing.webhook.failed`, `billing.subscription.activated`,
`billing.subscription.updated`, `billing.subscription.cancelled`,
`billing.invoice.paid`, and `billing.invoice.payment_failed`. Metrics cover
session creation, webhook latency and duplicates, processing failures, active
subscriptions by plan, and past-due subscriptions without card data or raw
provider payloads.

Errors normalize to `BillingValidationError`, `BillingProviderUnavailable`,
`BillingRateLimited`, `BillingConfigurationError`,
`BillingSubscriptionNotFound`, `BillingPlanUnavailable`, and
`BillingAlreadyCancelled`. Domain code does not branch on Stripe exceptions.

Core tests cover checkout, portal, idempotency, local activation and plan
changes, cancellation/resumption, entitlements, signature rejection, duplicate
delivery, subscription and invoice event processing, environment separation,
billing RLS and cross-tenant denial, and pricing-intent handoff. They require no
Stripe account; protected staging integration tests may use test mode.

The setup skill asks whether organizations or users pay for subscriptions. The
default proposal is Stripe, organization ownership, Checkout, Customer Portal,
PostgreSQL projections and entitlements, Stripe test mode in staging, and the
local adapter in development. It asks for a provider choice only when the user
rejects that default or existing infrastructure establishes another provider.

V1 excludes usage metering, a seat-billing engine, tax and multi-currency
abstractions, Connect marketplaces, revenue recognition, non-Stripe invoicing,
custom payment-method UI, multi-provider orchestration, generalized promotions,
credit balances, and enterprise-contract management.

The normative architectural rule is:

> **TrestleJS owns the billing contract and application projection. Stripe is
> the golden-path payment provider. Entitlements come from PostgreSQL, never
> client claims or live provider lookups.**

## 26. Backup and Restore

PostgreSQL providers may own snapshot, point-in-time recovery, retention, and
storage mechanics. TrestleJS owns the declarative policy, operator workflow,
safety boundary, verification suite, and evidence that recovery actually
works. Generated runbooks name the selected provider mechanism and do not imply
that all providers offer identical recovery-point or recovery-time guarantees.
The secret-free project/environment configuration declares the provider,
schedule, retention, recovery-point and recovery-time objectives, isolated
restore target policy, and R2 recovery/reference-verification policy.

The shipped provider is Neon, and recovery creates an isolated Neon
point-in-time branch:

``` bash
trestle --experimental backup status --env production
trestle --experimental backup verify --env production --to restore-test [--at <timestamp>] --yes
trestle --experimental restore create --env production --to restore-test [--at <timestamp>] --yes
trestle --experimental restore delete --env production --target restore-test --yes
```

`--at` requests a past ISO recovery point; without it, the latest point is
used.

`backup status` is read-only. It reports the configured provider and policy,
retention and schedule where discoverable, latest successful provider backup,
last successful isolated restore verification, age against the declared
recovery-point objective, and any unverifiable fields. Provider status is
evidence of a backup operation, not proof that the application can recover.

`restore create` resolves the recovery point, prints the source,
target, provider account/project, database, timestamp, expected destructive
effects on the target, and verification plan, then requires confirmation. The
target must be an explicitly declared isolated restore environment or a newly
created ephemeral verification environment. It receives separate credentials,
cannot receive production traffic, and must not reuse production Worker,
database, R2, Queue, Workflow, or Durable Object bindings.

> **TrestleJS never verifies a backup by restoring over its source environment.**

The CLI rejects identical or ambiguously resolved source and target resources,
production as a restore-verification target, undeclared connection strings,
and a target with active application traffic. Overwriting an existing
non-production target requires its exact resolved identity and separate
destructive confirmation. A normal backup-verification workflow never mutates
the source environment.

`backup verify` restores the selected recovery point into the isolated target,
checks it, and cleans it up. `trestle backup verify --help` lists the exact
options for the installed release, and the verification report names each
check it ran.

R2 object recovery, retention, and versioning are provider-specific but must
have an explicit generated runbook when the application stores durable
artifacts. Verification samples or fully checks referenced objects according to
the declared policy, reports missing or mismatched objects, and never silently
claims database restore alone is complete application recovery.

A successful verification record includes source recovery point, target,
application revision, schema/migration version, check results, start/end times,
and cleanup status without secret values or sensitive row contents. Failure
preserves enough isolated evidence for diagnosis subject to retention policy;
cleanup is explicit and refuses broad or unresolved targets. Scheduled
verification may run through protected GitHub Actions with environment-scoped
credentials and the same serialized safety rules as deployment.

A provider backup that has never passed an isolated application restore is a
backup hypothesis, not a verified recovery capability.

## 27. Environments

First-class environments:

``` text
local
preview
staging
production
```

Staging is structurally equivalent to production with different
bindings, secrets, DB, buckets, queues, workflows, and DO namespaces.
Application semantics should not branch merely because the environment
differs.

"Same topology" means the same logical components, contracts, and failure
semantics. Local emulation need not be the same managed implementation. The
project documents which primitives are emulated, which require remote
development resources, and which parity tests run only against isolated cloud
infrastructure.

## 28. Local Development

A developer can clone a TrestleJS application, obtain the local master key, and
run `trestle dev` to start a complete local environment without manually
provisioning cloud resources.

``` text
trestle dev
  |-- Vite ----------------------> React / TanStack / Tailwind
  |-- Wrangler + workerd --------> Worker
  |      `-- Miniflare ----------> R2 / Queues / Workflows / DOs
  `-- Docker Compose ------------> PostgreSQL
```

Production remains serverless/containerless. Local development uses Docker
only for infrastructure that benefits from exact containerized semantics,
which is PostgreSQL by default. Vite and Cloudflare's own local runtime run as
native development tools. TrestleJS does not containerize the entire application
or substitute SQLite for PostgreSQL.

### PostgreSQL

The generated `compose.yaml` contains a pinned supported PostgreSQL image and
only genuinely required containerized infrastructure. Local database setup
exercises Drizzle migrations, constraints, transactions, transactional outbox
behavior, native RLS, forced RLS, the real application and migration roles,
`NOBYPASSRLS`, transaction-local tenant context, and `withTenant`.

The CLI exposes `trestle db start`, `stop`, `status`, `migrate`, `seed`,
`console`, and `reset`. Normal stop preserves the named PostgreSQL volume.
`reset` is destructive, lists the exact local volume/database it will remove,
and requires confirmation unless running inside an explicitly marked isolated
test environment. Database commands reject staging and production connection
targets when invoked as local lifecycle operations.

When production uses Hyperdrive, local Worker code uses the same binding and
driver. `trestle dev` supplies
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` in memory with the
Docker PostgreSQL connection string. It does not write database credentials
into `wrangler.jsonc` or Compose. Hyperdrive pooling, caching, and network
behavior that cannot be reproduced locally is verified in staging.

### Cloudflare runtime and bindings

The Worker runs locally through Wrangler, workerd, and Miniflare. Supported
bindings use Cloudflare's local simulations with the same application APIs as
production, including R2, Queues, Workflows, and Durable Objects. Application
code does not introduce separate in-memory implementations merely for local
development.

Local Queue development supports producer-to-consumer execution, retries, and
DLQ configuration through the normal bindings, but does not claim production
concurrency, throughput, ordering, or delivery fidelity. Workflows use
Cloudflare's local implementation; TrestleJS lifecycle commands delegate to
Cloudflare rather than implementing another workflow engine. Durable Objects
use the local runtime and may persist through SQLite-backed local storage.
R2 objects use the normal binding and may persist in Wrangler local state.

Known local-runtime gaps are documented and surfaced by `trestle doctor`.
Network-scale, pooling, cache, concurrency, retry-timing, and provider-specific
behavior that cannot be faithfully simulated is tested in staging. Remote
bindings are opt-in, identify the exact non-production resources they affect,
and warn that writes and billable operations are real. Local development never
connects to production data by default.

### `trestle dev`

`trestle dev` is the normal orchestration entrypoint. It:

1. validates Node, the selected package manager, Docker and its daemon,
   Wrangler, supported versions, required ports, and local encrypted
   credentials;
2. starts PostgreSQL and waits for readiness;
3. creates or verifies migration and application roles, applies migrations,
   verifies Better Auth schema and forced RLS, and runs idempotent development
   seeds when configured;
4. starts the Worker with local Cloudflare bindings and persistent state;
5. starts Vite with generated API proxy/CORS behavior; and
6. reports local URLs, service health, state locations, and actionable errors.

Defaults are `http://localhost:42069` for web and
`http://localhost:8787` for API, but ports are configuration rather than
application assumptions. The orchestrator forwards termination signals,
stops children in dependency-safe order, reports which process failed, and
does not destroy persistent state on ordinary shutdown. Developers can still
inspect and invoke Compose, Wrangler, Vite, and database commands directly.

Local credentials come from the encrypted-credentials model. `trestle dev`
decrypts and validates required values before starting dependent processes and
injects them into child processes without generating a persistent plaintext
`.dev.vars` file. Plaintext values are not written to Compose, Wrangler
configuration, logs, committed files, or shell command arguments.

### State, reset, tunnels, and inspection

Normal development preserves the PostgreSQL volume, Wrangler/Miniflare state,
R2 objects, Durable Object storage, and Workflow state where supported.

`trestle dev --fresh` stops local services, prints the explicit project-scoped
PostgreSQL volume and Wrangler state directories to be removed, requests
confirmation, deletes only those validated local targets, restarts PostgreSQL,
applies migrations and roles, seeds, then starts Wrangler and Vite. It refuses
remote database URLs, remote bindings, staging/production environments,
unresolved paths, and broad deletion targets.

`trestle dev --tunnel` optionally exposes the local Worker through Cloudflare
Tunnel for external webhooks and callbacks and reports the public URL. The
default is an ephemeral tunnel; named persistent tunnels are opt-in. Tunnel
startup never modifies production DNS implicitly.

`trestle inspect` reports service status, local and tunnel URLs, PostgreSQL
access, state locations, configured bindings, and active Workflows, and opens
or links Cloudflare Local Explorer where supported. It exposes underlying
inspection capabilities rather than inventing another local observability
store.

### Local testing

The default stack is Vitest for domain/unit tests, Cloudflare's Vitest
integration for Worker/runtime tests, real Docker PostgreSQL for database and
RLS tests, a Cloudflare-plus-PostgreSQL harness for integration/system tests,
and Playwright for browser tests.

Automated tests do not use a developer's persistent database. They receive an
ephemeral or dedicated isolated database with parallel-safe cleanup. Test
configuration refuses staging and production database hosts or credentials.
Mandatory local database tests cover cross-tenant SELECT, INSERT, UPDATE, and
DELETE denial; missing tenant context; forced RLS; and inability of the real
application role to bypass RLS.

### Generated configuration and diagnostics

Generated local-development files remain conventional and readable:

``` text
compose.yaml
apps/worker/wrangler.jsonc
apps/app/vite.config.ts
config/credentials.yml.enc
config/master.key                 # generated locally and gitignored
```

The encrypted credentials file, not `.dev.vars`, is the default local secret
source. Explicit import/export remains available as defined in the secrets
section.

`trestle doctor` validates Docker availability and daemon health, the
PostgreSQL image and connectivity, Node/package-manager/Wrangler versions,
workerd/Miniflare capabilities, required encrypted credentials, migrations,
database roles, enabled and forced RLS, Better Auth schema, bindings, local
state compatibility, and port availability. It is strictly read-only: it may
probe services and decrypt credentials in memory for validation, but it does
not install tools, start services, apply migrations, rewrite configuration, or
repair state. Each failure includes concrete remediation. `--env` selects the
environment to diagnose, and `--json` emits stable machine-readable check
identifiers, status, evidence, and remediation for CI and agent use.

Local parity means the same logical components, binding APIs, contracts,
security semantics, and failure assumptions—not identical hosting behavior:

``` text
                 local                         production
compute          workerd                       Workers
relational DB    Docker PostgreSQL             Neon/RDS/Azure PostgreSQL
object storage   Miniflare R2                  R2
async transport  local Queues                  Queues
processes        local Workflows               Workflows
coordination     local Durable Objects         Durable Objects
```

## 29. CI/CD

GitHub Actions is the default CI/CD system; hosted or self-hosted
runners are supported.

`create-trestlejs` generates working GitHub Actions and Cloudflare deployment
configuration rather than example snippets. The default React application is
deployed with Cloudflare Pages Direct Upload and the API is deployed as a
Cloudflare Worker. Projects may replace Pages with Worker static assets, but
the generated deployment contract and smoke gates remain the same.

The generated workflows are:

- `ci.yml`: install from the frozen lockfile, lint, typecheck, test, build, and
  validate generated artifacts and Wrangler configuration;
- `preview.yml`: for trusted pull requests, provision or select isolated
  preview resources, migrate them, deploy Worker and web previews, publish
  their URLs to the GitHub deployment, and clean them up when the pull request
  closes;
- `deploy.yml`: deploy staging, smoke test it, then promote the same commit to
  production and run production smoke tests;
- `secrets.yml`: a manually dispatched, protected workflow for secret
  initialization, checking, and rotation; and
- `diagnose.yml`: a short, manually dispatched production diagnostic such as
  filtered Worker error tailing. It is disabled unless explicitly configured
  and must not print request bodies, credentials, or personal data; and
- `backup-verify.yml`: when enabled, a protected scheduled/manual workflow that
  restores into an isolated target, runs the backup verification contract,
  retains non-secret evidence, and performs explicit safe cleanup.

Cloudflare deployment steps use the official `cloudflare/wrangler-action`
with a pinned reviewed version or commit, the repository's pinned Wrangler
major, explicit `workingDirectory`, explicit account ID, and the pnpm package
manager. Direct Wrangler invocation remains available when it provides a
capability the action does not expose; both paths use the same checked-in
Wrangler configuration.

Actions and setup dependencies are pinned and updated deliberately. Workflows
declare minimal GitHub permissions. Pages deployment receives `contents: read`
and `deployments: write`; jobs that do not create GitHub deployments receive
only `contents: read`. Pull requests from forks never receive repository or
environment secrets.

GitHub Environments named `preview`, `staging`, and `production` scope
deployment credentials and URLs. Production supports required reviewers and
branch protection. Cloudflare API tokens are separate from application
runtime secrets, scoped to the required account and resources, and never
installed as Worker bindings. Hosted `ubuntu-latest` is the portable default;
projects may opt into explicit self-hosted runner labels.

Recommended pipeline:

``` text
PR -> lint -> typecheck -> tests -> build -> config validation
   -> trusted preview resources -> migrate -> deploy -> preview smoke

main -> serialized staging migration -> Worker + Pages deploy
     -> staging smoke gate
     -> serialized production expand migration
     -> Worker + Pages deploy
     -> production smoke gate
```

Deploy concurrency is serialized per target environment and is not cancelled
in progress. CI may cancel obsolete runs only when its test database is
isolated per run. A shared test database forces serialized CI; an ephemeral
database branch per run is preferred.

Staging and production use different databases, Worker names, custom domains,
Pages projects, R2 buckets, queues, DLQs, Workflow bindings, Durable Object
namespaces, auth origins, and secrets. Staging cannot contain production
payment, email, OAuth, or other live-service credentials unless a specific
integration has no safe test mode and the exception is documented.

Smoke tests exercise the deployed system rather than repeating unit tests.
The generated baseline checks API health, required binding presence without
revealing values, database connectivity, auth key availability, CORS, static
entry-point cache behavior, referenced asset existence and content type, SPA
deep links, webhook signature rejection, and environment mode. Applications
extend the suite whenever an integration failure escapes pre-deploy tests.

Normal deployments run `trestle secrets check` but do not rewrite unchanged
Worker secrets. Bootstrap and rotation happen through the protected
`secrets.yml` workflow or an authorized operator command. If secret values
must change atomically with code, the deployment creates a version containing
both and promotes that version only after validation.

Deployments use reviewed expand/contract migrations, a single migration lock,
and a compatibility window in which the previous and next Worker versions can
both use the schema. Migration failure stops promotion. Rollback never assumes
that a destructive database migration can be reversed automatically.

The CI runner is not part of production runtime. Production credentials
are narrowly scoped; migration credentials differ from application
credentials.

## 30. Testing

Testing includes unit, integration, system, workflow, authorization,
RLS, and idempotency tests.

Mandatory tenant tests:

``` text
Tenant A cannot read Tenant B
Tenant A cannot update Tenant B
Tenant A cannot delete Tenant B
Tenant A cannot infer Tenant B
```

Tests should intentionally issue incorrectly scoped/raw queries and
confirm PostgreSQL RLS still prevents leakage.

Async tests cover duplicate delivery, malformed envelopes, unsupported
schema versions, workflow retries, idempotent persistence, outbox
recovery, and DO-to-Postgres handoff failures.

Security and operations tests also cover the real application role, forced
RLS, missing/malformed tenant context, membership revocation, multi-tab tenant
cache separation, queue reordering and DLQ redrive, outbox publish/mark races,
workflow upgrades, adjacent-version migration compatibility, secret leakage
and environment isolation, R2 key tampering, organization deletion, and
backup restoration.

Evidence rules:

-   Missing, skipped, or blocked evidence is reported as such, never as a pass.
-   Evidence names the exact commit, package version, and environment it covers.
-   Results from local substitutes and from real providers are labelled
    separately; one never stands in for the other.
-   Every escaped defect gains a permanent regression test at the lowest layer
    that would have caught it.

## 31. CLI and Rails-Style Generators

The CLI is central to TrestleJS's developer experience. Its top-level command
surface is deliberately small; related lifecycle operations live under nouns.
The command tree below has two parts. The shipped part mirrors
`trestle --help` for the current release; that output and each subcommand's
`--help` remain authoritative. The planned part is design intent only.

Shipped. Global options: `--cwd <path>` starts project discovery from another
directory, and `--experimental` allows experimental commands for one
invocation.

Stable in beta:

``` text
npx create-trestlejs my-app               generate a new project

trestle project [--json]                  describe the current TrestleJS project
trestle env status [--env <env>] [--json] inspect one declared environment without contacting providers
trestle ci validate [--json]              validate the static GitHub Actions deployment contract
trestle architecture check [--json]       validate static application boundaries and managed guidance
trestle upgrade plan [--json] [--check]   preview an application-preserving project upgrade; --check fails unless already compatible
trestle upgrade apply --yes               apply the reviewed upgrade plan (metadata only)
trestle upgrade diff [--json]             inspect target-template paths without changing application source
trestle upgrade migrations [--json] [--check]
                                          audit application and target migration journals without writes
trestle upgrade source-apply --yes        apply only pristine adjacent-alpha application source
trestle upgrade source-finalize --yes     verify pristine source and run local checks before advancing the version
trestle doctor [--env <env>] [--json]     run read-only environment and architecture checks
trestle plan init                         write a starter SetupPlan describing the current project
trestle plan validate <file|-> [--json]   validate a versioned SetupPlan
trestle plan diff <file|-> [--json]       classify SetupPlan changes against the project
trestle plan status [file] [--json]       report recorded apply progress for a SetupPlan
trestle apply <file> --yes                apply the supported mutations in a reviewed SetupPlan
trestle resources [--json]                inspect declared resources
trestle routes [--json]                   inspect declared and statically discoverable routes
trestle resource add-field <Resource> <field> --yes
                                          add an optional field and tracked migration
trestle secrets init|edit|show|get|set|unset|import [--env <env>]
                                          manage encrypted application credentials
trestle secrets list|check [--env <env>] [--json]
                                          report credential status without revealing values
trestle secrets push --env <env>          push credentials to the remote Worker
trestle secrets key rotate [--env <env>]  rotate an environment's credentials master key
trestle email list|show|open|clear        inspect locally captured transactional email
trestle email doctor [--env <env>]        summarize and check email delivery configuration
trestle generate email <Name>             generate a React Email template
trestle generate resource <Name> [--field ...] [--webhook-event ...]
                                          generate a tenant-safe vertical slice
trestle payments stripe doctor [--env <env>]
                                          summarize and check Stripe credentials and mode
trestle payments stripe webhook configure --env <env> --url <url> --api-key-stdin
                                          configure a deployed Stripe billing webhook
trestle logs --env <env>                  tail redacted structured Worker logs
trestle dev [--fresh --yes]               start PostgreSQL, apply migrations, and run the local applications
trestle db start|stop|status|migrate|console
                                          operate the local PostgreSQL database
trestle db seed [--scenario <name>]       seed default, demo, or tenant-isolation data
trestle db reset --yes                    delete the project-scoped local volume
trestle db roles bootstrap --env <env> --role <name> --yes
                                          create a restricted remote PostgreSQL runtime role
```

Experimental in beta (requires `--experimental` or `TRESTLE_EXPERIMENTAL=1`):

``` text
trestle queue dlq list --env <env> [--json]
                                          inspect dead-lettered outbox messages
trestle queue dlq redrive <id> --env <env>
                                          redrive one dead-lettered outbox message
trestle queue prune --env <env> --before <timestamp> [--limit <n>] [--apply]
                                          preview or prune succeeded outbox records
trestle admin grant|revoke <email> <role> --env <env> --reason <reason>
                                          change a platform role; recorded in audit_event
trestle admin list --env <env>            list active platform-role assignments
trestle workflow list <name>              list Cloudflare Workflow instances
trestle workflow status <name> [id]       inspect a Workflow instance (default: latest)
trestle workflow retry <name> <id> --yes  retry a Workflow instance
trestle backup status --env <env>         inspect declared provider recovery capability
trestle backup verify --env <env> --to <target> --yes
                                          prove an isolated Neon restore and verify it
trestle restore create --env <env> --to <target> [--at <timestamp>] --yes
                                          create an isolated Neon point-in-time recovery branch
trestle restore delete --env <env> --target <target> --yes
                                          delete an isolated recovery branch
trestle payments stripe sync --env <env> [--apply] [--yes]
                                          plan or create missing Stripe products and prices
trestle payments stripe seed --organization <id> --cookie-stdin
                                          activate a local billing plan for an organization
trestle console (--tenant <id-or-slug> [--write] | --platform-admin) [--env <env> --yes]
                                          open an application-aware TypeScript console
```

For local Stripe webhook forwarding, use the Stripe CLI directly:
`stripe listen --forward-to localhost:8787/webhooks/stripe`.

Planned (not implemented):

``` text
trestle test [--watch] [--suite <name>]
trestle inspect
trestle deploy --env <env>
trestle admin install
trestle dev --tunnel
trestle generate workflow|queue|event|durable-object|admin-resource <Name>
trestle secrets diff|rotate
trestle workflow trigger <name>
trestle queue list|publish
trestle ci generate
trestle events|workflows|queues|durable-objects|bindings|permissions
```

Commands use `--env <env>` consistently instead of positional environment
names. Local is the default only for commands whose semantics are inherently
local; commands that can mutate remote infrastructure require an explicit
environment. `trestle env status` and `trestle project --json` are read-only
views of declared environments, bindings, deployment state, and configuration
health.

`--json` is the common diagnostic-output flag where applicable. JSON modes write only the documented payload to standard
output and send human diagnostics to standard error. Plaintext secret values
remain available only through the explicitly revealing `secrets show` and
`get` commands described in the secrets section; generic JSON,
diagnostic, status, inspection, and console output must redact them.

Read-only commands do not make opportunistic repairs. Mutating commands show
their target and planned effect before destructive or production operations.
They require confirmation in an interactive terminal unless an explicit,
documented non-interactive approval flag is supplied. Retry and redrive are
the domain terms: `workflow retry` creates or resumes an attempt according to
the Workflow's idempotency policy, while `queue redrive` moves selected DLQ
messages through the declared redrive path. Neither command promises a raw
in-place restart of provider state.

### Application console

`trestle console` starts an application-aware TypeScript REPL from the project
root. It is distinct from `trestle db console`, which launches raw `psql` for
database administration. The application console loads the same generated
domain services, repositories, typed configuration, contextual logger,
transaction helpers, and provider adapters used by the application. It
supports top-level `await` and exposes discoverable helpers rather than
requiring developers to reconstruct application wiring by hand.

The local environment is the default. Every session requires either
`--tenant <id-or-slug>` or `--platform-admin`; the two select different
authority planes and cannot be combined. `--write` requires `--tenant`. A
non-local environment also requires `--yes`:

``` bash
trestle --experimental console --tenant acme
trestle --experimental console --env staging --tenant acme --yes
trestle --experimental console --env production --tenant acme --yes
trestle --experimental console --env production --tenant acme --write --yes
trestle --experimental console --env production --platform-admin --yes
```

Tenant-scoped console work resolves the tenant through a non-sensitive
identifier, establishes the normal `ExecutionContext`, and executes database
operations through `withTenant` so forced RLS remains effective. The console
does not expose an unrestricted database handle by default. Raw SQL belongs
in `trestle db console`; exceptional bypass access requires the separately
authorized `--platform-admin` mode and is never inferred from the absence of a
tenant.

Staging and production require an explicit `--env`, display the resolved
account, application, database, and tenant or administrative scope, and
require confirmation before opening an interactive session. They use
environment-scoped credentials, attach operator identity and a console session
identifier to contextual logs, and record auditable session start/end events.
Production access is subject to the environment's existing authorization and
approval controls. Merely possessing a local master key does not grant remote
console access.

The production console opens in restricted read-only mode where the data
adapter can enforce it. Tenant-bound application writes require `--write`, a
second conspicuous confirmation, and credentials authorized for that scope.
`--write` does not grant cross-tenant or RLS-bypass authority.
`--platform-admin` selects a separately authorized privileged capability and
must not be implied by `--write`. The prompt always shows the environment,
tenant or platform scope, and `READ ONLY`, `WRITE`, or `PLATFORM ADMIN` mode;
production receives visually conspicuous treatment independent of color.

Secrets are available to application components through typed configuration
but are redacted from inspection, object rendering, completion, errors, and
logs. The console never prints all credentials automatically; deliberate
plaintext retrieval remains a `trestle secrets show|get|export` operation.
Command history is disabled by default. If enabled explicitly, it is stored in
a project-scoped, gitignored, mode-0600 file, and the CLI warns that entered
values may persist.

The console runs as a local Node process that imports shared application,
domain, and data packages. It does not add arbitrary evaluation to a deployed
Worker. Cloudflare bindings use local adapters in the local environment and
declared authenticated provider clients remotely where practical; unavailable
or semantically unsafe operations fail with an explanation instead of silently
falling back to a different implementation.

`trestle generate resource Article` should generate a
vertical slice containing:

-   Drizzle table;
-   RLS policy;
-   migration;
-   Zod create/update/response contracts;
-   domain/service skeleton;
-   repository/data module;
-   Hono routes;
-   typed API client;
-   TanStack query/mutation helpers;
-   TanStack Form create/update components where the slice includes UI;
-   Tailwind-styled accessible resource screens where the slice includes UI;
-   unit/integration tests;
-   adversarial tenant-isolation tests.

Generators create understandable application-owned source code rather
than hiding behavior in runtime magic.

Generated projects record the TrestleJS template and runtime versions. Releases
publish compatibility ranges, upgrade guides, and codemods where mechanical
changes are safe. Generator golden tests build and exercise fresh applications
so template drift is detected before release.

## 32. Developer Tooling and Machine Legibility

TrestleJS treats human legibility and machine legibility as the same product
requirement. A developer or coding agent entering an unfamiliar repository
should be able to discover its architecture, identify the correct extension
point, make a conventional change, and verify it without repository
archaeology. LLM judgment operates over a deterministic substrate of source
conventions, versioned metadata, generators, introspection, static checks,
seed scenarios, and tests.

This subsystem is not an autonomous agent, orchestration framework, hidden
application model, proprietary metadata database, or replacement for source
code. Metadata indexes and describes the application. Source code remains
authoritative for implementation behavior, and generated views must identify
their provenance and staleness rather than silently becoming a competing
truth.

### Project manifest and resource declarations

Every generated application contains a version-controlled,
secret-free `.trestle/project.yaml` with a required `schemaVersion`. It declares
the project name, application and package paths, tenancy strategy, database
engine and default provider, enabled capabilities, supported environments, and
project-level conventions. It answers what kind of application this is; it
does not reproduce detailed resource behavior already expressed in code.

Conceptually:

``` yaml
schemaVersion: 1
project:
  name: paper-route
apps:
  app: apps/app
  worker: apps/worker
packages:
  contracts: packages/contracts
  domain: packages/domain
  data: packages/data
  db: packages/db
  integrations: packages/integrations
tenancy:
  model: organization
  enforcement: postgres-rls
database:
  engine: postgresql
  defaultProvider: neon
capabilities:
  r2: true
  queues: true
  workflows: true
  durableObjects: true
environments: [local, preview, staging, production]
```

All TrestleJS commands validate the manifest before depending on it. An unknown
future schema version fails explicitly rather than receiving a best-effort
interpretation. `trestle upgrade plan` previews and `trestle upgrade apply --yes`
performs a mechanical metadata migration after review; migrations requiring
architectural judgment remain explicit application work. `trestle upgrade
check` verifies project metadata and managed guidance without writing.
Template source changes go through `trestle upgrade diff`, `trestle upgrade
migrations`, `trestle upgrade source-apply`, and `trestle upgrade
source-finalize`, which stop for manual review instead of overwriting edited
files. None of these commands infers or writes secret values.

Important application concepts may declare compact resource metadata adjacent
to their generated source. From those declarations and statically discoverable
contracts, TrestleJS derives a resource registry containing resource name,
tenant and parent relationship, table, API shape, events, workflow, and Durable
Object relationships where applicable. Generated caches are disposable and
must be reproducible from the manifest and source declarations. Hand-editing a
derived registry is neither required nor authoritative.

### Read-only architecture discovery

The CLI exposes read-only semantic discovery commands:

``` bash
trestle project
trestle routes
trestle resources
trestle events
trestle workflows
trestle queues
trestle durable-objects
trestle bindings
trestle permissions
trestle env status
trestle db status
```

Plural commands describe declared architecture. Singular operational commands
such as `trestle --experimental workflow status <name> [id]` and
`trestle --experimental queue dlq redrive <id>` inspect or
act on runtime instances. This distinction is stable across the CLI.

Discovery output includes source locations and relationships where they are
statically knowable. In particular:

-   routes include method, path, normalized route, handler location,
    authentication requirement, permission requirement, and resource;
-   events include name, schema version, contract location, known producers
    and consumers, and deprecated versions;
-   workflows include input contract, declared steps, owning resource, and
    tenant-resolution rule, while Cloudflare remains authoritative for live
    executions;
-   permissions include the typed authorization vocabulary and known role
    composition;
-   bindings include type and configuration status by environment, never
    secret values; and
-   resources include tenant, parent, persistence, API, event, workflow, and
    coordination relationships.

All meaningful discovery commands support `--json`. Structured CLI output is
a public API for tools and agents and uses a versioned envelope:

``` json
{
  "schemaVersion": 1,
  "data": {}
}
```

Within a schema version, field meaning, types, stable identifiers, exit-code
semantics, and normalized repository-relative paths remain compatible. New
optional fields may be added according to the documented compatibility policy;
breaking changes require a schema-version change. Human formatting may evolve
independently. Agents should consume structured output rather than scrape
terminal presentation.

### Deterministic seeds and time

Seed scenarios are version-controlled application code under `seed/`, with a
default scenario and named scenarios such as `demo` and `tenant-isolation`:

``` bash
trestle db seed
trestle db seed --scenario demo
trestle db seed --scenario tenant-isolation
```

Seeds are deterministic where practical, idempotent or restricted to known
clean state, and exercise normal application constraints. A generated
multi-tenant application includes an isolation scenario with at least two
organizations, principals, memberships, and resource trees. The same scenario
may support local development, RLS/API/browser tests, demonstrations, admin
testing, and agent verification. Stable test identifiers are preferred where
they improve repeatability.

Production seeding is prohibited by default. An application may deliberately
declare a narrowly scoped production seed capability, but invoking it requires
an explicit production environment, a description of affected records,
strong confirmation, appropriate credentials, and an audit event.

The standard test runtime provides a fixed, advanceable `createTestClock`.
Generated tests use it for expiration, publishing, invitations, retries,
scheduling, grace periods, and other business deadlines instead of sleeps or
uncontrolled wall-clock reads.

### External integrations and features

External providers live behind application-owned interfaces under
`packages/integrations/`. Domain packages do not import provider SDKs. Adapters
centralize configuration and secret access, payload redaction, standardized
semantic logging, metrics, idempotency, retries, timeout policy, and normalized
failures. For example, domain code depends on `LlmService`, while an
`OpenAIAdapter` or another provider implements it.

Integration logs use the standardized event vocabulary, for example
`integration.llm.request.started`, `.completed`, and `.failed`, without
automatically recording credentials or sensitive request/response bodies.
Test doubles implement the same application interface and are selected through
composition, not conditionals scattered through domain code.

Features are typed application names evaluated through `ctx.features`.
The default provider may be static configuration or PostgreSQL according to
application needs. This convention enables deterministic tests and future
provider replacement without committing TrestleJS to a feature-flag SaaS or
allowing untyped `process.env` checks throughout business logic.

### Generated agent guidance

Every application generates a concise root `AGENTS.md` from the project
manifest, TrestleJS conventions, and declared package paths. It summarizes the
architecture, important locations, non-negotiable tenancy and dependency
rules, standard discovery commands, and required verification. It is short
enough to load routinely into an agent context.

Generated content is enclosed in stable managed markers. Applications may add
clearly separated custom guidance outside those markers. Regeneration updates
only the managed region, preserves custom content byte-for-byte, and is
idempotent. `trestle architecture check` and `trestle upgrade plan --check` detect a
stale managed-guidance marker without rewriting anything; `trestle upgrade
apply --yes` refreshes it.

### Deterministic architecture verification

`trestle doctor` is both an environment diagnostic and the primary
deterministic architecture verifier. In addition to the local-development
checks above, it validates the project manifest and package graph, freshness of
derived metadata and `AGENTS.md`, forbidden dependency directions, restricted
raw database and provider-SDK imports, tenant-table policies, forced RLS and
the real application role, versioned queue/event contracts, workflow
declarations, required secrets, and Cloudflare bindings.

Human output groups checks by architecture, database, async processing,
environment, and agent metadata. JSON output uses stable check identifiers and
includes status, severity, evidence, source locations, and remediation. This
gives a human or agent deterministic correction feedback without granting the
doctor mutation authority.

The intended development loop is:

``` text
discover project and architecture through structured commands
  -> express the change in conventional source and generated extensions
  -> run trestle doctor
  -> run the smallest relevant deterministic tests
  -> run broader required verification
  -> report evidence, deviations, and remaining work
```

## 33. Agent Setup Skill

Every generated project ships `.agents/skills/trestle-setup/SKILL.md`, which
owns the discovery and conversation procedure: it turns a product idea or an
existing project into a reviewed, verified TrestleJS application, while the CLI
owns every deterministic filesystem and infrastructure operation. The
architectural contract is:

- The skill's durable output is a SetupPlan at `.trestle/setup.json`
  (`trestle plan init` writes a starter), which stores secret names and
  requirements, never values.
- Before explicit approval it performs read-only work only.
- Mutation goes through `trestle plan diff` and `trestle apply --yes`; the
  skill never reproduces a CLI-owned operation by hand.
- Production, DNS, paid, and destructive operations each need separate,
  operation-specific approval.
- Verification uses `trestle doctor` and the project's own checks, and the
  final report distinguishes evidence from assumptions.

## 34. Small Runtime, Strong Conventions

The reusable TrestleJS runtime should contain only genuinely
cross-application primitives such as:

-   context construction;
-   `withTenant`;
-   error mapping;
-   correlation/causation;
-   event envelopes;
-   outbox support;
-   Better Auth integration;
-   Cloudflare adapters;
-   clock and typed feature-evaluation contracts;
-   typed configuration and secret-provider adapters.

Application-specific behavior should be generated into the app whenever
practical.

## 35. Static Architectural Enforcement

A TrestleJS ESLint plugin should enforce important boundaries where
feasible:

-   restricted raw DB imports;
-   forbidden infrastructure imports from frontend/domain packages;
-   package dependency direction;
-   no direct manipulation of tenant session state;
-   required validation at designated trust boundaries where statically
    detectable;
-   forbidden secret access from browser, domain, and generated public
    configuration modules;
-   direct `console` usage in application packages outside approved logging
    adapters, CLI commands, build scripts, and infrastructure modules;
-   direct provider-SDK imports outside declared integration adapters;
-   direct wall-clock access in domain code where `ctx.clock` is required;
-   ad hoc environment-variable feature checks where a typed feature is
    declared.

Static checks supplement, but never replace, runtime security controls
such as PostgreSQL RLS.

## 36. Infrastructure Economics

A core design constraint is:

> **No infrastructure rent before product revenue when production-shaped
> free-tier infrastructure is available.**

The default bootstrap combination is intended to make this realistic:

``` text
Cloudflare serverless primitives
Neon Free PostgreSQL
Better Auth self-hosted in Workers
GitHub Actions / optional self-hosted runner
```

Large data belongs in R2 rather than Postgres. When the application
earns revenue or outgrows free tiers, providers may be upgraded or
replaced without redesigning the application.

## 37. v1 Scope

v1 should include:

1.  `create-trestlejs` project generator.
2.  React + TanStack Router, Query, and Form frontend template with Tailwind
    CSS and generated Better Auth screens.
3.  Hono Worker API template.
4.  Better Auth integration.
5.  Drizzle + PostgreSQL integration.
6.  Standard Drizzle RLS helpers.
7.  `withTenant()` transaction abstraction.
8.  Zod contract conventions.
9.  ApiContext/SystemContext/ExecutionContext.
10. Resource generator.
11. Event envelope and transactional outbox conventions.
12. Queue and Workflow templates/generators.
13. R2 bindings.
14. Durable Object template/generator.
15. Shared error mapping.
16. Standardized contextual logger, semantic event vocabulary, redaction,
    local/production formatting, test logger, and correlation conventions.
17. Local/preview/staging/production environment conventions.
18. Base GitHub Actions CI workflow.
19. Tenant isolation/RLS test harness.
20. `trestle doctor` for configuration/architecture checks.
21. `trestle secrets` manifest, local workflow, Cloudflare provider, CI checks,
    redaction, and rotation conventions.
22. Provider-backed backup status, isolated restore and verification commands,
    recovery safety rules, evidence records, R2-reference checks, and generated
    operational runbooks.
23. Scheduled job and inbound webhook templates with idempotency and
    resource-derived tenancy.
24. Provider-neutral outbound email adapter, local capture sink for auth
    flows, React Email templates, and Resend delivery (shipped).
25. Generated GitHub Actions for CI, trusted previews, staged Cloudflare
    Worker and Pages deployment, protected secret operations, diagnostics,
    and post-deploy smoke tests.
26. `trestle-setup` requirements, versioned SetupPlan schema, plan
    validation/diff/apply/status commands, resumable execution state, and
    plan-derived verification.
27. `trestle dev` orchestration, Docker PostgreSQL, local Cloudflare bindings,
    persistent/fresh state lifecycles, tunnel and inspection support, isolated
    tests, generated local configuration, and local-development diagnostics.
28. The normalized top-level CLI command hierarchy, read-only machine-readable
    diagnostics, Queue/DLQ operations, environment status, and consistent
    `--env` targeting.
29. `trestle console` as an application-aware TypeScript REPL with tenant-bound
    RLS context, explicit and audited remote access, redacted secrets, and a
    clear boundary from raw `trestle db console` access.
30. Versioned `.trestle/project.yaml`, source-derived resource metadata, and
    stable human/JSON architecture discovery commands.
31. Deterministic default, demo, and tenant-isolation seed scenarios plus a
    fixed, advanceable test clock.
32. Provider-neutral integration interfaces, typed feature evaluation, and
    their static import/configuration boundaries.
33. Concise generated `AGENTS.md` guidance with preserved custom sections and
    doctor-enforced freshness.
34. Optional admin application installation and admin-resource generation with
    tenant-bound application semantics, narrow platform capabilities, and
    auditable operational views/actions.
35. Payments: provider-neutral `BillingService`, local deterministic billing,
    Stripe Checkout/Portal/webhooks adapter (shipped).

## 38. Deferred Functionality

The deferred list and the rule for adding a new subsystem live in
[ROADMAP](ROADMAP.md) *Deliberately deferred*.

## 39. Acceptance Criteria

v1 is accepted when a clean `create-trestlejs` project completes the
[ROADMAP](ROADMAP.md) *Beta completion criteria* path without manual source
repair, covering the §37 scope, and every invariant stated in the sections
above has at least one automated test. The
[beta testing ledger](BETA_CANDIDATE_TESTING_LEDGER.md) records the evidence.

## 40. Product Positioning

The concise description is:

> **TrestleJS is a Rails-inspired TypeScript stack for building durable,
> multi-tenant applications on Cloudflare.**

A more technical description is:

> **TrestleJS composes React, TanStack Router, TanStack Query, TanStack Form,
> Tailwind CSS, Hono, Better Auth, Zod, Drizzle,
> PostgreSQL, and Cloudflare's serverless primitives into an opinionated
> application architecture with generators, secure defaults, and
> production conventions.**

The differentiator is not a new runtime primitive. It is **convention
over integration**: making excellent existing primitives almost as
frictionless to use together as an integrated BaaS, while preserving
explicit architecture, standard PostgreSQL, inspectable source code, and
provider portability.
