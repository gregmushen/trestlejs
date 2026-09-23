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
| 5 | Operations views over `main`'s async (dead outbox redrive), artifacts, and webhooks (disable and replay), with audit. Migration 0023 grants `trestle_platform` metadata columns only, and RLS limits it to the three recovery transitions | In review |
| 6a | Commercial controls: subscription reads and audited entitlement override grant and revoke, with tombstones (0024). Tenant runtimes lose override write access | In review |
| 6b | Machine access: service accounts and scoped API keys (mint, rotate, revoke) with a SECURITY DEFINER resolver (0025), bearer-key execution context, and platform revocation, all audited. Per-key rate limits, CIDR allowlists, and usage metering are deferred | In review |
| 7 | Support sessions (entry and exit audited), regional settings (re-targeted from #57), identity and SSO | Planned |
| 8 | Generated canary with admin enabled and disabled, platform sign-in, cross-plane denial, support session, and an API key before and after revocation; then an admin path in the deployed staging gate once its resources are isolated | Planned |
| 9 | `ADMIN_SPEC.md` and `ADMIN_ADDITIONS_SPEC.md` on `main`, corrected against the implementation, with unbuilt features marked deferred; roadmap updated | Planned |

Out of scope: merging #57 wholesale, the 12-step setup wizard, Lago and OpenMeter adapters, and user impersonation.
