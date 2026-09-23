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
| 3 | Persisted, redacted `audit_event` with correlation IDs for sensitive actions | In review |
| 4 | Optional admin shell (`capabilities.admin`): `apps/admin` on a separate origin, platform authentication, central view registry, Overview and Health, sanitized setup guidance | Planned |
| 5 | Operations views over `main`'s async (DLQ redrive), artifacts, and webhooks (disable and replay), with audit | Planned |
| 6 | Commercial controls and machine access: plans and overrides; service accounts and scoped API keys (mint, rotate, revoke), with audit | Planned |
| 7 | Support sessions (entry and exit audited), regional settings (re-targeted from #57), identity and SSO | Planned |
| 8 | Generated canary with admin enabled and disabled, platform sign-in, cross-plane denial, support session, and an API key before and after revocation; then an admin path in the deployed staging gate once its resources are isolated | Planned |
| 9 | `ADMIN_SPEC.md` and `ADMIN_ADDITIONS_SPEC.md` on `main`, corrected against the implementation, with unbuilt features marked deferred; roadmap updated | Planned |

Out of scope: merging #57 wholesale, the 12-step setup wizard, Lago and OpenMeter adapters, and user impersonation.
