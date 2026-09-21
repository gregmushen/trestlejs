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
