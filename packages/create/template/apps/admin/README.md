# Platform admin

The optional platform admin for operating this application. It exists only when `capabilities.admin` is true. Generate it with `create-trestlejs --admin`, or add it later with a SetupPlan that sets `capabilities.admin: true` and `pnpm exec trestle apply <plan> --yes`. The project must be on the installed CLI's template version. Disabling the admin is a manual change; `trestle apply` never removes it.

- **Separate origin and sign-in.** The SPA (`src/`) and API Worker (`worker/`) deploy separately from the customer app. Operators sign in with their normal account on the admin origin, with a password plus TOTP or with a passkey. The admin exposes only sign-in, session, sign-out, and the operator's own two-factor and passkey endpoints, so it has no sign-up.
- **Sign in with your factor.** Once an operator has TOTP or a passkey, every admin API request (reads included) and every operator-only auth route (the operator's own factor endpoints) needs a session that signed in with one (a passkey counts). A password-only session, including a customer-app session replayed here, gets 428 `step_up_required` with `scope: "session"` and the sign-in screen. Operators without a factor are unaffected. Until an operator enrolls a factor, their password alone can enroll one; enroll factors before granting deployed platform roles.
- **Step-up for every change.** Each platform action needs fresh evidence (15 minutes): a password locally, a second factor when deployed, and a passkey to manage platform roles. Changing a factor needs the strongest factor the account already has. Otherwise the Worker answers 428 `step_up_required` and the UI asks the operator to re-authenticate, then retries after each successful verification. A passkey is offered at every level; an operator with a passkey but no TOTP is not offered a password, which would drop their session below the sign-in level. Routes marked `stepUp: false` in `src/api-registry.ts` (explaining access, ending a support session) skip the freshness check but not the sign-in level. An unset `APP_ENV` counts as production. Stepping up leaves the previous session alive until it expires. Operators manage their own factors in the Account security view; recovering an operator who lost every factor is a database action (see `docs/ADMIN_SPEC.md` §7.6 in the Trestle repository).
- **Platform authority only.** A request needs an active platform role (`packages/authz/src/role-definitions.ts`). Tenant membership or ownership grants nothing here, and platform roles grant nothing inside a tenant.
- **Its own database login.** Outside local development the Worker reads through `DATABASE_ADMIN_URL`, a distinct login granted only `trestle_platform` (`pnpm --filter ./packages/db db:platform:configure`).
- **File-discovered views.** Each view is a folder in `src/views/<id>/` with an `admin-view.ts` descriptor (navigation, required platform permission, capability, commands and hotkeys) and a lazily loaded component. The SPA discovers descriptors with `import.meta.glob`, and `pnpm --filter ./apps/admin check:views` validates them during the build.
- **Server view registry.** `src/api-registry.ts` lists each view's required permission and the admin routes it calls. The Worker derives its route policies from it. Tests keep it in step with the descriptors, the Worker's routes, and the command permissions. To add a view:

1. add `src/views/<id>/admin-view.ts` and its component (`view.tsx`);
2. add the view and its routes to `src/api-registry.ts`;
3. add the Worker handlers for those routes in `worker/index.ts`.

The build and the drift tests fail until the descriptors, registry, handlers, and policies agree.

## Operations

The Operations views work on the application's own subsystems, not copies of them:

- **Async Operations:** dead-lettered outbox events. Redrive returns one to delivery (`platform.outbox.redrive`).
- **Webhooks:** endpoint state and dead or exhausted deliveries across organizations. An operator can disable an endpoint or replay a delivery whose payload is still retained (`platform.webhooks.manage`).
- **Artifacts:** upload lifecycle totals and stale pending uploads.

Reads need `platform.operations.read`. The `trestle_platform` database role is granted metadata columns only. It can never read event payloads, webhook envelopes or destinations, lease tokens, or storage keys, and row-level security allows it only three transitions:

- a dead outbox event back to pending;
- an endpoint to disabled;
- a dead or exhausted delivery back to retry.

Every action requires a reason (ending a support session is the exception) and must come from the admin origin. It writes an `audit_event` with the request's correlation ID in the same transaction. The affected organization sees the event in its audit log, without the operator's identity or reason.

## Commercial controls

The Subscriptions view reads each organization's plan and subscription from the billing projection, and lists its entitlement overrides with their internal reasons (`platform.subscriptions.read`).

An override grants or denies one entitlement the application defines in `packages/billing/src/plans.ts`, with an optional expiry (`platform.entitlements.manage`, held by `commercial_admin`). A new override supersedes the active one for that entitlement, and revoking restores the plan's decision.

Overrides are never deleted; removal is a tombstone with its own reason. Tenant runtimes can read overrides but never write them. Customers see only that an entitlement comes from their contract, never the reason or author.

## Support sessions

An operator with `platform.support_sessions.use` starts a session in one organization, giving a reason and a duration of 5 to 240 minutes. For its duration, the operator can read that organization's profile, members, plan, and recent audit history.

A session never signs the operator in as a customer and grants no tenant-application authority. Entry, each view, and exit are recorded on the organization's audit log with the session ID.

An operator holds at most one open session. An expired session is closed, and that close is audited, before the next one starts.

## Machine access

Organizations create service accounts and mint, rotate, and revoke scoped API keys through `/api/tenant/service-accounts` and `/api/tenant/api-keys/:id/*`. This requires `application.service_accounts.manage`, an application-plane permission, because a service account holds application roles; organization roles grant none of it.

A key's scopes are application permissions that admit API keys, and never exceed its account's roles. Tokens are shown once and stored only as SHA-256 verifiers. A key works only in the environment that minted it.

The API Keys view lists key metadata across organizations (`platform.machine_access.read`). A security administrator can revoke a compromised key (`platform.api_keys.revoke`), and the revocation is audited on the owning organization.

Bootstrap the first operator after they sign up in the customer app:

```bash
pnpm exec trestle admin grant ops@example.com security_admin --env local --reason "first operator"
```

Local development:

```bash
pnpm --filter ./apps/admin dev       # API Worker on :8788
pnpm --filter ./apps/admin dev:spa   # SPA on :42070
```

## Credentials

The admin Worker reads platform data through `DATABASE_ADMIN_URL`, a login granted only `trestle_platform`. It also receives the application's `DATABASE_URL`, because Better Auth's session tables live there. So a compromised admin Worker would hold both logins. A narrower sign-in login for the admin is deferred.

## Deployment

The Deploy workflow runs its admin steps only when `capabilities.admin` is true (`scripts/admin-capability.mjs status`). For staging and production, it:

1. configures and verifies the platform database login (`db:platform:configure`, `db:platform:verify`);
2. pushes `DATABASE_ADMIN_URL`, plus the Worker secrets declared with `shareWith: [admin]`, to the admin Worker (`trestle secrets push`);
3. deploys the admin Worker and the SPA to the Pages project `__TRESTLE_PROJECT_NAME__-admin-staging` or `__TRESTLE_PROJECT_NAME__-admin`;
4. smoke-checks liveness, anonymous rejection, the missing sign-up route, the CORS origin, and `noindex` (`scripts/admin-capability.mjs smoke`).

Each GitHub environment needs these variables:

| Variable | Meaning |
| --- | --- |
| `ADMIN_URL` | The admin SPA origin, the only browser origin the admin API trusts |
| `ADMIN_API_URL` | The admin Worker's public URL. Better Auth on the admin origin uses it, so customer cookies never apply here |
| `DATABASE_ADMIN_RUNTIME_ROLE` | The login role in `DATABASE_ADMIN_URL`, granted only `trestle_platform` |

Previews do not deploy the admin.
