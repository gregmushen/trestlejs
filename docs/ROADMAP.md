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

## Beta completion criteria

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

The [beta testing ledger](BETA_CANDIDATE_TESTING_LEDGER.md) records which of these
gates have evidence and which are open.

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

Shipped: versioned event envelopes and registries, a transactional outbox
wired to resource mutations, leasing/retry/dead-letter recovery, capability-
gated Queue, Workflow and R2 bindings, DLQ inspection and redrive, deterministic
Workflow retry, tenant-owned artifact metadata with signed access, retention and
audits, and the due-time scheduler for application jobs. Committed-event
verification and the provenance lifecycle are specified in the
[Platform Hardening Specification](PLATFORM_HARDENING_SPEC.md). Deployed
end-to-end async evidence remains open in the beta ledger.

### Alpha 9: production integrations and observability

Shipped across alphas 35–135; per-release detail is in
[RELEASE_HISTORY.md](RELEASE_HISTORY.md).

- **Outbound webhooks:** event contracts, tenant-owned messages and deliveries,
  signing secrets, leases, retries, replay, retention and inspection screens
  shipped. Remote native delivery stays disabled (see
  [WEBHOOK_EGRESS_RUNTIME.md](WEBHOOK_EGRESS_RUNTIME.md)).
- **Resend and Stripe:** adapters, deployment preflights, webhook endpoint
  setup, protected staging acceptance gates and durable billing reconciliation
  shipped; production provider evidence remains (see the beta ledger).
- **Observability:** redacted structured logging with registered runtime
  secrets, safe `trestle logs` projection and classified error names shipped.
- **R2 artifacts and recovery:** retention, reference audits and isolated
  restore verification shipped.
- **Upgrades:** generation baselines, `upgrade source-apply/finalize`,
  `upgrade migrations` and published adjacent-version rehearsals shipped.

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
- Deferred admin scope is listed once, in the implementation status section of
  [ADMIN_SPEC.md](ADMIN_SPEC.md).
- Full browser, deployment, authorization, idempotency, upgrade, recovery,
  and adjacent-version migration suites.
- Complete machine-readable inspection for routes, resources, events,
  workflows, queues, Durable Objects, bindings, permissions, and environments.
- Resolve remaining specification/implementation contradictions and freeze
  the supported beta command and compatibility contracts.

## Remaining v1 gaps

- Production and deployed evidence: Cloudflare, Neon, Resend and Stripe in
  production, deployed async and recovery paths, and the signed-in admin (the
  [beta ledger](BETA_CANDIDATE_TESTING_LEDGER.md) tracks each).
- The normative locale, time-zone, civil-date, exact-money and currency
  specification; translation is separate product scope (see
  [Regional Settings](REGIONAL_SETTINGS_SPEC.md) §4).
- Richer resources: generated typed API clients and authorization policies.
- Static architectural enforcement and complete machine-readable discovery.
- A frozen, documented command and compatibility contract for beta.

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
- provider objects leaking into domain contracts;
- a generic realtime or WebSocket framework, Redis or a generalized cache,
  a dedicated search engine, GraphQL, or a vector database integration;
- generic event sourcing, a dependency-injection framework, a service mesh,
  or a custom RPC protocol;
- alternative ORMs, auth engines, or SQL dialects, schema-per-tenant tenancy,
  or Kubernetes/container deployment;
- a generalized policy engine or a plugin marketplace;
- cloud-provider abstraction beyond what the core interfaces naturally permit;
- a tenant-managed secret vault, or beta Cloudflare Secrets Store as the
  default provider.

**Adding a subsystem.** A new infrastructure abstraction needs a concrete
failing use case, the alternatives considered, its operational and cost
impact, and an architecture decision record. Symmetry, trend coverage, or
speculative completeness is not enough. Corrections that tighten security,
resolve contradictions, or make an existing contract implementable are always
allowed.

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

### Hardening

P1–P5 of the [Platform Hardening Specification](PLATFORM_HARDENING_SPEC.md)
are done; P4's live Stripe sandbox evidence remains a beta gate.

### Selected (in order)

1. **Due-time scheduler.** Done (#202): a `TrestleScheduler` Durable Object
   dispatches on commit, runs due work and application jobs
   (`scheduledJobs.register`) on alarms, and leaves only a 15-minute safety
   sweep and hourly maintenance cron. The template README's Scheduling section
   documents it.
2. **Idle check in the canary.** Done (#202): `scheduler.integration.test.ts`
   proves an idle project makes zero database queries.
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

### Deferred admin scope

Listed once, in the implementation status section of [ADMIN_SPEC.md](ADMIN_SPEC.md).

### Housekeeping

- Extend the first successful isolated admin staging run beyond anonymous
  denial to authenticated operator and support-view scenarios, using a canary
  upgraded to the published beta (see `ADMIN_INTEGRATION_PLAN.md`).
