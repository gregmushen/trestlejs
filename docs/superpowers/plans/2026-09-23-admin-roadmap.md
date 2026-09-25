# Platform Admin Roadmap: From Observing to Operating

**Status:** agreed 2026-09-23. Each step below gets its own detailed plan
(`docs/superpowers/plans/`) and its own PR from the latest `origin/main`.

**Starting point:** `feat/admin-ui-restore` restores the Kumo admin UI
(20 views) on `main`'s admin Worker. Most views are read-only because the
`trestle_platform` database role was scoped to observe and recover.

**Goal:** an admin in which operators can run the product: manage people and
access, configure the application and its providers, act inside a customer's
account when supporting them, and manage plans, without weakening the
properties that make it safe to expose.

## Decisions

1. **Secrets are write-only, and infrastructure secrets stay out of the web.**
   - *Settings* (email sender, sign-up rules, session length, feature toggles):
     editable with a reason, audited.
   - *Provider credentials* (Resend, Stripe, webhook signing, SSO client
     secrets): stored encrypted in PostgreSQL and read by the application at
     runtime. The admin can set or rotate them but never read them back; it
     shows presence, a fingerprint, and who changed them when. Changes require
     step-up with a second factor and are audited.
   - *Infrastructure secrets* (`DATABASE_URL`, `DATABASE_ADMIN_URL`,
     `BETTER_AUTH_SECRET`, credentials master keys): `trestle secrets` only.
2. **Acting in a customer's account goes through read-write support sessions.**
   A support session gains a *profile*: read-only (today) or read-write for
   named actions. Read-write sessions are time-boxed, need a reason, and every
   action is audited on the customer's own audit log. There is no standing
   cross-tenant write authority.
3. **Plans and roles are hybrid.** Plans, features, roles, and permissions
   defined in reviewed source remain the protected base. The admin adds
   custom plans, plan versions, and roles stored in PostgreSQL; runtime access
   and entitlement decisions read both. Permissions stay code-defined because
   code must check them.

## Steps

| # | Step | Depends on |
| --- | --- | --- |
| 1 | **Account security:** operator TOTP and passkeys, per-session assurance, step-up for sensitive actions | — |
| 2 | **People and access:** suspend/restore users, revoke sessions, change members' organization and application roles, revoke other operators' support sessions, suspend/reactivate service accounts | 1 |
| 3 | **Configuration:** runtime settings, authentication policy (versioned drafts, activation, rollback), write-only provider secrets store | 1 |
| 4 | **Read-write support:** support profiles; tenant webhooks (create, edit, pause/resume, test, rotate, delete), API keys (mint, rotate, re-scope), workspace actions | 1, 2 |
| 5 | **Commercial:** plans and versions in PostgreSQL (draft, activate, grandfather, retire), scheduled plan changes, Stripe reconcile, entitlement comparison | 1, 3 |
| 6 | **Custom roles:** organization and application roles created, edited, archived at runtime over code-defined permissions | 1, 2 |
| 7 | **Notifications:** notification streams, delivery, preferences, operator retry/cancel | 3 |
| 8 | **Identity:** SSO (OIDC/SAML) with domain verification, SCIM provisioning | 1, 3 |

The feature branch `feat/regional-settings` (PR #57) holds a working
implementation of most of these against its own backend; each step ports its
UI and adapts its backend to `main`'s schema, as the restore did.

## Every step

- Branch from the latest `origin/main`; migrations are generated with
  `pnpm --filter ./packages/db db:generate` and append after `main`'s journal.
- Grants to `trestle_platform` or the runtime login are explicit, column-level
  where possible, and asserted in `packages/db/src/platform-roles.integration.test.ts`.
- Every write requires a reason, writes `audit_event` in the same transaction,
  and (from step 1 on) requires step-up assurance.
- Evidence before merge: `pnpm check`, `pnpm check:generated` with PostgreSQL,
  and the admin view check (`pnpm --filter ./apps/admin check:views`).
