# Admin integration plan

This plan lands the optional platform admin on `main` in small slices, next to the ongoing release loop. The source material is PR #54 (the admin and access-control port) and PR #57 (regional settings). Neither is merged as a branch. Their webhook, artifact, billing, outbox, and inbox tables are superseded by `main`'s subsystems.

## Rules

- Each slice is its own PR from the latest `origin/main`, with its own tests.
- Migrations are generated with `pnpm --filter ./packages/db db:generate`, which appends after `main`'s journal. Published migrations are never rewritten.
- Development uses isolated local databases, and tests run in-process. Nothing touches the release loop's worktrees, publish tags, or shared staging.
- Required evidence for every slice: `pnpm check`, `pnpm check:generated` with PostgreSQL, and the full generated database suite.

## Slices

| # | Slice | Status |
| --- | --- | --- |
| 1 | Security fixes: organization authority never implies application authority, including for artifacts; new members get no application role; override reasons are excluded from customer provenance | Merged (#107) |
| 2 | Permission registry and route policy: one registry across the organization, application, and platform planes; roles resolved from it; central route enforcement; cross-plane proofs | Merged (#108) |
| 3 | Persisted, redacted `audit_event` with correlation IDs for sensitive actions | Merged (#110) |
| 4a | Platform plane persistence: `trestle_platform` database role, audited `platform_role_assignment`, platform-only access resolution, `trestle admin grant`, `revoke`, and `list` | Merged (#111) |
| 4b | Optional admin shell (`capabilities.admin`): `apps/admin` on a separate origin, platform authentication, central view registry, Overview and Health, sanitized setup guidance; `create` gating (4b-1). 4b-2: `trestle apply` scaffolding, admin secret targets, and conditional staging/production deploy with an admin smoke | Merged (#112, #113) |
| 5 | Operations views over `main`'s async (dead outbox redrive), artifacts, and webhooks (disable and replay), with audit. Migration 0023 grants `trestle_platform` metadata columns only, and RLS limits it to the three recovery transitions | Merged (#115) |
| 6a | Commercial controls: subscription reads and audited entitlement override grant and revoke, with tombstones (0024). Tenant runtimes lose override write access | Merged (#117) |
| 6b | Machine access: service accounts and scoped API keys (mint, rotate, revoke) with a SECURITY DEFINER resolver (0025), bearer-key execution context, and platform revocation, all audited. Per-key rate limits, CIDR allowlists, and usage metering are deferred | Merged (#118) |
| 7a | Support sessions: time-boxed (at most 4 hours), reasoned, read-only access to one organization, with entry, each view, and exit audited on it (0026). No impersonation | Merged (#120) |
| 7b | Regional settings, re-targeted from #57: organization defaults for language, locale, time zone, and currency, resolved per setting with its source; tenant read and audited change; shown in support sessions (0027). User preferences, i18n configuration, and the #57 setup wizard steps are deferred | Merged (#121) |
| 7c | Identity and SSO (SAML/OIDC connections, domain verification, enforced sign-in) | Deferred: spec only |
| 8 | Generated canary requires named admin scenarios to pass rather than be skipped when a database is set: admin enabled and disabled, `trestle apply` parity, platform sign-in, cross-plane denial, support-session entry and exit, and a scoped API key before and after revocation. An older alpha.90 admin canary now passes isolated staging deployment and anonymous-denial checks; authenticated hosted scenarios remain open (see below) | Merged (#122); hosted proof partial |
| 9 | `ADMIN_SPEC.md` and `ADMIN_ADDITIONS_SPEC.md` on `main`, corrected against the implementation, with unbuilt features marked Deferred; roadmap updated; hardening found in the spec review | In review |

Out of scope: merging #57 wholesale, the 12-step setup wizard, Lago and OpenMeter adapters, and user impersonation.

## Deployed admin gate: first run and remaining proof

The staging job deploys and smoke-checks the admin only when `capabilities.admin` is true. The separate admin-enabled [platform canary PR #1](https://github.com/gregmushen/trestlejs-platform-canary/pull/1) established these isolated resources and its [post-merge staging run](https://github.com/gregmushen/trestlejs-platform-canary/actions/runs/36209805920) passed deployment, operational checks, and anonymous-denial browser tests. The canary has its own:

- Cloudflare Pages project `<project>-admin-staging` and admin Worker `<project>-admin-staging`;
- PostgreSQL login granted only `trestle_platform`, stored as the encrypted `DATABASE_ADMIN_URL` staging secret;
- GitHub `staging` environment variables `ADMIN_URL`, `ADMIN_API_URL`, and `DATABASE_ADMIN_RUNTIME_ROLE`.

The next gate must use a canary upgraded or regenerated from the published beta and prove authenticated operator sign-in, cross-plane denial, support-session entry/exit, and the read-only customer-app support view. The existing alpha.90 hosted run does not prove those behaviors.
