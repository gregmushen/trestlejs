# Platform admin

The optional platform admin for operating this application. It exists only when the project is generated with `create-trestlejs --admin`, which sets `capabilities.admin: true` and `apps.admin: apps/admin`.

- **Separate origin and sign-in.** The SPA (`src/`) and API Worker (`worker/`) deploy separately from the customer app. Operators sign in with their normal account on the admin origin. The admin exposes only sign-in, session, and sign-out, so it has no sign-up.
- **Platform authority only.** A request needs an active platform role (`packages/authz/src/role-definitions.ts`). Tenant membership or ownership grants nothing here, and platform roles grant nothing inside a tenant.
- **Its own database login.** Outside local development the Worker reads through `DATABASE_ADMIN_URL`, a distinct login granted only `trestle_platform` (`pnpm --filter ./packages/db db:platform:configure`).
- **Central view registry.** `src/registry.ts` declares each view's sidebar entry, required platform permission, dependent capability, and API routes. The Worker derives its route policies from it, and a drift test keeps views, routes, and permissions aligned. Add a view by adding an entry and a component in `src/views/`.

Bootstrap the first operator after they sign up in the customer app:

```bash
pnpm exec trestle admin grant ops@example.com security_admin --env local --reason "first operator"
```

Local development:

```bash
pnpm --filter ./apps/admin dev       # API Worker on :8788
pnpm --filter ./apps/admin dev:spa   # SPA on :42070
```
