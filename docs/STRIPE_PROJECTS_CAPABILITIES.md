# Stripe Projects Capability Matrix

P01 output for the [implementation plan](STRIPE_PROJECTS_IMPLEMENTATION_PLAN.md).
Observed 2026-10-01. Every cell is scoped to the toolchain below. A change of
tool version, catalog contents, or observed behavior invalidates affected rows
until re-tested (spec §7, AR-14).

## Toolchain under test

| Item | Value |
| --- | --- |
| Stripe CLI | 1.51.0 (Homebrew), sha256 `47343eb86017b5b8bb65010de31f8b7b880b865e3c3fd3623ec045fe7cef19d4` |
| Projects plugin | 0.45.0 at `~/.config/stripe/plugins/projects/0.45.0/stripe-cli-projects`, sha256 `187cbb898aed495a54aa357b29d71234105c15d29e1ec195019cc570d9b3bf77` |
| JSON envelope | `{ ok, command, version: "0.1", data | error{code,message}, warnings, next_steps, meta }` |
| Authentication on this host | 2026-10-01: authenticated to a Stripe **test-mode sandbox** (MyScribbl, Inc.); Projects requires live-mode context (below) |

Sources: installed `--help` output for every subcommand, `catalog <provider>
--json`, `status --json`, and [docs.stripe.com/projects](https://docs.stripe.com/projects).
Sanitized fixtures: `packages/cli/test/fixtures/stripe-projects/0.45.0/`.

Evidence statuses follow spec §7: `documented`, `locally_tested`,
`hosted_verified`, `unsupported`, `unknown`. No row is `hosted_verified`.

## Command side-effect inventory

Effects marked **local write** happen in the process working directory.

| Command | Remote effect | Local effects (observed or documented) | Trestle use |
| --- | --- | --- | --- |
| `catalog [p] --json` | none (read) | **local write**: creates `.gitignore` (appends `.projects/cache`, `.projects/vault`, test state files, `.env`, `.env.*`), `.projects/cache/catalog.json` (~500 KB), `.projects/cache/minimum-version.json` — locally_tested | Allowed only in an isolated scratch directory |
| `search <q> --json` | none (read) | assumed same cache writes — unknown | Isolated scratch only |
| `status --json` | none (read) | returns `NO_PROJECT_CONFIG` without a project — locally_tested | Isolated workspace |
| `list`, `services list`, `env list/show`, `variables list`, `spend`, `billing show` | none (read), requires auth | unknown | Isolated workspace, not yet exercised |
| `init` | creates a Stripe project; may create provider/account state with `--from`/templates | writes `.projects/state*.json`, `.gitignore`, and AI skill files (`.agents/`, `.claude/`, `.cursor/`, `AGENTS.md`, `CLAUDE.md`) unless `--skip-skills`; guided/template modes run a post-init install command unless `--skip-install` — documented | Mutation; always `--skip-skills --skip-install --mode manual`, isolated workspace |
| `pull <projectId>` | none documented | writes state files **and plaintext `.env`** via automatic `env --pull` — documented | Credential-bearing; private temp workspace only |
| `link <provider>` | grants provider account association; may create a provider account | state writes — documented | Security-sensitive grant (spec §13) |
| `add <svc>` | provisions a resource; may link/create provider account; may charge if paid | state writes + **automatic `env --pull` to plaintext output file (mode 600)** + vault — documented | Mutation with bundled credential write (AR-05) |
| `add --preflight` | none claimed ("without provisioning") | unknown | Candidate read-only precondition probe; unverified |
| `rotate <res>` | rotates resource credentials | **automatic `env --pull`** — documented | Rotation unit and invalidation unknown → blocked |
| `upgrade` / `downgrade` / `update` | changes service tier/plan; may charge | automatic `env --pull` — documented | Tier change; paid authorization required |
| `remove <res>` | **deprovisions the provider resource** | does not delete prior `.env`/vault credentials — documented | Destructive; never used for detach |
| `remove --only-credentials` | "unlink credentials" for resource | unknown | Semantics unproven; not a revocation proof |
| `remove --untrack` | none ("without contacting the provider") | drops local record | Local-only untrack; not detach proof |
| `unlink <provider>` | removes provider association | unknown | Account unlink, distinct from deletion |
| `env create/use/update/delete`, `env add/remove` | membership/environment definitions | active environment stored per checkout in `state.local.json`; membership changes trigger `env --pull` — documented | Mutable active state → isolated workspace with pre/post identity check |
| `env --pull` | none | writes plaintext output + vault — documented | Credential import source (P05), private temp dir |
| `variables set/delete` | stores/deletes values in Stripe Secret Store | syncs output file — documented | Not used: application-owned secrets stay in Trestle (spec §15) |
| `open <provider>` | none | launches a browser | Trestle validates URL itself; does not shell out |
| `billing add/update` | payment method / spend limit | — | Never automated |

Global behavior: no `--env` flag exists on any mutation; mutations target the
checkout's active environment (documented). `--json` suppresses prompts but does
not guarantee secret-free local files. `--debug` enables Stripe API request
logging and must never be passed. `--accept-tos` and `--confirm-paid-service`
are terms/spend acceptance and are never passed without the recorded human
authorization (spec §12).

## Provider/service matrix (catalog 2026-10-01)

Provider capabilities and `existing_resource_linking` come from
`catalog <provider> --json`. `livemode: true` for all listed services.

| Provider | Catalog capabilities | Existing-resource linking | Services (`service_id`, kind, scope, pricing) |
| --- | --- | --- | --- |
| Neon | `resources:deprovision`, `resources:update_service` | unsupported | `free` plan/project/free; `launch` plan/project/paid; `postgres` deployable/project/component |
| Cloudflare | `resources:deprovision` | unsupported | `workers:free` plan/free; `workers:paid` plan/paid; `workers`, `kv`, `d1`, `queues`, `hyperdrive`, `workers-ai`, `browser-run`, `containers` deployable/component; `r2:bucket` deployable/paid; `registrar:domain` deployable/paid |
| Resend | `resources:deprovision`, `resources:update_service`, `account_entitlements:materialize` | unsupported | `free` plan/**account**/free; `pro` plan/**account**/paid; `email` deployable/project/component |

Notably absent from the Cloudflare catalog: Pages, Workflows, routes, custom
domains other than registrar purchase, and Worker deployment itself.

## Operation matrix

| Operation | Neon | Cloudflare | Resend | Evidence / blocker |
| --- | --- | --- | --- | --- |
| Discovery (catalog) | supported | supported | supported | locally_tested |
| Link provider account | documented | documented | documented | unknown whether link can create accounts silently; requires approved plan |
| Create resource | documented (`neon/postgres` with `free` plan) | documented per deployable | documented (`resend/email`) | hosted unverified; needs auth + authorization (P07) |
| Adopt existing resource | **unsupported** | **unsupported** | **unsupported** | catalog `existing_resource_linking: unsupported` → Trestle adoption uses direct extension or remains blocked (P13) |
| Inspect / status | documented | documented | documented | requires auth |
| Delete resource | documented (`remove`) | documented | documented | destructive; no exact-ID targeting flag (name or provider/service) → AR-11 risk; blocked until exact identity proof |
| Non-destructive detach | unknown (`--untrack` is local-only) | unknown | unknown | blocked (spec §22) |
| Credential retrieval | documented (dotenv + vault) | documented | documented | plaintext dotenv only; no structured secret channel found |
| Credential rotation | documented command | documented command | documented command | invalidation timing, overlap, bundle unit, re-retrieval after response loss: **unknown** → D-05 blocks unattended rotation |
| Tier change | documented (`free`↔`launch`) | documented (`workers:free`↔`workers:paid`) | documented (`free`↔`pro`, account-wide) | paid; requires cost authorization; Resend tier is account-scoped blast radius |
| Environment scoping | active-env state | active-env state | active-env state | no per-command `--env`; isolated workspace required (spec §11) |
| Unattended auth | unknown | unknown | unknown | `--api-key`/`STRIPE_API_KEY` exists globally; scope and renewal unproven |
| Idempotency / response-loss | unknown | unknown | unknown | no idempotency flag; `--resource-id` resume exists for `add` with `--resource-info` |

## Open probes

| Probe | Status | Owner | Next step |
| --- | --- | --- | --- |
| Authenticated read commands (`list`, `services list`, `env list`) output schemas | unknown | Provider maintainer | Run in isolated dir after `stripe login`; capture sanitized fixtures |
| `add --preflight` has no remote side effect | unknown | Provider maintainer | Observe in authorized sandbox with spend/state diff |
| Neon `free` create → identity fields, outputs, endpoint type (direct/pooled) | unknown | Provider maintainer | P07 sandbox |
| Rotation semantics per provider | unknown | Provider maintainer | P10 sandbox on disposable resource only |
| `remove --only-credentials` effect | unknown | Provider maintainer | P13 sandbox |
| CI token scopes | unknown | Release maintainer | P14 |
| Executable signing provenance (beyond sha256 pin) | unknown | CLI maintainer | Check plugin distribution signatures; until then pin sha256 |

## Hosted observations (2026-10-01, test-mode sandbox login)

| Probe | Result | Consequence |
| --- | --- | --- |
| `projects list --json` with a test-mode CLI context | `PROJECTS_CONTEXT_MISMATCH` (`active_context_livemode: false`, `requested_livemode: true`) | Projects reads and project creation require **live-mode** Stripe credentials; a test sandbox alone cannot exercise Projects |
| `projects init --testmode --preflight` | `INVALID_ARGUMENT`: `--testmode` on `init` requires `--from` in manual mode | Test-mode resources exist only for `add --testmode` and shared-stack imports; the Projects project itself lives in a live account |
| `stripe sandbox create` restricted key with `STRIPE_API_KEY` | `403 forbidden`, needs `provisioning_project_read` | Unclaimed sandbox keys cannot call Projects |

Hosted qualification therefore needs explicit authorization to use a live-mode
Stripe account context (no charges for free plans, but real provider accounts
and a real Projects project). It has not been granted; nothing was created.

## Hosted qualification run (2026-10-02, live-mode account, free plan only)

Authorized scope: MyScribbl, Inc. live account, one Projects project
(`trestle-sp-test`), Neon `free` plan, $0, Neon terms accepted, test resources
removed afterwards. Toolchain: Stripe CLI 1.51.0, plugin 0.45.0 (pinned hash).

| Step | Observation |
| --- | --- |
| Account onboarding | `init` first returned `ACCOUNT_NOT_ELIGIBLE` until Projects was enabled in the dashboard (browser step), then required `--yes` to confirm the merchant |
| `link neon --accept-tos` | Completed **without a browser** and created a Neon account (`link_action: created`) |
| `add neon/postgres --preflight` | No side effects; reported ToS, provider link and a required plan (`neon/free`) |
| `add neon/free`, `add neon/postgres --name database` | Outputs prefixed by the logical name (`DATABASE_CONNECTION_STRING`, `DATABASE_PROJECT_ID`, …); the automatic pull renamed `NEON_ORG_ID` to `NEON_PLAN_ORG_ID`; response includes `files_modified`; identity is `data.service.key` (`fres_…`) |
| Connection string | Direct endpoint, `sslmode=require`, role `neondb_owner` with **BYPASSRLS** and **CREATEROLE** |
| Repeated `add` with the same name | **Not idempotent**: created a second database named `database-2` (removed) |
| `rotate database` | Only `DATABASE_CONNECTION_STRING` changes; new connections with the old password fail with `28P01` immediately; an existing pooled connection keeps working; `env --pull` re-retrieves the new value |
| `remove <name>` | Targets a name, not an immutable ID; rewrites the output file |
| `unlink neon` | Deletes the provider connection; the Neon account itself remains |

Evidence through Trestle itself:

- `trestle infra apply` created and bound a Neon database (`tdb`) with a signed
  approval against a PostgreSQL control store, imported its outputs into an
  operator-only v2 snapshot, removed the plaintext output, and on replay of the
  same approval resumed with no effect (one `tdb`; control-store dump contained no
  connection strings).
- Least-privilege runtime role with forced RLS on the real database: tenant A saw
  only its rows, cross-tenant insert denied (`42501`), tenant B isolated, no rows
  without tenant context, runtime role cannot disable RLS.
- Rotation through Trestle's engine with the qualified profile: the first run
  exposed a bug (stable identifier outputs were required to change) and stopped at
  `outcome_unknown` without re-issuing; after the fix, resume recovered the issued
  credential by re-retrieval, committed generation 2, proved retirement with
  `28P01` plus a working new-key control, and retired generation 1.

Remaining owned resources: the empty Projects project `trestle-sp-test` (no
delete command in 0.45.0) and the empty Neon account created by `link`.

## Hosted run: Resend and Cloudflare (2026-10-02, free plans, no email sent)

| Step | Observation |
| --- | --- |
| `link resend --accept-tos` | Created a Resend account **without a browser step** and materialized the account-wide `free` plan (a later `add resend/free` failed with `resource_count_constraint_exceeded`) |
| `add resend/email --name email` | Output `RESEND_API_KEY` (not prefixed by the resource name) |
| Resend key scope | **Full account access**: `GET /domains`, `/audiences` and `/api-keys` all return 200. Operator-only; never a Worker key |
| `rotate email` | Value changes; old key rejected immediately with `400 validation_error "API key is invalid"` (same as a made-up key; a missing key is `401 missing_api_key`); `env --pull` re-retrieves the new key |
| `link cloudflare --accept-tos` | Requires browser authentication (`BROWSER_AUTH_REQUIRED` with a Cloudflare authorize URL); completed by the account owner |
| `add cloudflare/workers:free`, `add cloudflare/workers --name worker` | Outputs are non-secret only: `WORKER_ACCOUNT_ID`, `WORKER_API_BASE_URL` (`api.cloudflare.com/client/v4`), `WORKER_DASHBOARD_URL`, `WORKER_PLAN_SERVICE_ID`, `WORKER_WORKERS_DEV_SUBDOMAIN`, `CLOUDFLARE_PLAN_ACCOUNT_ID`. **No deploy token** |
| `rotate worker` | `provider_failure`: `404 Route not found` (nothing to rotate) |

Consequences: resend/email `create` and `rotate` are hosted-verified with the key
marked owner-privileged; cloudflare/workers `create` is hosted-verified and
`rotate` unsupported. Deploying a Worker still needs direct Cloudflare
authentication, because Projects issues no deploy credential.
