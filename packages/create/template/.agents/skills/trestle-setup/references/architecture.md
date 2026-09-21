# Trestle Architecture Conventions

Use these conventions as defaults, not as justification to enable unused components. Surface a conflict when product requirements make a default inappropriate.

## Application surfaces

- `apps/site`: optional public Astro static site, normally on port 42068 locally.
- `apps/app`: authenticated React application using TanStack Router, Query, and Form, normally on port 42069 locally.
- `apps/worker`: Hono API and integration boundary, normally on port 8787 locally.
- Tailwind CSS and the shared Trestle theme are the UI styling defaults.
- Public-site authentication links use typed `APP_URL`; locally they target `http://localhost:42069`.

## Identity, tenancy, and data

- Better Auth owns authentication and enabled organization flows.
- PostgreSQL is canonical application state; Drizzle provides typed persistence.
- Organization-owned data uses forced PostgreSQL RLS. Verify policies with the actual application role rather than a bypass-capable owner role.
- Application authorization consumes local canonical state through execution context. Client claims and live provider lookups are not authorization sources.
- Zod validates external and cross-package boundaries.

## Storage and async behavior

- Store large files and generated artifacts in R2 when the requirement exists; keep metadata and ownership in PostgreSQL.
- Use Queues for asynchronous transport and retryable work distribution.
- Use Workflows for durable multi-step progression, waits, or future conditional business decisions.
- Use Durable Objects only for coordinated mutable state or serialized per-entity operations.
- Version queue, workflow, event, and webhook contracts and make side effects idempotent.

## Email

- Application and Better Auth code depend on the provider-neutral `EmailService`.
- React Email is the default template system; templates remain application-owned source.
- Local development uses capture, staging applies a safe-recipient policy, and Resend is the golden-path production adapter.
- Provider scheduling is for a known message at a known time. Workflows own future conditional decisions.
- Use an outbox/Queue or Workflow after committed domain changes; do not send external email inside a database transaction.

## Payments

- Application code depends on provider-neutral `BillingService`; Stripe is the golden-path adapter.
- Organizations are the default billing subject unless product requirements explicitly say otherwise.
- PostgreSQL owns the canonical subscription and entitlement projection. Stripe owns payment mechanics.
- Grant entitlements only after verified, deduplicated webhook state is persisted—not from checkout redirects or client claims.
- Application code checks capabilities such as `workflows.advanced`, not commercial plan names.

## Secrets, delivery, and observability

- Use Rails-style environment-specific encrypted credentials. Commit encrypted files; never commit master keys.
- Secret values never belong in SetupPlan, logs, error reports, or agent conversation unless the user explicitly requests disclosure through the supported CLI.
- Cloudflare is the deployment golden path; GitHub Actions handles verification and environment-aware deployment.
- Semantic structured logs carry correlation and causation identifiers and redact credentials, tokens, magic links, message bodies, and sensitive provider payloads.
- Prefer production-shaped free-tier infrastructure until requirements or scale justify paid resources.
