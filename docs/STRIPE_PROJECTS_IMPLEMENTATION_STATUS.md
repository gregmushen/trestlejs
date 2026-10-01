# Stripe Projects Implementation Status

Durable progress record for the [implementation plan](STRIPE_PROJECTS_IMPLEMENTATION_PLAN.md).
The completed design review is not counted as implementation. A package is
`complete` only when its plan exit criteria have evidence below; `blocked`
names the external prerequisite, owner, and next action.

Statuses: `pending`, `in_progress`, `complete`, `partial` (local exit met,
hosted exit blocked), `blocked`.

## Summary

| Package | Status | PR / commit | Notes |
| --- | --- | --- | --- |
| P00 baseline | in_progress | — | Baseline recorded below |
| P01 capabilities | pending | — | |
| P02 contracts/planner | pending | — | |
| P03 read-only adapter/CLI | pending | — | |
| P04 approval/control store | pending | — | |
| P05 credential generations | pending | — | |
| P06 executor/fake provider | pending | — | |
| P07 Neon hosted slice | pending | — | |
| P08 deployment/consumers | pending | — | |
| P09 rotation fault model | pending | — | |
| P10 hosted rotation | pending | — | |
| P11 Cloudflare | pending | — | |
| P12 Resend | pending | — | |
| P13 lifecycle operations | pending | — | |
| P14 SetupPlan/CI/upgrades/docs | pending | — | |
| P15 registry starter | pending | — | |
| P16 release qualification | pending | — | |

## External prerequisites (consolidated)

Hosted work cannot start without the following. Local and fake-provider work
continues regardless.

| Prerequisite | Needed by | Owner | Next action |
| --- | --- | --- | --- |
| Stripe Projects login (`stripe projects` reports `authenticated: false` on this host) | P07, P10, P11–P13 hosted, P15, P16 | Greg Mushen (account owner) | Run `stripe login` or provide an authorized sandbox account |
| Explicit sandbox authorization: Stripe account, Projects project/environment, allowed services (Neon `free` plan), budget (proposed $0, free tiers only), terms acceptance, cleanup disposition | P07 | Greg Mushen | Approve or decline the scoped request in the run log |
| Independent control-store PostgreSQL for hosted runs (not a tenant app DB) | P07+ | Greg Mushen | Name an existing approved database or authorize a free Neon project for it |
| Approved Cloudflare target for deployment proof | P08 hosted | Greg Mushen | Name the account/Worker target, or authorize a disposable one |
| Rotation of a disposable credential | P10 | Greg Mushen | Approve after P09 lands |
| npm publication / registry submission | P15, P16 | Greg Mushen | Separate release approval |

## P00 — Baseline

- Date: 2026-10-01. Host: macOS (Darwin 25.6.0), Node v26.8.1, pnpm 10.33.0.
- Main resolved: `a4c16afef6ae0234766d453f4e52fbc1adc03504`
  (matches the plan's pinned observation).
- Worktree: `/Users/gregmushen/work/code/trestle-stripe-projects`, branch
  `codex/stripe-projects-p00` from `origin/main`. The document-authoring
  checkout (`docs/admin-access-control-spec`, dirty, Fatima experiment) was not
  switched, reset, or staged.
- Package versions: `trestlejs` 0.1.0-beta.3, `create-trestlejs` 0.1.0-beta.3.
- Copied in: provisioning spec, implementation plan, agent prompt (not present
  on main; no newer versions to reconcile).
- Repository instructions: only `packages/create/template/AGENTS.md` exists
  (applies to generated applications / template edits).
- Branch protection: `main` reports "Branch not protected" via the GitHub API;
  the CI workflow `CI / check` is treated as the required check by policy.
- Layout check: schemas live in `packages/cli/src` (`manifest.ts`,
  `setup-plan.ts`, `plan.ts`); there is no `packages/core` on main.

Baseline results (all on `a4c16af`, disposable `postgres:17-alpine` container
bound to `127.0.0.1:56543`, never a shared or production database):

| Command | Result |
| --- | --- |
| `pnpm check` | pass — 35 files, 287 tests |
| `pnpm check:upgrade` | pass — alpha.135 → beta.1, two-tenant RLS verified |
| `pnpm check:customized-upgrade` | pass — beta.3 → beta.4 |
| `pnpm check:generated` | running (see below) |

Pre-existing failures: none observed so far.

Toolchain observed for P01: Stripe CLI 1.51.0 (Homebrew), Projects plugin
0.45.0 installed during P00/P01 discovery (`stripe plugin install projects`;
local only, no account effect). Not authenticated.
