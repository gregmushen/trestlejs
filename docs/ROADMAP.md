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
| Alpha 6 | A trustworthy tenant-owned CRUD slice from browser to forced PostgreSQL RLS, plus safe plan/apply repair | Current |
| Later alphas | Broader generators, operational depth, deployment lifecycle, and upgrade tooling | Planned |
| Beta | Stable conventions, migration compatibility, upgrade rehearsals, and production evidence from real applications | Planned |
| v1 | Supported end-to-end product-development and deployment path with documented compatibility guarantees | Planned |

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

## Before beta

The next alphas should deepen the shipped path in this order:

1. **Production deployment evidence** — provision and verify preview,
   staging, and production environments through the generated GitHub Actions
   and Cloudflare configuration, including secrets projection and rollback
   documentation.
2. **Upgrade tooling** — introduce versioned template migrations, dry-run
   inspection, and safe upgrades for existing Trestle applications.
3. **Resource evolution** — support additional field types, relationships,
   authorization policies, pagination, and migration-safe edits without
   becoming a generic low-code schema engine.
4. **Background execution** — generate queue consumers, scheduled work, and
   workflows with stable idempotency, outbox conventions, and local test
   controls.
5. **Operational adapters** — finish production-grade Resend and Stripe
   lifecycle commands, verified webhooks, reconciliation, staging safety, and
   provider integration tests.
6. **Observability** — standardize request, domain, queue, workflow, email,
   billing, and deployment telemetry with consistent redaction and useful
   diagnostics.
7. **System testing** — exercise authentication, tenant switching, resource
   CRUD, email verification, billing projection, and deployment from freshly
   generated applications in CI.

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
