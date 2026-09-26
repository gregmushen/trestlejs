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
| Alpha 7 | Production deployment evidence through GitHub, Cloudflare, and Neon | Partly shipped: generated GitHub Actions deploy isolated previews and staging; production promotion evidence remains |
| Alpha 8 | Asynchronous execution spine: outbox, Queues, Workflows, DLQ, schedules, and R2 | Partly shipped: core and Cloudflare binding wiring shipped; deployed end-to-end async evidence remains |
| Alpha 9 | Production integrations and end-to-end observability | Partly shipped: `trestle logs`, Resend, Stripe, and local-capture outbound webhooks shipped; remote webhook delivery and production provider evidence remain |
| Alpha 10 | Recovery, operational tooling, deterministic data, and safe remote access | Partly shipped: `backup`, `restore`, `console`, Queue/DLQ and Workflow operations, seed scenarios, and `dev --fresh` shipped; deployed recovery evidence remains |
| Alpha 11 | Resource evolution and framework upgrade lifecycle | Partly shipped: `resource add-field`, `upgrade` (including `source-*`), and `architecture check` shipped; generated typed API clients and codemods remain |
| Alpha 12 | Optional admin, enforcement, full-system hardening, and beta preparation | Admin and access control shipped (see [ADMIN_SPEC.md](ADMIN_SPEC.md)); an alpha.90 admin canary passed hosted anonymous-access checks, but authenticated admin/support-view staging and beta hardening remain |
| Beta candidate | Published prerelease with an explicit evidence ledger; production and several hosted paths remain open | `trestlejs` and `create-trestlejs` beta.3 shipped on npm `next` with the existing-project admin enablement path and SetupPlan self-validation. Hosted admin proof is partial and comes from an older alpha.90 canary; see the [testing ledger](BETA_CANDIDATE_TESTING_LEDGER.md) |
| Beta completion | Stable conventions, migration compatibility, upgrade rehearsals, and production evidence from real applications | Planned |
| v1 | Supported end-to-end product-development and deployment path with documented compatibility guarantees | Planned |

## Today’s push: Alpha 7/8 → Beta candidate

The goal for today is to produce a credible beta candidate from a clean
`create-trestlejs` project. This is an execution plan, not a promise that
beta is complete before the evidence gates pass.

### Must-pass gates

- [x] **Clean-project canary:** create a fresh project from the checked-in
  package, install with the frozen lockfile, and run the complete generated
  typecheck, test, build, and Worker dry-run suite. The published Alpha 77
  [hosted release run](https://github.com/gregmushen/trestlejs/actions/runs/35913795347)
  passed this gate with PostgreSQL and Chromium.
- [x] **Local product path:** boot PostgreSQL, create an account, complete
  local email verification through captured email, create/select an
  organization, and exercise generated CRUD across two tenants. The published
  Alpha 76 release canary completed this with PostgreSQL and Chromium in
  [its hosted release run](https://github.com/gregmushen/trestlejs/actions/runs/35911785778).
- [ ] **Deployment path:** configure GitHub, Cloudflare, Neon, Resend, and
  Stripe test-mode environments with encrypted secrets; deploy an isolated
  preview and staging from GitHub Actions.
- [ ] **Staging system gate:** run browser/API tests against the deployed
  Astro site, React application, Worker, authentication, email, billing,
  resource CRUD, tenant switching, forced RLS, CORS, deep links, health, and
  invalid webhook signatures. Confirm the target Workers account has a CPU
  allowance suitable for the generated auth and database workload, then run
  repeated and concurrent requests without `exceededCpu` outcomes.
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
  adds bounded scheduled cleanup for incomplete R2 uploads. Alpha 61 makes
  requested deletion fail closed and durably retries failed R2 cleanup;
  Alpha 63 audits ready PostgreSQL references against R2 metadata in bounded,
  tenant-scoped pages. Alpha 64 adds the inverse bounded, read-only R2 orphan
  audit. Alpha 65 adds provider-backed verification of every restored ready
  reference. Alpha 67 adds opt-in ready-object retention with immediate read
  denial, bounded tenant-scoped R2 cleanup, and durable retry on failed deletes.
- [ ] Align Drizzle snapshots and make migration generation idempotent.
- [ ] Add protected Resend/Stripe test-mode integration tests and staging
  recipient protection.
- [ ] Add operational checks for deployment identity, bindings, migration
  state, runtime role, queue/DLQ state, and provider mode.

### Full beta completion criteria

We can call the result **production-validated beta** only when a clean generated
project can complete the following without manual source repair. An earlier
beta candidate may be published with an explicit [testing ledger](BETA_CANDIDATE_TESTING_LEDGER.md)
that labels unverified paths and does not imply production readiness:

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

Alpha 6 makes `trestle generate resource <Name>` a complete,
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
Known issue, deferred by product decision: live Cloudflare testing found that
Workers cannot use the current IP-pinned socket transport for ordinary HTTPS
destinations on port 443. DNS prechecks followed by Workers `fetch` would not
preserve the approved-address guarantee. Keep remote native mode fail-closed
until an egress design is selected and verified on Cloudflare.
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
A committed domain event remains authoritative; webhook failure must never
undo its domain mutation.
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
Alpha 57 also shortens the local PostgreSQL socket idle period after the hosted
generated system test exposed connection exhaustion. Worker request I/O remains
isolated: database sockets are never cached across Cloudflare requests.
The Alpha 57 tag was not published to npm: the publish workflow stopped at an
intermittent generated-browser tenant-switch test before package upload. Alpha
58 makes that test wait for the actual organization-change response and the
second tenant's distinct billing state before drilling into webhook history.
It is the next publishable release; the Alpha 57 tag is preserved as historical
evidence rather than rewritten.
Alpha 59 adds the first customer endpoint-management path: owner/admin users
can inspect the application-owned public event catalog, register an HTTPS
destination with normalized subscriptions, receive its signing secret exactly
once, and activate or disable it when the configured delivery capability is
ready. Endpoint, subscriptions, and encrypted secret are committed atomically
under tenant RLS; activation requires both a current secret and a subscription.
Generated PostgreSQL and browser tests cover registration, rejected destinations,
unknown/duplicate subscriptions, tenant isolation, one-time display, and
redaction. New endpoints are disabled by default. Editing subscriptions,
rotation with step-up, replay, durable audit, pagination, admin controls, live Cloudflare
delivery proof, and Svix remain subsequent work.
Alpha 60 adds tenant-scoped subscription inspection and replacement for
existing endpoints. The customer screen can change selected public event
versions without exposing internal event definitions. Replacement validates
current catalog and entitlement availability, rejects duplicates and empty
sets, and commits the full selection atomically under endpoint locking and
forced RLS. PostgreSQL and browser tests cover cross-tenant denial, removed
events, rejected edits, and the customer edit flow. Endpoint URL/name editing,
secret rotation UI, replay, durable audit, and pagination remain.
Alpha 61 hardens tenant-owned R2 artifact deletion. The PostgreSQL metadata
row becomes unreadable before the external delete starts; a failed R2 delete
or metadata finalization leaves a durable cleanup candidate for the existing
bounded scheduled sweep. PostgreSQL and integration tests cover cross-tenant
denial, fail-closed reads, retry, and identifier non-reuse. This is not a
ready-object retention policy or a full bucket-to-metadata reconciliation job.
Alpha 62 removes false-positive restore verification. An isolated restore now
counts ready artifact references; zero references pass the R2-reference gate,
while any unverified reference makes the overall result fail, even when the
database checks pass. Missing two-tenant adversarial RLS evidence also fails.
The CLI independently requires every expected check, successful isolated
cleanup, and the declared RTO before reporting a verified restore. This does
not yet supply provider-backed R2 reference verification or a retention policy.
Alpha 63 adds a bounded scheduled R2 reference audit. It pages organizations
through the maintenance role, reloads each ready artifact under tenant RLS,
and uses metadata-only R2 HEAD checks to detect missing objects, size/type
drift, and owner/ID metadata mismatches. Confirmed issues fail the scheduled
run and emit safe semantic logs; no objects or metadata are deleted. This is
not orphan-object detection, a ready-object retention policy, or proof that
an isolated database restore can access the correct provider bucket.
Alpha 64 adds the inverse R2-to-PostgreSQL audit. It scans one bounded R2 page
per tenant using opaque provider cursors, checks each old physical key under
forced tenant RLS (including pending/cleaning reservations but not retired
rows), and rechecks
unreferenced objects before reporting them. It logs only a key fingerprint and
tenant ID, never the raw storage key or object body. Findings fail the scheduled
run; the audit never deletes an object. Ready-object retention and provider
reachability during restore remain unverified.
Alpha 65 makes isolated restore verification use the configured production R2
bucket through a separate read-only S3 credential. It pages every ready
PostgreSQL artifact reference from the restored branch and performs metadata-
only HEAD checks for existence, size, content type, and tenant/artifact identity.
Provider errors, missing credentials, missing objects, drift, or incomplete
pagination fail the recovery evidence without leaking keys. A protected
production restore drill and a ready-object retention policy remain necessary
before claiming the storage recovery gate is met.
Alpha 66 makes preview credential diagnostics distinguish a readable but
incomplete encrypted file from an unreadable file. This does not satisfy
missing provider credentials or the deployment gate.
Alpha 67 adds an explicit `ARTIFACT_READY_RETENTION_DAYS` policy for R2-backed
artifacts. A bounded scheduled sweep claims expired ready rows under tenant RLS,
then deletes exact R2 keys; failures remain inaccessible and retry through the
existing cleanup path. No ready objects are deleted unless an application
explicitly configures a period. Hosted R2 retention remains unverified.
Alpha 68 prevents `trestle upgrade apply` from stamping an older application
template as current merely because its CLI package was updated. The planner
requires a reviewed application-source migration and a matching pnpm lockfile;
it never edits `package.json` without updating that lockfile. The existing
canary still records Alpha 37 application source, so its upgrade remains a
manual-review item rather than a false success. Automated source migrations
and adjacent-version rehearsals remain beta work.
Alpha 69 records a generated-file checksum baseline in new projects and ships
a bundled target-template inventory. `trestle upgrade diff` is read-only and
distinguishes matching files, untouched generated files, application edits,
missing paths, and unsafe symlinks. The Alpha 37 canary has no baseline, so
its 105 differing target-template paths remain unverified. Safe source apply,
migration ordering, and a reviewed canary migration remain beta work.
Alpha 70 adds `trestle upgrade source-apply --yes` for a matching-baseline
project from the immediately preceding alpha with the target CLI and lockfile
installed. It refuses edited, missing, unverified, symlinked, deployment,
configuration, and migration paths before writing, and only applies pristine
target-template files. It deliberately leaves the framework version marker
unchanged: source copying is not migration verification or beta certification.
The older Alpha 37 canary still requires a reviewed manual migration.
Alpha 71 fixes an upgrade rehearsal finding: pnpm reorders root
`package.json` entries when pinning the target CLI. Source apply now accepts
that manifest only when its parsed content exactly matches the rendered
target manifest, ignoring object key order; changed scripts, dependencies, or
other application semantics still require manual review.
Alpha 72 inventories files owned by the old generated template but absent
from the target template. A present retired path, whether pristine or edited,
blocks source apply for deliberate review; a path already removed is reported
without blocking. Malformed baseline paths or checksums are untrusted and
cannot direct reads outside the project. This closes a stale-source gap but
does not yet certify migrations or advance the application template marker.
Alpha 73 adds source finalization for a pristine adjacent-alpha project. It
requires target parity, no present retired paths, an exact CLI/lockfile pin,
and a passing project `pnpm check`; it rechecks parity afterward, then advances
the source marker and checksum baseline. `upgrade apply` keeps that baseline
aligned when it records the final managed metadata. This certifies local source
parity only, not hosted deployment, external providers, or recovery readiness.
The separately versioned `trestlejs-canary` application was then reconciled
from its Alpha 37 source to Alpha 73 in a reviewed migration (canary PR #2,
merged 2026-09-23). Its original journaled Article migration chain, encrypted
credentials, deployment workflows, and enabled Queue/R2/Workflow capabilities
were preserved. The old and target migration chains were replayed into isolated
PostgreSQL databases and compared; the canary-specific Article schema was the
only physical-schema difference. The migrated canary passed local checks,
Drizzle no-drift generation, database/Worker/billing suites, Chromium CRUD and
two-tenant isolation, and post-merge hosted CI. Its generation baseline remains
untrusted because application-owned changes cannot be retroactively labeled
pristine. The preview deployment remains blocked by incomplete encrypted
credentials, Resend sender/redirect configuration, and Stripe test-mode
configuration; this migration is not deployed-provider evidence or beta
certification.
Alpha 74 adds `trestle upgrade migrations`, a read-only comparison of the
application and bundled target PostgreSQL journals and SQL checksums. It
reports common history, append-only tails, same-index divergences, malformed
or symlinked journal files, missing SQL, and unjournaled SQL. A divergent
canary correctly reports eight shared entries followed by different index-8
migrations. The command does not rewrite history or claim physical-schema
equivalence; an isolated replay and schema review remain required.
Alpha 75 makes the packed release canary assert exact migration history
before resource generation. Its browser site uses a per-run internal test
port after an Alpha 74 publication attempt exposed an intermittent fixed-port
collision on the hosted runner. Generated applications retain their documented
local Astro port; this only hardens the release proof. The first Alpha 74
publish attempt failed at site startup, and the unchanged-tag retry passed.
Alpha 76 aligns protected staging provider verification with Trestle's
encrypted credentials: the workflow checks and decrypts the declared staging
store using its environment master key, while integration tests read the
canonical staging Worker variables and reject unsafe Resend/Stripe modes.
Deterministic generated-project tests cover configuration selection. This does
not replace live provider verification or close the canary preview's missing
provider configuration gates.
Alpha 77 adds a frozen-lockfile reinstall to the packed clean-project release
canary and asserts that it does not rewrite the lockfile. This closes a gap
between the first install, which necessarily resolves a new project's lock,
and the subsequent reproducible install used in CI. The hosted Alpha 77
release run passed this check alongside typecheck, tests, build, browser, and
Worker dry-run checks. The clean-project and local-product gates are complete;
deployed provider, staging, promotion, and asynchronous provider-backed gates
remain open.
Alpha 78 makes the deployed HTTP smoke compare the application's declared
Queue, R2, and Workflow capabilities with the Worker's operational binding
report. Missing and unexpected bindings fail closed; disabled capabilities
must report as unavailable. This verifies deployment wiring once preview or
staging reaches the smoke step, not actual Queue delivery, Workflow execution,
or R2 persistence. The asynchronous provider-backed gate remains open.
Alpha 79 follows the deployed HTTP smoke with read-only Cloudflare API checks
for the exact Queue, dead-letter Queue, and R2 bucket identities derived from
the target Worker name. Missing or mismatched resources fail the preview,
staging, or production deployment before evidence is published. Disabled
capabilities make no provider requests. This still does not prove that an
application event was delivered or an artifact was persisted remotely.
Alpha 80 adds a tenant-bound, catalog-validated `execution.events.statement`
for composing an outbox insert with an application mutation in one PostgreSQL
transaction. The generated publisher has no direct-send convenience path;
transaction rollback removes both records, and retry keys are tenant-scoped.
It is a foundation for application-owned event emission, not deployed
webhook-delivery proof or automatic events for every generated resource.
Alpha 81 makes new generated resource-create mutations use that publisher in
the same PostgreSQL transaction as the resource insert. The generator
registers a private, schema-validated application event and makes its Queue
consumer parse through the same catalog. Generated browser coverage verifies
the committed event's tenant, resource, payload, correlation, and stable
tenant-scoped retry key after an HTTP create. Update/delete events, deployed
Queue execution, and customer-visible webhook projections remain separate
work.
Alpha 82 extends that transactional boundary to generated resource updates
and deletes. New resources receive a persisted revision: only an actual
change increments it and emits an update event, so retrying the same update
does not duplicate the event. A repeated delete likewise emits nothing.
Generated PostgreSQL tests inject event failure and prove both mutations
roll back; system and Chromium tests inspect the committed, tenant-scoped
outbox records. Existing application-owned resources are not silently
rewritten. Deployed Queue execution and customer-visible webhook projections
remain open.
Alpha 83 adds an explicit public-webhook opt-in for newly generated resource
events through `--webhook-event` or SetupPlan `webhookEvents`. Each selected
created, updated, or deleted event gets a separately versioned, schema-checked
public projection containing only resource identity and, where applicable,
revision. Unselected events stay private. The generated application tests the
public catalog and its projection fixtures. Existing application-owned
resource catalogs are not silently rewritten. This is a contract and local
projection path, not proof of deployed endpoint delivery.
Alpha 84 exercises that path from a clean generated application: an owner
registers and activates a local endpoint, creates an opted-in Article, and
the committed event traverses Queue and Workflow processing into one signed
local attempt without network delivery. The test verifies customer inspection
redaction, duplicate processing, update projection idempotency, and that an
unselected delete event remains private. This is deterministic local proof;
deployed Cloudflare delivery still requires provider-backed evidence.
Alpha 85 corrects platform webhook replay semantics: an audited replay creates
a new delivery execution linked to the retained immutable message and original
delivery, leaving the original terminal state and attempt history unchanged.
Concurrent requests share one active replay; expired payloads, inactive
endpoints, already-successful replays, and cross-tenant identities fail closed. PostgreSQL grants deny
direct platform writes to tenant deliveries, while a narrowly granted replay
function performs the validated insert. The customer inspection model exposes
the replay link, and platform operations show when a replay is already queued.
This is a local and database-backed recovery contract, not deployed native
egress proof or Svix provider reconciliation.
Alpha 86 adds customer-initiated replay of a failed outbound webhook under a
distinct organization permission. The Worker checks session authority, request
origin, environment, and delivery mode; forced tenant RLS and a PostgreSQL
transaction validate the retained message and active endpoint, serialize
concurrent requests, queue one linked delivery, and record an audit event.
The original terminal delivery and attempts remain unchanged. Customer
inspection shows replay state and supports inspecting the new attempt ID;
the application exposes a replay action without revealing payloads or secrets.
Local signed-delivery and database tests are required; remote provider delivery
and the configured Resend/Stripe preview gate remain beta work.
Alpha 87 extends native webhook claim backpressure from one endpoint to the
whole organization. A tenant-scoped PostgreSQL advisory lock serializes claims
across different endpoints before counting live leases; the default ceiling is
16 concurrent attempts per tenant alongside the existing four-per-endpoint
limit. Capacity denial does not mutate a delivery or consume an attempt, and
other tenants remain independent. PostgreSQL contention tests verify the
limit, isolation, and reuse of capacity after settlement. Global worker
concurrency, throughput quotas, and deployed Cloudflare delivery evidence
remain separate beta work.
Alpha 88 runtime probing found a concrete Cloudflare compatibility blocker:
Workers DNS resolves public webhook destinations, but direct IP-pinned TLS
connections to ordinary HTTPS services on port 443 are rejected. The
unsupported `ALPNProtocols` option is removed, and remote Doctor now fails
closed when native delivery is enabled. See
[WEBHOOK_EGRESS_RUNTIME.md](WEBHOOK_EGRESS_RUNTIME.md). The remote transport
decision and deployed successful delivery are deferred known issues, not
completed Alpha 88 claims. The beta candidate can proceed with optional
remote native delivery disabled and this limitation disclosed.
Alpha 89 repairs the Stripe subscription handoff and webhook transaction
boundary. Checkout now copies organization and plan metadata onto the
underlying Subscription, not only the Session. Signed subscription events
fail closed if that identity is missing or the plan is unknown. A durable
provider-event receipt is locked for duplicate suppression; subscription and
entitlement projections commit with its processed status in one PostgreSQL
transaction. Failed projections retain a retryable receipt without partial
entitlements. Period dates and end-of-period cancellation are projected from
the Subscription. Generated PostgreSQL and signed Worker-route tests cover
retries, concurrency, duplicate events, and the rule that Checkout completion
alone does not grant paid access. Live Stripe test-mode evidence, event-order
reconciliation, and billing event/outbox publication remain beta work.
Alpha 90 adds an authenticated, provider-backed staging browser gate. The
generated staging deployment now creates a unique test account, verifies its
email through a safely redirected Resend message, signs in, creates two
organizations, checks the active session tenant and organization-scoped billing
UI, and rejects a non-member tenant ID. Preview and
production retain read-only browser checks; neither creates test accounts.
Resend list/read permissions and a configured staging redirect are required.
This is a generated, deterministic gate, not yet live staging evidence: the
isolated canary still lacks its actual Resend/Stripe environment values.
Tenant resource CRUD, forced RLS, deployed billing Checkout/webhooks, and
provider delivery evidence remain open beta gates.
Alpha 91 treats signed Stripe subscription webhooks as change notifications,
not ordered state snapshots. Test/live Workers fetch the current Subscription
from Stripe, then commit the local projection only if their durable
per-subscription reconciliation generation is still current. A slower lookup
is recorded as superseded instead of re-granting stale entitlements; provider
failures retain redacted, retryable receipts. Generated PostgreSQL and signed
Worker-route tests cover concurrency, stale events, metadata recovery, and
provider outages. Local mode remains account-free. Live Stripe test-mode
Checkout/webhook evidence, provider-subscription ownership transitions,
billing domain event/outbox publication, and broader deployed billing tests
remain beta work.
Alpha 92 binds each provider subscription identity to one organization in an
immutable application-role table, backfills existing projections at migration,
and fails migration on ambiguous historical ownership. Concurrent events
cannot transfer a subscription to a different tenant or replace an active
subscription with another identity. A canceled or incomplete subscription may
be replaced; subsequent events for the old identity are acknowledged as
superseded without changing the new projection. PostgreSQL tests cover tenant
transfer, active replacement, canceled replacement, late old events, and
concurrent claims. Live provider and billing outbox evidence remain open.
The generated release canary also selects isolated browser-test ports, so
testing a clean project does not interrupt a developer's running Trestle app.
Alpha 93 publishes normalized, internal subscription lifecycle events through
the transactional outbox. A verified projection, entitlements, outbox message,
and processed provider receipt commit together. Duplicate and superseded
webhooks do not publish twice; failed event validation rolls the projection
back for safe retry. Billing payloads omit provider customer/subscription IDs,
and internal billing events are not customer webhook products. PostgreSQL and
signed Worker tests cover atomicity, deduplication, redaction, and correlation.
Alpha 94 resolves Checkout and invoice notifications through the immutable
local subscription-owner binding before publishing private, provider-neutral
domain events. An earlier notification receives a retryable response rather
than being acknowledged without an event. Paid entitlements still come only
from the subscription projection, never a Checkout success or invoice event.
Signed Worker and PostgreSQL tests cover event ordering, tenant isolation,
duplicate delivery, failed payloads, and transactional outbox publication.
Notifications acknowledged by pre-94 installations without domain events need
explicit provider replay or reconciliation; this release cannot reconstruct
those historical events from a receipt alone. Live Stripe test-mode and
deployed Resend evidence remain beta gates.
Alpha 95 hardens Stripe deployment readiness. `trestle doctor` and
`trestle payments stripe doctor` now reject malformed or incomplete plan-price
maps, wrong test/live publishable keys, and unsafe return URLs; the Worker
operational health endpoint applies the same fail-closed criteria. The CLI
correctly decodes JSON-valued Wrangler strings instead of truncating escaped
quotes. Tests cover every declared plan, duplicate or unknown mappings,
environment separation, and redacted diagnostics. This makes readiness
claims more trustworthy but is not live Stripe integration evidence.
Alpha 96 accepts properly scoped Stripe restricted server keys (`rk_test_` /
`rk_live_`) in the corresponding environment alongside full secret keys.
Protected staging verification probes the prices, products, subscriptions,
and Checkout read permissions used by the billing adapter instead of assuming
restricted keys can read the Stripe account endpoint. The permission probes
are read-only; successful reads do not prove write privileges for Checkout,
catalog synchronization, or webhook endpoint management. Those remain live
staging acceptance gates.
Alpha 97 keeps the deployment contract compatible with applications that
explicitly disable the optional platform admin. Such projects may retain an
older staging/production workflow with no admin steps; admin-enabled projects
still require fully capability-guarded admin deployment, verification, and
smoke tests. An unguarded admin step fails validation even when admin is
disabled. This removes an upgrade-only failure found in the live canary.
Alpha 98 extends protected provider verification beyond Stripe read permissions:
it creates a test-mode Checkout session through the application-owned
`StripeBillingAdapter` and repeats the same logical request to verify Stripe
idempotency. The authorized canary restricted key passed this test against a
declared test-mode price. This proves Checkout creation with that key and
price, not a completed payment, signed webhook delivery, or local entitlement
projection. Those deployed end-to-end gates remain open.
Alpha 99 closes a preview email safety gap. Resend delivery in both preview
and staging now requires a configured recipient redirect and strips cc/bcc
before immediate or scheduled delivery; preview subjects identify the
original recipient without forwarding to it. Local mode cannot opt into
direct Resend delivery, and only production can send provider email without
redirection. Factory-level tests and CI contract checks protect these rules.
The canary preview must pick up this source fix before Resend is enabled.
Alpha 100 adds a protected, real Resend acceptance gate. The staging email
service sends a harmless message addressed to a unique `example.test` identity,
retries with the same idempotency key, and reads the provider receipt to assert
that only the configured staging mailbox was addressed. The authorized canary
Resend key passed this test. Provider acceptance and recipient metadata do not
prove inbox delivery or webhook processing; deployed sign-up, verification,
and delivery-event evidence remain beta gates.
Alpha 101 separates Resend webhook verification from database persistence.
Invalid signatures and payloads still return HTTP 400, but a database outage
after a valid webhook returns HTTP 503 so the provider can redeliver it. The
generated Worker tests rejection, first receipt, duplicate receipt, and
recovery after a transient persistence failure. Live webhook registration and
deployed delivery-event evidence remain open.
Alpha 102 aligns `trestle email status|doctor` and top-level `trestle doctor`
with preview/staging delivery safety: readiness requires Resend mode, a valid
recipient redirect, a sender address, and credential shape; status reports the
configured adapter rather than inferring it from the environment. This does
not prove that the webhook endpoint is registered in Resend or that the
configured signing secret belongs to that endpoint.
The generated PostgreSQL acceptance gate runs the local product path after
other Worker suites and drains bounded outbox batches; it no longer assumes a
new event is among the first ten pending messages left by other tests.
Alpha 103 exercises the Resend signature boundary against a real generated
PostgreSQL schema, without provider credentials: a correctly signed raw-body
event persists once, signed duplicates acknowledge idempotently, tampered
bodies and expired signatures are rejected, and a transient database outage
returns a retryable response before the same event succeeds on redelivery.
This is stronger local evidence, not live provider delivery or endpoint
registration.
Alpha 104 adds a CI and release gate that creates a project with the published
version two alphas behind the candidate and upgrades it using the next
published CLI. It checks the trusted source baseline and migration history,
applies pristine source, runs the generated project's local checks, finalizes
the source version, validates the result, and proves application-owned content
survives. For Alpha 104 this exercises the real Alpha 102 → 103 path. This
does not yet prove database migration on live application data or deployed
adjacent-version compatibility; those beta gates remain open.
Alpha 105 extends the published adjacent-version rehearsal to PostgreSQL.
It migrates the older generated schema, seeds two tenant-owned records,
upgrades source and migrations with the next published CLI, verifies both
records and forced RLS survive, and runs the generated RLS integration suite
before source finalization. The test uses a fresh disposable database and
does not claim deployed Neon migration or production data compatibility.
Alpha 106 makes the human `trestle doctor` output name each safe Resend and
Stripe configuration issue (for example an invalid webhook-secret shape or
missing test publishable key). It keeps arbitrary exception evidence out of
human output, so deployment failures are actionable without printing secret
values. This does not relax the provider-readiness gate.
Alpha 107 corrects the generated GitHub Deployment recorder: pull-request
previews are transient, staging is persistent and non-production, and
production is persistent and production-classified. Status descriptions now
name the actual environment; cleanup can deactivate only pull-request
previews. Request-level tests verify the records and guardrails, but this is
not evidence that a hosted staging or production deployment has passed.
Alpha 108 extends the generated staging browser gate to exercise deployed
Article CRUD and cross-tenant read/write denial whenever the application
declares that resource. The local PostgreSQL/browser canary covers the same
behavior before release; hosted staging evidence remains open until provider
configuration permits the test to run against a real deployment. It also
records hash-verified generated package source so a future adjacent upgrade
can distinguish pnpm's dependency-version edit from application changes even
when pnpm reformats package.json. Alpha 108 recognizes older pristine
byte-preserving baselines too; the published Alpha 106 → 107 rehearsal uses a
strictly reviewed package-script transition because Alpha 107's CLI cannot
apply that specific change automatically.
Alpha 109 adds a conditional deployed R2 artifact smoke to staging: a signed
URL must return the uploaded bytes, a forged tenant and cross-tenant access
must fail, and deletion must revoke the URL. Existing local R2/system tests
cover these mechanics before release; live provider evidence remains open
until staging deploys and runs the browser gate.
Alpha 110 adds a conditional deployed asynchronous smoke when Article and
Queues are declared. The staging browser creates an Article, then uses the
restricted runtime database role to verify that its committed outbox event
was dispatched and its Queue/Workflow consumer receipt completed. This checks
the real hosted path without exposing an internal status endpoint. The
deterministic Workflow retry and duplicate-delivery challenge, as well as
the first live staging run, remain open beta evidence.
Alpha 111 gives that staging browser test a seven-and-a-half-minute timeout.
The default 30-second Playwright limit was shorter than either the existing
90-second Resend inspection window or the new 180-second Queue completion
window, so a healthy deployed path could never complete reliably. This fixes
the test budget; it is not evidence that staging has run.
Its published-adjacent upgrade rehearsal also explicitly reviews the protected
Alpha 109 → 110 deployment workflow: it requires an unchanged recorded
baseline and the exact three-line staging transition before allowing the
remaining source upgrade. Real application workflows still require review.
Alpha 112 adds PostgreSQL-backed retry evidence for the generated
`TrestleWorkflow`: a transient handler failure releases the inbox claim, a
second execution completes it, and replay does not run the handler again.
This exercises the real generated Workflow handler locally; a live Cloudflare
Workflow retry remains part of the open staging evidence gate.
Alpha 113 adds a read-only Resend/Stripe credential preflight to generated
preview, staging, and production deployment workflows before resource
provisioning. It checks active API access and test/live key separation without
printing credentials. The canary's original encrypted preview/staging Resend
and Stripe keys were rejected by their providers; they have since been
replaced and the test Stripe key can create a test Checkout session. The
canary now has a matching `pk_test_` publishable key in preview and staging.
Alpha 114 makes those deployment preflights also check that the configured
Resend sender domain is verified in the selected account. Its staging browser
test probes the generated Article table through the restricted runtime database
role, requiring forced PostgreSQL RLS and verifying that switching tenant
context hides another organization's row. These checks prepare the deployed
beta gate; they cannot replace its first successful staging run.
The published Alpha 112 → 113 upgrade rehearsal narrowly reviews the two
protected deployment workflow additions against their recorded baseline;
application-owned workflows still require review during real upgrades.
Alpha 115 extends the deployed staging browser gate through the authenticated
billing route: it creates a test-mode Stripe Checkout session, retries the
same logical request without creating a second session, verifies a forged
tenant cannot start Checkout, and confirms that merely creating Checkout does
not grant a subscription. Billing commands now reject malformed or
client-supplied tenant fields before reaching the provider. Its preview
secret projection also targets the exact rendered isolated Worker config;
the first provider-backed preview exposed that Wrangler otherwise appended
`-preview` to secret uploads while deploying the unsuffixed Worker. This is not a
completed Stripe payment, signed webhook, or entitlement activation; those
remain part of the deployed beta evidence gate.
Alpha 116 makes the generated Queue/R2 preview renderer support an explicit
`--without-cron` escape hatch when an existing Cloudflare free account has
exhausted its five cron slots. It preserves the other bindings but cannot test
scheduled dispatch; staging and production still require cron. The canary's
first fully credentialed preview exposed this quota after its Worker secrets
and database were configured, so its preview opts out while the cron-enabled
production path remains an unverified beta gate. The preview browser gate now
requires a real redirected verification email, sign-in, tenant-safe test-mode
Stripe Checkout, idempotent retry, and no subscription before a verified
webhook. A green site-handoff check alone is not sufficient evidence.
That deeper gate also caught a preview auth URL mistake: Better Auth was
generating email links on the static Pages app domain rather than the Worker
API domain. Preview now binds `BETTER_AUTH_URL` to the API origin and keeps the
app origin in `WEB_ORIGIN`.
The published Alpha 114 → 115 upgrade rehearsal narrowly reviews the three
preview secret-target changes against the recorded Alpha 114 workflow hash;
unrelated protected workflow edits remain manual-review gates.
Alpha 117 routes generated preview, staging, and production application API
requests through a same-origin Pages Function and a bound API Worker. This
avoids third-party session-cookie loss between `pages.dev` and `workers.dev`;
the browser sign-in transition also performs a full navigation so the new
session is read before dashboard guards run. The isolated canary preview
[passed its hosted deployment and Chromium product gate](https://github.com/gregmushen/trestlejs-canary/actions/runs/36015119039):
redirected verification email, sign-in, two-organization switching,
test-mode Stripe Checkout, idempotent retry, and cross-tenant denial. This is
preview evidence, not a completed staging run, signed Stripe webhook, or
cron-enabled async-delivery proof; those beta gates remain open.
Alpha 118 makes Stripe webhook signature verification asynchronous with the
Web Crypto provider required by Cloudflare Workers. The earlier synchronous
path rejected even a correctly signed request in the deployed Worker. The
generated preview browser gate now completes a Stripe test-card Checkout and
requires a provider-signed webhook to activate the local Pro subscription and
`workflows.advanced` entitlement. This payment test is confined to preview;
production smoke does not submit a test card. The isolated canary
[passed hosted preview with both browser tests](https://github.com/gregmushen/trestlejs-canary/actions/runs/36022657568)
after its preview-only Stripe webhook endpoint and encrypted signing secret
were aligned. Its prior test endpoint was disabled, not deleted. This is
provider-backed preview evidence; the separate mainline subscription
reconciliation path, a protected staging run, and live production promotion
remain beta gates. The published Alpha 116 → 117 adjacent upgrade rehearsal
also narrowly reviews the protected preview and deployment workflow changes
for same-origin Pages routing against recorded baseline hashes.
Alpha 119 adds reviewed Stripe webhook endpoint setup. An existing `whsec_`
value is no longer presented as proof of a remote signing-secret match:
Stripe exposes the secret at endpoint creation, not later inspection. The
CLI plans the exact URL and mode without mutation; apply requires a separate
management key on standard input, a stable retry ID, and an explicit old
endpoint ID for rotation. It stores the new secret in encrypted credentials
before disabling only that old endpoint. The canary's preview endpoint was
rotated through this command and [passed its hosted Checkout and signed-webhook
browser gate](https://github.com/gregmushen/trestlejs-canary/actions/runs/36027059455).
The first manual staging run passed credentials, tests, and migration but
[failed at Cloudflare cron provisioning](https://github.com/gregmushen/trestlejs-canary/actions/runs/36025564283):
all five Free-plan cron slots on that account belong to active Tidal House
Workers. No unrelated schedule was removed, and production was skipped. A
paid-plan capacity change or an explicitly selected schedule retirement is
required before a complete cron-enabled staging gate can pass.
Alpha 120 adds a read-only account cron-capacity gate to the generated staging
and production deployment workflows. It compares the rendered Worker's desired
schedule with all account schedules before provisioning or migration. Against
the canary's real Cloudflare account, it detected 5/5 used triggers and
stopped before remote changes. This prevents another partial staging update,
but does not satisfy the blocked cron-enabled staging or beta gate.
Alpha 121 makes `trestle logs` a safe projection of Cloudflare's raw tail:
only validated Trestle semantic events, timestamp, level, UUID correlation ID,
status, and duration reach the terminal. Request metadata, exception text,
arbitrary console output, and unknown fields are withheld. The protected
canary provider integration suite also passed locally against the supplied
Stripe test and Resend credentials, including redirected email and idempotent
test Checkout. This is provider evidence, not a protected GitHub Actions run
or the missing cron-enabled staging gate. Full logging-spec conformance,
including exact-value secret redaction and cross-boundary context, remains open.
Alpha 122 hardens the generated structured logger with registered runtime-secret
redaction, circular/depth/width/size limits, safe Error and BigInt handling,
immutable parent context, child loggers, a debug level, and a non-throwing sink.
HTTP and authenticated execution loggers register the declared Worker runtime
secrets. This does not yet guarantee secret registration for every background
entry point or correlation propagation across all asynchronous boundaries.
Alpha 123 extends runtime-secret registration to webhook and billing handlers,
cron maintenance, native webhook queues, Workflows, the platform admin, and
the local console. Declared admin and platform database credentials join the
redaction registry. This closes the generated logger-entry-point gap; further
cross-boundary correlation and provider-internal diagnostics still need review.
Alpha 124 carries validated event IDs, names, correlation IDs, and causation
IDs into semantic Queue acknowledgment/retry logs. Invalid Queue bodies are
reported without raw content or untrusted identifiers; diagnostic observers
receive metadata only and cannot change delivery settlement. This narrows the
remaining cross-boundary observability gap but does not replace deployed
Queue/Workflow evidence.
Alpha 125 makes the safe remote log tail show debug-level semantic events and
UUID-shaped causation IDs alongside correlation IDs. Free-form IDs, raw
requests, payloads, and unknown Cloudflare trace fields remain withheld.
Alpha 126 keeps ephemeral preview Workers free of cron triggers by default,
while staging and production retain scheduled delivery. The generated preview
workflow states this explicitly and CI rejects a preview workflow that drops
the guard. This removes unnecessary account-wide cron consumption from new
previews; it does not resolve the existing Free-plan capacity needed for the
cron-enabled staging gate.
On 2026-09-24, the user authorized a temporary Tidal House cron pause to free
one slot for Trestle staging. The `tidalhouse-ap-worker` receipt-matching sweep
(`7 16 * * *` UTC) was removed through the Cloudflare schedule API, with its
Worker and manual sweep endpoint preserved; account usage was verified at 4/5.
Restore that exact schedule after the canary no longer requires the slot, and
verify the account total and AP schedule afterward. A future Tidal House Worker
deploy may restore it sooner, so recheck capacity before Trestle promotion.
Alpha 127 makes the generated disabled-Queue and disabled-R2 CLI tests use
isolated false-capability fixtures. They now pass even when an application
enables both capabilities, as the beta canary does; no production Cloudflare
behavior changes. A deployed staging run also exposed a signed-artifact URL
bug: Pages forwards the access request under the app hostname, but its static
route cannot serve the Worker-only download path. The Worker now signs an
absolute URL using its configured direct API origin, with a regression test
that simulates the Pages-forwarded hostname. Its published-adjacent upgrade rehearsal also narrowly
reviews the Alpha 125 → 126 protected preview workflow change against the
recorded source hash and exact target content rather than bypassing workflow
review.
Alpha 128 binds preview Stripe Checkout's return URL to that pull request's
isolated Pages app at Worker deployment time. The generated CI contract now
rejects a preview workflow missing the binding. The protected Alpha 127 → 128
workflow edit is narrowly encoded for the next published-adjacent rehearsal;
Alpha 128's rehearsal covers the already-published Alpha 126 → 127 pair.
Alpha 129 tolerates Stripe Checkout's card-only presentation as well as its
explicit Card selector in the deployed preview browser gate. The Alpha 127
canary's staging deployment and two deployed browser tests passed after a new
isolated Neon database was created for its divergent migration history; the
previous staging database was retained. Preview PR 10 has a separately
configured signed Stripe test webhook, but automatic per-preview endpoint
provisioning and cleanup are still required for a repeatable beta gate.
The merged canary PR exposed another preview lifecycle gap: Cloudflare refuses
to delete a Worker while it consumes a Queue, and refuses to delete the Queue
while the Worker still binds it. Alpha 130 makes generated preview cleanup
detach the exact preview Queue consumer and Worker binding before deleting the
Worker, then removes its Queues. PR 10's leftover Worker and Queues were
removed after verifying exact identities, and its isolated Stripe test webhook
endpoint was disabled. Automatic Stripe endpoint lifecycle remains open.
The canary main-branch staging deployment completed its provider preflight,
migrations, Worker/Pages rollout, and smoke checks, but its first browser gate
lost the active organization after navigation. A rerun reached the final R2
checks and then received HTTP 500 while switching organizations. The earlier
manual staging run passed on the same source commit, so deployed browser
reliability is an unresolved beta gate rather than a passed production signal.
On 2026-09-24, a cache-disabled Hyperdrive configuration was created for the
canary staging Worker's restricted Neon runtime role, using Neon's direct
(non-pooler) endpoint and a five-connection origin limit. An isolated remote
Worker probe confirmed that explicit transaction-local `SET ROLE trestle_app`
and `app.organization_id` activate RLS, and that the login role and tenant
setting reset after the transaction. Crucially, appending Trestle's existing
tenant `options` to the Hyperdrive binding connection string did **not** set
either value: the query remained under `trestle_runtime_sql`. A direct binding
swap would therefore bypass the intended tenant connection model and is not
permitted. Hyperdrive's default query cache must remain disabled for auth,
permissions, billing, and other tenant-sensitive reads.
A staging-only trial routed Better Auth's unscoped tables through Hyperdrive
while tenant-owned tables stayed on the existing Neon driver. Typechecks and
three targeted unit tests passed; one deployed product gate and three of five
repeated product gates passed, while two repeats still failed at signup and
`/api/me`. The staging Worker was rolled back to its previous version
`5d57ad67-1972-4f1e-ae71-cd7ec888688e`; the Hyperdrive configuration remains
unattached for further work. This trial is neither a reliability fix nor a
full migration. Before any cutover, implement a tenant-scoped query/transaction
adapter that sets the role and organization on every transaction, prove
cross-tenant denial against Hyperdrive, and rerun the deployed gate repeatedly
with diagnostic error classification.
Alpha 131 adds bounded, message-free error names and known SQLSTATE/transport
codes to generated HTTP failure logs, and a Better Auth error hook that reports
unexpected server failures while suppressing ordinary authentication denials.
The generated-project canary typecheck and tests cover malformed error objects
and credential-bearing messages. This is diagnostic coverage, not a claim that
the intermittent staging failure or Hyperdrive tenant migration is fixed.
Live staging tails on 2026-09-24 established the immediate failure mode:
Cloudflare terminated authenticated `/api/me`, Better Auth, and scheduled
invocations with `exceededCpu` at 10 ms. A 12-request authenticated `/api/me`
burst returned two HTTP 500 responses while successful requests used 8–33 ms
of CPU. Successful sign-up and sign-in requests used 113 ms and 95 ms,
respectively, under Cloudflare's occasional-overrun flexibility. This matches
the Workers Free per-request ceiling; the account subscription itself has not
been confirmed through the billing API. The beta deployed gate therefore needs
an explicit Workers CPU-plan check and repeatable reliability evidence. Moving
the Worker to a paid plan would be a billing decision requiring account-owner
approval; no upgrade has been made. Hyperdrive may reduce connection overhead
but does not resolve a CPU ceiling by itself: time spent waiting on Neon does
not count as Worker CPU time. The tenant-safe Hyperdrive adapter remains a
separate, uncompleted task.
Alpha 132 provisions a test-mode Stripe webhook endpoint for each isolated
pull-request preview, binds its one-time signing secret directly to that
preview Worker, replaces only endpoints at the exact same preview URL on
redeploy, and removes them on preview cleanup. This closes the missing-endpoint
configuration gap observed in canary PR 11.
The first live PR 11 run created the endpoint but placed its signing secret on
an unintended `-preview` Worker variant, so Stripe signatures were rejected
by the deployed Worker. The binding command now targets the exact PR Worker
without an environment suffix. The unintended secret-only Worker was deleted;
the intended preview Worker remained healthy. The corrected end-to-end gate
passed in [canary run 36068738916](https://github.com/gregmushen/trestlejs-canary/actions/runs/36068738916):
signed Stripe subscription events returned HTTP 202 and the browser observed
the paid entitlement. One earlier notification returned retryable HTTP 503
while ownership was not yet projected; eventual retry/reconciliation coverage
remains a separate beta hardening item.
The Alpha 132 published-adjacent rehearsal also reviews the exact Alpha 130
→ 131 auth manifest dependency on `context` against the recorded baseline,
updates the workspace lockfile, and then applies the published source upgrade.
The local two-tenant PostgreSQL rehearsal passes with forced RLS preserved.
Alpha 132 was published after a clean generated-project and adjacent-version
upgrade gate in [release run 36071652219](https://github.com/gregmushen/trestlejs/actions/runs/36071652219).
Alpha 133 makes generated preview and staging deployment browser checks
non-sending by default: the live Resend signup and billing suites require an
explicit opt-in command, while local capture remains in ordinary CI. The
generated CI validator and tests reject accidental re-enablement. This
prevents repeated deployments from consuming a shared Resend quota, but also
means an automatic green preview/staging browser check is not evidence of
live verification-email delivery, billing webhook entitlements, or forced
Article RLS. Those deployed product gates remain required before beta and
must be run deliberately with bounded provider usage.
Alpha 134 restores the isolated preview product gate without using Resend.
After migration and deployment, the preview workflow creates a unique,
email-verified credential account directly in that preview's restricted Neon
database. The deployed browser signs in through the real application, checks
tenant switching and Checkout idempotency, completes Stripe test Checkout,
and waits for webhook-projected entitlements. The account fixture never calls
an email adapter, and its code refuses staging or production. The separate
`test:preview:live-email` suite sends one verification message only when
explicitly selected; automatic preview remains non-sending. This recovers
deployed auth/billing evidence but does not certify Resend delivery, staging
Article RLS, or production readiness. The isolated canary preview browser
passed sign-in, test Checkout, and webhook-projected entitlements without
sending email in [run 36078627876](https://github.com/gregmushen/trestlejs-canary/actions/runs/36078627876),
attempt 2. Attempt 1 encountered a transient Cloudflare Pages HTTP 522; the
app, site, and API returned HTTP 200 immediately afterward. The canary's
main-branch staging deployment then passed its non-sending site browser gate
in [run 36079291608](https://github.com/gregmushen/trestlejs-canary/actions/runs/36079291608).
Production stopped before provisioning at read-only doctor checks: the
production Resend webhook secret/sender and live Stripe publishable key,
three price mappings, and return URL are not configured. This run is not
production deployment evidence.
Alpha 135 adds a dedicated, password-rotating staging fixture to restore an
automatic authenticated product gate without Resend. It reuses one verified
`example.test` account, checks tenant switching and cross-tenant denial, and
checks forced Article RLS through the restricted database role when Article
is declared. The fixture refuses non-staging environments. Live verification
email remains a separate opt-in gate and is not run by ordinary deploys. The
canary's manually triggered staging deployment passed the site and authenticated
product browser checks without email in
[run 36080565129](https://github.com/gregmushen/trestlejs-canary/actions/runs/36080565129).
The canary does not yet declare Article, so this run does not prove deployed
Article RLS; the generated local database suite and opt-in staging suite cover
it separately until an Article-enabled staging deployment is exercised.
Cloudflare Pages returned another transient HTTP 522 on a newly provisioned
preview site in PR 14. The generated smoke checker now gives read-only Pages
GET/HEAD requests a bounded retry on gateway/edge errors while preserving
cross-origin redirect rejection, immediate failure for unsafe requests, and
a final failure for persistent errors. This is propagation tolerance, not a
substitute for a passing hosted preview browser run.
The published Alpha 129 → 130 upgrade rehearsal now also reviews the exact
protected preview-cleanup command against the recorded baseline before applying
the source upgrade; the two-tenant database and RLS rehearsal passes.

- Finish Resend and Stripe environment lifecycle, reconciliation, staging
  safety, and protected provider integration tests.
- Use `ExecutionContext` consistently for every authenticated application
  route, including billing.
- Standardize shared error mapping, semantic event names, correlation across
  asynchronous boundaries, redaction, metrics, and operational health.
- Complete cross-boundary correlation and review provider-internal diagnostics
  against the standardized logging contract.

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

- Optional platform admin (`capabilities.admin`), shipped: `create-trestlejs
  --admin` or `trestle apply` scaffolds `apps/admin` as a separate-origin SPA
  and admin Worker, with sign-in only and its own `trestle_platform` database
  login (`DATABASE_ADMIN_URL`). One permission registry spans the
  organization, application, and platform planes, with central route
  enforcement and drift tests. Platform roles are `platform_operator`,
  `commercial_admin`, and `security_admin`, managed with
  `trestle admin grant|revoke|list`. The admin has Overview, Health, Async
  events (redrive), Webhooks (disable and replay), Artifacts, Subscriptions
  (audited entitlement overrides with tombstones), Machine access (API-key
  revocation), and Support sessions (read-only, at most four hours). Every
  action writes a redacted, correlated `audit_event`. Service accounts,
  scoped API keys, tenant audit history, and organization regional defaults
  ship through the tenant API. The generated canary requires the admin
  scenarios to pass with the admin enabled and disabled. Staging and
  production deploy the admin only when it is enabled, with a smoke check.
- Admin work remaining: the first deployed run of the admin staging path,
  once an admin-enabled staging project has isolated resources (see
  [ADMIN_INTEGRATION_PLAN.md](ADMIN_INTEGRATION_PLAN.md)).
- Deferred admin scope (see [ADMIN_SPEC.md](ADMIN_SPEC.md) and
  [ADMIN_ADDITIONS_SPEC.md](ADMIN_ADDITIONS_SPEC.md)): the setup wizard steps,
  identity and SSO, notifications, the Effective Access Explorer UI,
  Organizations, Users, Plans, and Audit admin views, customer UI for roles,
  service accounts, audit, and regional settings, API-key rate limits, CIDR
  allowlists, and usage metering, plan versioning and quotas, and Lago and
  OpenMeter adapters. User impersonation is out of scope.
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
  semantics; optional translation is separate product scope. The full
  normative draft is still needed before these contracts can be marked
  implemented (see [Regional Settings](REGIONAL_SETTINGS_SPEC.md) §4);
- framework upgrade/sync tooling and compatibility guarantees;
- deployed evidence for the optional admin, admin-view and admin-resource
  generation, and the deferred admin scope listed under Alpha 12;
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

<!-- ===================== CUT LINE ===================== -->
<!-- Everything below is an unscheduled proposal backlog. Release-loop and
     implementation agents: do not implement, reorder, or edit anything below
     this line unless the project owner explicitly schedules an item. -->

---

## Proposed Backlog (unscheduled, owner review)

> **Do not act on this section.** These are proposals, not commitments. The
> project owner moves an item above the cut line when it is scheduled.

### Selection rule

A capability joins the framework only if it removes manual work every project
does, or closes a security or cost risk every project has. It must also be
testable locally and in the canary without live provider accounts. Anything
else is application code.

Each capability ships behind a manifest flag, with:

- generated files present only when the flag is enabled;
- guarded deploy steps;
- Health guidance when it is not configured;
- a required canary scenario.

### Design principle: scale to zero

An idle generated project should cost close to nothing in every provider, not
only in Cloudflare. No component may poll PostgreSQL on a fixed short interval,
keep compute awake, or require an always-on server. Work is triggered by
events. The only timers left are due-time alarms, set when work exists, and
infrequent safety sweeps. Heavy or long work goes to Cloudflare Workflows or
Containers, not a server on another cloud.

### Hardening (before the selected items)

The [Platform Hardening Specification](PLATFORM_HARDENING_SPEC.md) lists open
safety work on existing mechanisms. In order:

1. **P3:** keep application crons when adding the framework tick.
2. **P1:** tenant-safe composite foreign keys for generated relationships.
3. **P5 with P2:** a declared provenance window, and committed-event
   verification for every private Queue and Workflow handler.
4. **P4 gaps:** durable reconciliation requests and local-adapter parity (done; live sandbox evidence remains a beta gate).

The due-time scheduler (Selected item 1) merges its sweep and maintenance
crons with application crons using P3's rules.

### Selected (in order)

1. **Due-time scheduler, replacing the every-minute cron.** **Done.**
   `TrestleScheduler` (`apps/worker/src/scheduler-object.ts`) is bound as
   `TRESTLE_SCHEDULER` wherever Queues or R2 are enabled, previews included,
   and locally for `wrangler dev`. Requests wake outbox dispatch on commit;
   outbox publish retries, local webhook retries, and application jobs
   (`scheduledJobs.register` in `apps/worker/src/jobs.ts`, lease-safe through
   the `scheduled_job` table, migration 0037) run on its alarm. The framework
   crons are now a `*/15 * * * *` safety sweep and `7 * * * *` hourly
   maintenance, merged with application crons by P3's rules.
   - **The problem.** `queue-config.mjs` adds `* * * * *` whenever Queues or R2
     are enabled. Each run queries Neon for outbox dispatch, native webhook
     recovery, and artifact maintenance, so compute never suspends, even with
     no users.
   - **Dispatch on commit.** Send the Queue wake-up after the request commits.
   - **The scheduler.** A single Durable Object acts as a dirty flag:
     - code that creates future work records the work's due time with it;
     - it sets an alarm for the earliest due time;
     - the alarm drains due work and re-arms only if more remains.
   - **Idle behavior.** With nothing pending there is no alarm and no database
     connection. The object's own state answers "anything pending?".
   - **Slower background work.** Maintenance runs hourly or daily; a safety
     sweep runs every 10–15 minutes.
   - Durable Object alarms run under `wrangler dev` and Miniflare.
2. **Idle check in the canary.** **Done.** `scheduler.integration.test.ts`
   runs in `check:generated` behind a counting PostgreSQL proxy, and
   `tests/browser/local-scheduler.spec.ts` checks the alarm under
   `wrangler dev`. An idle generated project makes zero database
   queries over a sampled window. Created events still dispatch promptly, and a
   scheduled webhook retry fires at its due time. This keeps the scale-to-zero
   principle from regressing.
3. **Project identity and the provisioning token.**
   - **One identity block in `.trestle/project.yaml`:**
     - project name and Cloudflare zone domain;
     - derived site, app, api, admin, and admin-api hostnames;
     - per-environment subdomains;
     - email sender, reply-to, and sender domain;
     - support address.
   - **What it replaces.** Trestle derives `APP_URL`, `API_URL`, `WEB_ORIGIN`,
     `EMAIL_FROM`, admin origins, and CORS origins, replacing every
     `CHANGE_ME` and hand-set GitHub variable.
   - **The setup token.** The user creates it from documented permissions,
     scoped to one account and one zone:
     - **Account:** Workers Scripts, Pages, R2, Queues, Turnstile, and Access
       apps and policies, all Edit.
     - **Zone:** Zone Read, plus DNS and Workers Routes, both Edit.

     Confirm the permission names in the dashboard when writing the docs. The
     token stays local and encrypted; CI gets a narrow deploy token.
   - **Provisioning flow** (reviewed with `trestle plan diff`, applied with
     `trestle apply --yes`):
     1. Verify the token and each permission with read-only calls.
     2. Show a diff of what it will create.
     3. Apply it idempotently: DNS records, Pages projects, custom domains, and
        the Turnstile widget.
     4. Record what it created.
     5. Write keys and variables back.
   - **Sender domain.** Create Resend's SPF and DKIM records in the zone and poll
     until the domain is verified.
   - **`trestle doctor`** checks the zone, hostname resolution and certificates,
     sender verification, and that variables match the manifest.
4. **Turnstile** on sign-up, sign-in, password reset, and the admin sign-in.
   The widget is created by the provisioning flow for the configured hostnames.
   Cloudflare's always-pass and always-fail test keys keep local runs and the
   canary credential-free.
5. **`trestle destroy --env <environment>`.** Remove exactly the resources that
   setup recorded, so abandoned environments stop accruing cost.

### Later (after the selected items)

- **Cloudflare Access in front of the platform admin.** It needs the custom
  admin domains from item 3. The admin Worker verifies the Access JWT and
  disables its `workers.dev` route.
- **Generated scheduled jobs** (`trestle generate job`) on the item-1
  scheduler.
- **Exact per-API-key rate limits** in Durable Objects, sized by entitlements.
  Use the Workers Rate Limiting binding for cheap abuse protection.
- **Customer UI for shipped APIs:** service accounts and keys, audit history,
  application roles, and regional settings.
- **OpenAPI from the central route policies,** with a typed client for API keys.
- **Secret rotation automation** (`trestle secrets rotate`), building on
  dual-value secrets.

### Parked (only when a real application needs it)

- **Cost and caching:** Hyperdrive, KV caching of execution-context lookups,
  Analytics Engine usage metering and quotas, and an admin cost view.
- **Realtime:** hibernating Durable Object WebSockets.
- **Data and tenancy:** regional data placement, staging built from anonymized
  production data, and per-tenant custom domains (Cloudflare for SaaS).
- **Cloudflare services:** Workers AI and AI Gateway, Vectorize, Images, Browser
  Rendering, Email Routing, and D1.
- **External services:** Sentry, PostHog, an uptime monitor, and Grafana Cloud.
- **Product features:**
  - SSO through Better Auth plugins;
  - notifications and digests;
  - invitations and onboarding flows;
  - trials, dunning, coupons, and referral codes;
  - audit retention and export;
  - backup evidence in Health;
  - a public status page;
  - per-organization data export and deletion;
  - an MCP server for the tenant API.
- **Preview environments:** a seeded demo in every preview.

### Admin follow-ups from the spec review (not yet fixed)

- **Unenforced platform permissions.** No admin route requires
  `platform.organizations.read`, `platform.roles.read`, or
  `platform.roles.manage`. Platform-role changes run only through the CLI as a
  system actor. Either add the views that use them or remove them from the
  registry.
- **Unenforced registry flags.** `secret` on permissions and `revealsSecret` on
  route policies are documented as refused in support sessions, but nothing
  reads them.
- **Dead code.** The custom-role code (`RoleCatalog.withCustomRoles`, the
  `tenant` role source) is never called.
- **Legacy column.** `member.application_role` is kept only for rollback from
  authority model 2. Drop it in a later migration.
- **One name for the platform database URL.** `trestle console
  --platform-admin` uses `DATABASE_PLATFORM_URL`; everything else uses
  `DATABASE_ADMIN_URL`.
- **Narrower sign-in login for the admin Worker.** The admin Worker receives
  the tenant runtime `DATABASE_URL` for Better Auth tables. Give it a narrower
  login, so a compromised admin holds only platform authority.
- **A database-level bound on support reads.** Support-session reads run on
  `trestle_platform`, and the Worker's session check is the only boundary. A
  policy tied to an open `support_session` would enforce it in PostgreSQL.
- **View-as-member product pages.** The initial customer-app handoff has a
  separate, read-only support credential and a server-checked banner, but
  deliberately blocks ordinary product routes. Reviewed product GET routes
  still need explicit support-mode opt-in, an operator/effective-user context,
  read-only database access, and page-level tests before custom domain data can
  be displayed as a member. No Alice login cookie or broad impersonation mode.
- **Transactional webhook audit.** Tenant webhook endpoint changes are audited
  after commit, not in the same transaction.
- **API-key controls.**
  - CIDR allowlists; the `network_denied` credential status exists but nothing
    produces it.
  - Scope profiles.
  - Last-used tracking.

### Deferred admin scope (from `ADMIN_SPEC.md` and `ADMIN_ADDITIONS_SPEC.md`)

- **An Effective Access Explorer route and UI.** The explanation exists only as
  a library function.
- **More admin views and navigation:**
  - Organizations, Users, Plans, Permissions, Email, and Audit views;
  - global search, breadcrumbs, and a tenant-context indicator.
- **Application-owned admin views** discovered by file convention, with a
  generator.
- **Custom and resource-scoped application roles.**
- **Step-up authentication** for sensitive platform actions.
- **Commercial depth:**
  - stored plan versions and lifecycle transitions;
  - admin plan editing;
  - typed privilege values;
  - entitlement compare and simulate;
  - reconciliation records.
- **Support sessions:** revocation by another operator, a banner that persists
  across views, and access profiles.
- **Regional settings:** user preferences, the customer and user pages, the
  preview, change warnings, and effective-settings debugging, as listed in
  [Regional Settings](REGIONAL_SETTINGS_SPEC.md) §2.
- **Domain events for administrative mutations.** Today they produce audit rows
  only.
- **Customer webhook management:** edit, delete, test event, and secret
  rotation where they are not yet generated.

### Housekeeping

- Close #54 and #57; the merged admin slices supersede them.
- Extend the first successful isolated admin staging run beyond anonymous
  denial to authenticated operator and support-view scenarios, using a canary
  upgraded to the published beta (see `ADMIN_INTEGRATION_PLAN.md`).
