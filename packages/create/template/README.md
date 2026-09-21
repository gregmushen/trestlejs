# __TRESTLE_PROJECT_NAME__

A TrestleJS application.

```bash
pnpm install
trestle secrets init
trestle secrets edit
trestle dev
```

The web application runs on `http://localhost:42069`; the Worker runs on
`http://localhost:8787`.

The starter includes email/password sign-up and sign-in, database-backed
sessions, a protected dashboard, and organization creation. Replace the
local credentials before using the app outside local development. A useful
local document is:

```yaml
BETTER_AUTH_SECRET: replace-with-at-least-32-random-characters
BETTER_AUTH_URL: http://localhost:42069
DATABASE_DRIVER: postgres-js
DATABASE_URL: postgres://trestle:trestle@localhost:55432/__TRESTLE_PROJECT_NAME__
```

Email is captured locally by default. Use `trestle email list`, `trestle email
show <id>`, `trestle email open <id>`, and `trestle email clear` while the
Worker is running. Staging and production use the Resend adapter with
`RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` stored through `trestle secrets`;
`EMAIL_FROM`, `EMAIL_REPLY_TO`, and the staging redirect recipient are typed
non-secret deployment configuration.

Cloud deployments default to Neon's Worker-native HTTP driver. Local development
sets `DATABASE_DRIVER=postgres-js` in encrypted credentials so the same app can
use the Compose PostgreSQL instance directly. No persistent `.dev.vars` file is
created by `trestle dev`.
