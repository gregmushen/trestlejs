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

Cloud deployments default to Neon's Worker-native HTTP driver. Local development
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
Use a long-lived, account-scoped `CLOUDFLARE_API_TOKEN` with Workers Scripts
and Pages edit access in each GitHub deployment environment; an interactive
Wrangler OAuth access token is not a durable CI credential.
`CLOUDFLARE_WORKERS_SUBDOMAIN` is the account label before `.workers.dev`; it
is used to derive the Worker URL exercised by the preview smoke gate. Preview
database branching is a separate provider lifecycle and must be configured
with `NEON_PROJECT_ID`, `NEON_DATABASE`, `NEON_MIGRATION_ROLE`, and the
encrypted CI credential `NEON_API_KEY`. Each trusted pull request then receives
an isolated Neon branch and pooled runtime URL; closure deletes that branch.

Validate the checked-in delivery contract locally with:

```bash
pnpm exec trestle ci validate
pnpm exec trestle env status --env staging
```
