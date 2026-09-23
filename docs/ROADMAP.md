# TrestleJS Roadmap

TrestleJS is being built from one trustworthy vertical slice outward. The
architecture specification describes the intended v1 system; this roadmap
separates that destination from what the published CLI actually implements.

The installed `trestle --help` output remains authoritative for any specific
release.

## Release stages

| Stage | Outcome | Status |
| --- | --- | --- |
| Alpha 1–5 | Reproducible starter, local runtime, auth, Southwind site, setup skill, encrypted credentials, email and billing boundaries, SetupPlan, and initial resource generation | Shipped |
| Alpha 6 | A trustworthy tenant-owned CRUD slice from browser to forced PostgreSQL RLS, plus safe plan/apply repair | Shipped |
| Alpha 7 | Production deployment evidence through GitHub, Cloudflare, and Neon | Next |
| Alpha 8 | Asynchronous execution spine: outbox, Queues, Workflows, DLQ, schedules, and R2 | Core shipped; provider wiring remaining |
| Alpha 9 | Production integrations and end-to-end observability | Planned |
| Alpha 10 | Recovery, operational tooling, deterministic data, and safe remote access | Planned |
| Alpha 11 | Resource evolution and framework upgrade lifecycle | Planned |
| Alpha 12 | Optional admin, enforcement, full-system hardening, and beta preparation | Planned |
| Beta | Stable conventions, migration compatibility, upgrade rehearsals, and production evidence from real applications | Planned |
| v1 | Supported end-to-end product-development and deployment path with documented compatibility guarantees | Planned |

## Today’s push: Alpha 7/8 → Beta candidate

The goal for today is to produce a credible beta candidate from a clean
`create-trestlejs` project. This is an execution plan, not a promise that
beta is complete before the evidence gates pass.

### Must-pass gates

- [ ] **Clean-project canary:** create a fresh project from the checked-in
  package, install with the frozen lockfile, and run the complete generated
  typecheck, test, build, and Worker dry-run suite.
- [ ] **Local product path:** boot PostgreSQL, create an account, complete
  local email verification through captured email, create/select an
  organization, and exercise generated CRUD across two tenants.
- [ ] **Deployment path:** configure GitHub, Cloudflare, Neon, Resend, and
  Stripe test-mode environments with encrypted secrets; deploy an isolated
  preview and staging from GitHub Actions.
- [ ] **Staging system gate:** run browser/API tests against the deployed
  Astro site, React application, Worker, authentication, email, billing,
  resource CRUD, tenant switching, forced RLS, CORS, deep links, health, and
  invalid webhook signatures.
- [ ] **Promotion evidence:** publish GitHub Deployment records, verify the
  restricted runtime database role, promote the exact reviewed commit, and
  pass production smoke checks without exposing credentials.
- [ ] **Async smoke path:** exercise HTTP mutation → PostgreSQL outbox → Queue
  delivery → idempotent consumer, plus one deterministic Workflow retry and
  one artifact signed-access check.

### Same-day hardening

- [ ] Finish generated Cloudflare Queue, Workflow, and R2 binding/config
  support behind capability flags.
- [ ] Connect the Worker mutation path to the transactional outbox and wire
  the Queue consumer to the event registry.
- [ ] Add PostgreSQL-backed artifact metadata, retention, and cleanup. Alpha 34
  adds bounded scheduled cleanup for incomplete R2 uploads; ready-object
  retention policy and deleted-object audit/reconciliation remain.
- [ ] Align Drizzle snapshots and make migration generation idempotent.
- [ ] Add protected Resend/Stripe test-mode integration tests and staging
  recipient protection.
- [ ] Add operational checks for deployment identity, bindings, migration
  state, runtime role, queue/DLQ state, and provider mode.

### Beta-candidate exit criteria

We can call the result a **beta candidate** only when a clean generated
project can complete the following without manual source repair:

```text
create project
  → configure encrypted environments
  → boot locally and verify email/auth/tenancy/RLS
  → deploy preview
  → deploy staging
  → pass deployed system gate
  → promote the same commit
  → pass production smoke checks
  → exercise async delivery and recovery
  → record non-secret evidence
```

If a provider account, domain verification, or deployment credential blocks a
gate, record the exact external prerequisite and keep the local substitute
and deterministic test green. Do not mark that gate complete on the basis of
unit tests alone.

## Alpha 6: trustworthy vertical slice

Alpha 6 makes `trestle generate resource <Name> --tenant --crud` a complete,
testable path rather than a collection of adjacent files.

- Requests resolve an `ExecutionContext` containing the authenticated
  principal, explicitly selected tenant, freshly revalidated membership,
  permissions, correlation data, tenant-scoped database, logger, clock,
  features, and services.
- Generated Hono routes validate contracts and call a domain service through
  a repository boundary.
- Generated repositories use an organization-scoped database connection and
  retain explicit organization predicates as defense in depth.
- Generated PostgreSQL tables enable and force RLS, revoke public access, and
  grant the restricted application role only the required operations.
- Generated React screens use TanStack Router, Query, and Form for list,
  create, edit, and delete behavior; query keys include tenant identity.
- Semantic logs carry correlation and tenant context and recursively redact
  sensitive fields.
- Membership-revocation and cross-tenant tests fail closed. The RLS suite runs
  against real PostgreSQL without mocks.
- SetupPlan drift detection finds missing generated files or registrations.
  `trestle apply` restores only missing scaffold artifacts and does not
  overwrite application-owned source.

Alpha 6 does **not** turn resource generation into a dynamic runtime or
overwrite customized domain code. Generated source belongs to the application.

## Alpha 7: deployment truth

Alpha 7 proves that a freshly generated Trestle application can move safely
from GitHub to preview, staging, and production on Cloudflare and Neon. It
should deepen the vertical slice instead of introducing another application
subsystem.

### Production database roles

- Separate schema-migration credentials from runtime credentials.
- Ensure the runtime identity cannot bypass forced RLS.
- Prove that tenant-scoped role selection works through the production Neon
  driver, not only local `postgres-js` connections.
- Verify role membership, grants, forced RLS, and fail-closed tenant behavior
  through remote Doctor checks.
- Use the same production role model for generated resources and other
  tenant-owned application projections.

### Cloudflare deployment

- Deploy the Hono Worker, authenticated React application, and Astro site.
- Keep preview, staging, and production Worker names, Pages projects,
  databases, origins, bindings, credentials, and provider modes separate.
- Publish actual GitHub Deployments with the resulting URLs.
- Serialize staging and production migration/deployment operations.
- Promote the same reviewed commit only after the staging smoke gate passes.
- Document a code rollback that does not pretend destructive database changes
  can be reversed automatically.

### Generated GitHub Actions

- Use the project's pinned Trestle CLI instead of
  `pnpm dlx trestlejs@latest`.
- Pin third-party Actions to reviewed commit SHAs.
- Retain the trusted-pull-request boundary so forks receive no deployment
  secrets.
- Add preview lifecycle cleanup and non-secret deployment evidence.
- Project encrypted credentials into Worker secrets without printing values
  or rewriting unchanged secrets on ordinary deployments.
- Validate the generated workflows and Wrangler configuration before a
  deployment begins.

### Deployed system test

The staging gate should exercise the deployed system rather than merely rerun
unit tests. It must:

1. load the public Astro site and authenticated application;
2. create an account and complete an email-verification flow safely;
3. create an organization and select it explicitly;
4. create, list, update, and delete a generated `Article` through the real
   application/API boundary;
5. switch tenants without reusing another tenant's TanStack Query cache;
6. attempt cross-tenant reads and mutations and prove PostgreSQL rejects
   them;
7. confirm missing or revoked membership fails closed;
8. reject unsigned or invalid Resend and Stripe webhook requests; and
9. verify health, CORS, SPA deep links, and required bindings without exposing
   secret values.

### Remote diagnostics

Alpha 7 should provide a coherent read-only production view through commands
such as:

```bash
trestle env status --env staging
trestle doctor --env staging --json
trestle ci validate
```

Whether deployment is initiated through `trestle deploy --env <env>` or only
through generated GitHub Actions must be explicit. The CLI must not imply a
deployment command exists when GitHub is the actual control plane.

Diagnostics should report environment URLs, deployment identity, binding
presence, secret-name completeness, migration state, database roles, forced
RLS, runtime mode, and smoke-test status without revealing credentials.

### Capability honesty

The starter currently declares R2, Queues, Workflows, and Durable Objects
before those application paths are implemented. Alpha 7 must distinguish:

```text
declared → configured → deployed → verified
```

Until a capability is implemented, generated projects should disable it or
report it accurately as unavailable. A provider feature is not a shipped
Trestle capability merely because it appears in a manifest or Wrangler
supports it.

### Release canary

Maintain a clean generated application as a release canary. Every framework
release should create or safely upgrade it, generate a representative tenant
resource, run the complete local check, deploy staging, run the deployed
system gate, and preserve non-secret evidence. This converts production
compatibility from an assumption into a release artifact.

Alpha 46 closes a local tenant-switching gap: the generated application
exposes Better Auth's organization selector, scopes billing and generated
resource query caches to both principal and organization, clears application
queries on authentication or organization changes, and sends an explicit
tenant header for billing operations. The clean-project PostgreSQL system
test now creates two organizations, switches the active session organization,
and denies cross-tenant Article reads and mutations. This is local system
evidence; deployed browser and provider gates remain open.

Alpha 47 adds a real Chromium local-product gate to generated project CI and
release verification. It signs up, opens the captured verification email,
signs in, creates two organizations, and confirms that the billing view follows
the selected tenant. The release canary also generates Article and exercises
browser create, edit, delete, cache isolation, and cross-tenant API denial.
This is local browser evidence, not a substitute for the deployed staging gate.

Alpha 48 extends that browser gate across Southwind and the application:
it follows sign-in and Pro pricing intent into hydrated React routes, checks
API CORS through a real browser, and opens an application deep link directly.
The same read-only browser test is required after preview, staging, and
production HTTP smoke checks, before deployment evidence is published. Its
deployed execution is still unverified until provider configuration lets the
canary reach an actual deployment; authenticated staging and production
provider flows remain separate beta work.

Alpha 49 hardens the generated browser gate after Alpha 48's tag publish job
timed out starting its local web servers (while PR CI had passed). Browser
tests now serve the built Astro output with a small foreground Node server,
record each server's startup output, and give Worker/App startup a bounded
three-minute window. The release canary verifies static routes and traversal
rejection. Alpha 48 was not published; Alpha 49 is its superseding package
release. Neither tag is deployed-system evidence until preview passes.

### Alpha 7 acceptance criteria

Alpha 7 is complete when this path succeeds without manual source repair:

```text
create project
  → configure declared GitHub environments and provider credentials
  → push a trusted branch
  → migrate and deploy an isolated preview
  → publish preview URLs and pass preview smoke tests
  → merge the reviewed commit
  → migrate and deploy staging
  → pass authentication, resource, tenancy, and RLS system tests
  → promote the same commit to production
  → pass production smoke tests and record deployment evidence
```

## Alpha 8–12

After production deployment is proven, the remaining alphas should proceed in
dependency order.

### Alpha 8: asynchronous execution spine

The Alpha 8 core checkpoint is now implemented and committed. Generated
projects have versioned event envelopes, a persistent transactional-outbox
store, leasing/retry/dead-letter recovery, Queue adapters, deterministic
Workflow retry, tenant-owned artifact metadata, local/R2 storage adapters,
signed artifact access, and DLQ inspection/redrive commands. The generated
release canary covers these paths without external provider accounts.

Remaining Alpha 8 release work is provider wiring and operational hardening:

- configure generated Cloudflare Queue, Workflow, and R2 bindings only when
  the corresponding capability is enabled;
- connect the Worker HTTP/domain mutation path to a database transaction plus
  outbox append, and connect the Worker Queue consumer to the event registry;
- persist artifact metadata through the PostgreSQL repository in the R2 path;
- align Drizzle snapshots with the checked-in asynchronous migrations; and
- add protected provider integration tests and ready-object retention and
  reconciliation jobs. Alpha 34 schedules incomplete-upload recovery.

- Versioned domain-event and message-envelope registries.
- Transactional outbox with leasing, retry, recovery, and retention.
- Cloudflare Queue producer/consumer generation with idempotency.
- DLQ inspection and selective redrive.
- Workflow and scheduled-job generation with deterministic retry behavior.
- R2 artifact metadata, tenant authorization, signed access, and cleanup.
- Local adapters and tests for the complete HTTP → outbox → Queue → Workflow
  path.

### Alpha 9: production integrations and observability

Outbound webhooks are an additional phased track. Alpha 35 provides
only the event-definition contract: runtime schemas, safe public projection
metadata, example and fixture validation, and independent internal/public
versions. It does not yet persist webhook messages or deliver to endpoints.
Alpha 36 adds committed tenant provenance to outbox rows and generated resource
mutations. Queue envelopes remain tenant-authority-free; webhook projection
must reload the committed outbox row before selecting a tenant subscription.
Alpha 37 adds inert endpoint intent and normalized public-event-version
subscriptions with forced tenant RLS and cross-tenant foreign-key checks.
Alpha 38 adds tenant-owned immutable message and delivery rows plus a
post-commit projector that reloads trusted outbox provenance, validates the
public contract, enforces payload limits and entitlements, and snapshots active
subscriptions idempotently. Alpha 39 adds durable, tenant-isolated local attempt
capture with signed request snapshots, scripted responses, bounded retry, and
an advanceable clock; local capture makes no network requests. Alpha 40 adds
encrypted tenant-owned signing-secret versions, one-time issuance, bounded
rotation overlap, immediate previous-key revocation, and metadata-only
management reads. The key is an optional encrypted runtime credential until
the capability is enabled. Alpha 41 connects catalog-declared events to
post-commit projection in Queue and Workflow consumers: it reloads the
committed outbox row, rejects mismatched Queue envelopes, uses canonical tenant
and entitlement state, and keeps projection within inbox retry handling when
local webhook mode is explicitly enabled. Disabled mode remains inert; native
and Svix modes fail closed until their delivery adapters exist.
Alpha 42 adds a reusable native destination preflight: strict HTTPS URL
parsing, public-address checks for IPv4 and IPv6, mixed-answer rejection,
and fresh DNS resolution on every attempt. It deliberately does not enable
native sending: Cloudflare Workers cannot pin an arbitrary `fetch` request to
the address it just approved. A transport with that guarantee (or a trusted
egress gateway) is required before native mode can be activated.
Alpha 43 adds tenant-scoped native delivery leases, a database-enforced lease
invariant, and atomic duplicate-claim and expired-lease recovery. PostgreSQL
tests cover competing workers, tenant isolation, inactive endpoints, and
reclamation. Alpha 44 adds lease-token-fenced attempt settlement, bounded
jittered retries, `410 Gone` and exhaustion terminal states, and safe native
attempt metadata that omits signed request bodies and headers. PostgreSQL tests
cover duplicate and stale settlement, tenant isolation, retry timing, and
transaction rollback. Alpha 45 adds strict ID-only Queue wake-up validation
and a read-only resolver that obtains tenant provenance from the committed
outbox row, then verifies the projected delivery under forced tenant RLS.
Tests reject forged tenants, swapped event/delivery identities, inactive
endpoints, and environment mismatches. Queue publication/consumption and the
pinned-address transport remain unimplemented, so native mode still fails
closed.
Alpha 50 closes the local event-to-attempt gap: a committed event projected
from Queue processing now captures signed attempts for active local endpoints
without network access. Missing signing material fails the inbox operation
for retry, duplicate Queue deliveries do not duplicate attempts, and a
bounded, advanceable-clock flush processes later local retries. Native and
Svix delivery remain disabled until their transport and provider contracts
are complete.
Alpha 51 adds bounded, tenant-scoped webhook payload retention. Scheduled
local maintenance erases public envelopes and captured signed request
material after the application defaults of 30 days (standard) or seven days
(short), stops pending retries, and preserves status metadata. Active leases
defer erasure until safe. Provider-specific effective retention and 90-day
metadata pruning remain future work.
Alpha 52 adds the native webhook destination egress policy: HTTPS-only URLs,
no embedded credentials or fragments, fresh IPv4 and IPv6 resolution for each
attempt, rejection of the entire DNS answer set if any address is non-public,
and an approved-address result that must be used for a pinned TLS connection
with the original hostname for certificate verification. Adversarial tests
cover private, loopback, link-local, carrier-grade NAT, reserved, multicast,
unspecified, and IPv4-mapped IPv6 answers. Native mode still fails closed until
the pinned transport and Queue dispatcher are integrated and verified.
Alpha 53 adds the pinned HTTPS transport behind that policy. It uses the
approved IP for the connection and the original hostname for SNI and TLS
certificate validation, sends one bounded HTTP/1.1 request, rejects request
header injection, does not follow redirects, bounds response headers and
timeouts, and normalizes response and failure categories. Tests cover the
connection identity, 2xx/redirect responses, interim and malformed responses,
unauthorized TLS, DNS-policy rejection, and late-handshake races. The Queue
dispatcher and live Cloudflare transport proof remain required before native
mode can be enabled.
Alpha 54 wires the post-commit projection to ID-only Queue wake-ups, reloads
tenant provenance from the committed outbox row, leases and signs each native
attempt, settles provider responses, and schedules bounded retries. A cron
recovery scan re-enqueues due deliveries and expired leases after lost Queue
handoffs. Scheduled retention applies to native payloads as well as local
capture. Doctor requires a Queue binding and encrypted signing key before
native mode is enabled. PostgreSQL tests cover tenant isolation, duplicate
wake-ups, retry, lease recovery, and metadata-only native attempt storage;
generated browser and Worker dry-run checks pass. Live Cloudflare egress and
end-to-end deployed delivery remain unproven, so the starter still defaults to
disabled mode.
Alpha 55 enforces the first native dispatch backpressure rule at the
PostgreSQL claim boundary: at most four unexpired leases may be active for one
endpoint by default, even when several Queue workers compete. A capacity
rejection does not increment an attempt or drop the delivery; it is delayed
and remains visible to the recovery sweep. PostgreSQL contention tests cover
the limit and release of a slot after settlement. Per-tenant/global limits,
plan throughput, and provider request-rate policies remain separate work.
Alpha 56 adds authenticated, tenant-scoped webhook inspection endpoints for
endpoint state, delivery history, and attempt outcomes. The read model selects
metadata only: destination hosts, not paths or query strings; no signing keys,
headers, request bodies, response bodies, or payload envelopes. Owner and admin
roles receive granular read permissions, while forced RLS and environment
predicates remain separate protections. PostgreSQL and generated-browser tests
cover tenant isolation, redaction, and malformed requests.
Alpha 57 adds the application-owned, read-only customer inspection screen for
endpoints, deliveries, and attempt outcomes. Its TanStack queries are scoped
to the signed-in user and selected organization, and switching organizations
clears the selected endpoint and delivery. The screen renders only the safe
metadata fields returned by Alpha 56, states its 50-record limit, and shows
permission failures without exposing provider responses or secrets. Generated
browser coverage exercises both organizations, the record hierarchy, redaction,
and denied access. Cursor pagination, deeper operational controls, deployed
native delivery proof, and the optional Svix adapter remain.
A committed domain event remains authoritative;
webhook failure must never undo its domain mutation.

- Finish Resend and Stripe environment lifecycle, reconciliation, staging
  safety, and protected provider integration tests.
- Use `ExecutionContext` consistently for every authenticated application
  route, including billing.
- Standardize shared error mapping, semantic event names, correlation across
  asynchronous boundaries, redaction, metrics, and operational health.
- Add `trestle logs` without turning it into a secret or request-body escape
  hatch.

### Alpha 10: operations and recovery

- Provider backup status, isolated restore, verification, and evidence.
- Queue/DLQ and Workflow inspection/retry operations.
- A tenant-bound, audited, remote-safe application console distinct from raw
  database administration.
- Deterministic default, demo, and two-tenant isolation seed scenarios.
- A fixed, advanceable test clock and `trestle dev --fresh` lifecycle.

### Alpha 11: evolution and upgrades

- Additional resource field types, relationships, pagination, authorization
  policies, and migration-safe edits.
- Generated typed API clients instead of screen-local request helpers.
- Versioned template migrations, dry-run project upgrades, compatibility
  checks, and narrowly scoped codemods.
- Static architectural checks and managed-guidance freshness without
  overwriting application-owned custom sections.

### Alpha 12: beta hardening

- Optional admin application and application-backed admin resources.
- Full browser, deployment, authorization, idempotency, upgrade, recovery,
  and adjacent-version migration suites.
- Complete machine-readable inspection for routes, resources, events,
  workflows, queues, Durable Objects, bindings, permissions, and environments.
- Resolve remaining specification/implementation contradictions and freeze
  the supported beta command and compatibility contracts.

## Remaining v1 gaps

The largest gaps between Alpha 6 and the current v1 specification are:

- production evidence for Cloudflare, Neon, Resend, and Stripe;
- the outbox, Queue, DLQ, Workflow, schedule, Durable Object, and R2 paths;
- provider-backed backup and isolated restore verification;
- shared error mapping and cross-boundary observability;
- secure remote operational tooling and application console behavior;
- richer resources, generated typed clients, and authorization policies;
- foundational locale, time-zone, civil-date, exact-money, and currency
  semantics; optional translation is separate product scope. The supplied
  locale/time/money document is an overview and the full normative draft is
  still needed before these contracts can be marked implemented;
- framework upgrade/sync tooling and compatibility guarantees;
- optional admin installation and admin-resource generation;
- static architectural enforcement and complete machine-readable discovery;
  and
- full browser and deployed-system tests from a clean generated application.

## v1 target

v1 should let a team create, evolve, operate, and deploy a conventional
multi-tenant product without first inventing its architecture. The minimum v1
bar includes:

- stable project manifest, SetupPlan, and command contracts;
- safe resource, email, queue, workflow, and integration generators;
- explicit authorization and forced tenant isolation throughout the data
  path;
- complete local substitutes for required external services;
- preview, staging, and production deployment with environment-safe secrets;
- actionable Doctor checks and machine-readable inspection;
- documented upgrade and rollback paths;
- system-level evidence from a clean `create-trestlejs` project.

## Deliberately deferred

TrestleJS will not chase every feature supported by its underlying providers.
The following remain outside the default framework until real applications
demonstrate a common need:

- a visual low-code resource builder;
- a marketing email or CRM platform;
- a general-purpose billing engine, marketplace, or tax abstraction;
- multi-provider failover abstractions without operational evidence;
- a proprietary component library or template language;
- provider objects leaking into domain contracts.

The direction remains: strong conventions, visible application-owned source,
local-first development, PostgreSQL-enforced tenant safety, and explicit
operations.
