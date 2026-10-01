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
| P00 baseline | complete | #226 | Baseline recorded below |
| P01 capabilities | partial | P01 PR | Read-only matrix, fixtures, D-01/D-05; authenticated and hosted probes blocked on login |
| P02 contracts/planner | complete | P02 PR | Schemas, canonical digests, pure planner |
| P03 read-only adapter/CLI | complete | P03 PR | R1 read-only surface; mutations registered as unavailable |
| P04 approval/control store | complete | P04 PR | Local exit (simulation) met; hosted enrollment pending |
| P05 credential generations | complete | P05 PR | v2 envelope + CAS commit; public pull still unavailable |
| P06 executor/fake provider | complete | P06 PR | Fake-provider crash/concurrency gates pass; real apply still gated by capability evidence |
| P07 Neon hosted slice | blocked | — | Needs Stripe login + sandbox authorization + control DB (see prerequisites) |
| P08 deployment/consumers | partial | P08 PR | Consumer registry, projection, generation proof against fakes; hosted proof blocked on P07 |
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
| `pnpm check:generated` | pass — generated release canary (≈25 min) |

Pre-existing failures: none.

Discrepancy: the spec links `PROOF_ORIENTED_ENGINEERING_SPEC.md`, which is not on
main (it exists only as untracked work in the authoring checkout). Not imported.

Toolchain observed for P01: Stripe CLI 1.51.0 (Homebrew), Projects plugin
0.45.0 installed during P00/P01 discovery (`stripe plugin install projects`;
local only, no account effect). Not authenticated.

## P01 — Capability and side-effect matrix

- Status: **partial**. Local exit met: reviewed matrix, complete side-effect
  descriptors, sanitized fixtures, version-mismatch handling. Authenticated read
  schemas and every hosted behavior remain `unknown` (no Stripe login on this host).
- Artifacts: `docs/STRIPE_PROJECTS_CAPABILITIES.md`,
  `docs/decisions/D-01-projects-toolchain.md`, `docs/decisions/D-05-issuance-recovery.md`,
  `packages/cli/test/fixtures/stripe-projects/0.45.0/`,
  `packages/cli/src/infra/capabilities.ts`, `capability-matrix.ts`.
- Key findings: `catalog` (read) writes `.gitignore` + `.projects/cache` into its
  cwd; no `--env` flag on any mutation (active environment is per-checkout state);
  `add`/`rotate`/`upgrade`/membership changes auto-write plaintext dotenv;
  `existing_resource_linking: unsupported` for Neon, Cloudflare, Resend; Resend
  plans are account-scoped; rotation invalidation/overlap/re-retrieval undocumented.
- Tests: `infra-capabilities.test.ts` 9/9. Mutation check: three deliberate
  weakenings (mutation allowed with documented evidence, toolchain drift ignored,
  expiry disabled) each turned the suite red; one surviving mutant led to an added
  assertion.
- Next: authenticated read fixtures and sandbox probes once login/authorization exist.

## P02 — Contracts and deterministic planning

- Status: **complete** (pure planning; no mutation path exists).
- Modules: `infra/schema.ts` (intent `.trestle/infrastructure.yaml`, bindings,
  observations; parsed independently of SetupPlan v1), `infra/canonical.ts`
  (sorted-key canonical JSON, sha256 digests), `infra/redaction.ts`
  (content-based credential detection), `infra/planner.ts`.
- Behavior: dependency ordering with cycle/unknown rejection; unresolved create
  targets `pending:<op>`; account/project/environment drift blocks; bound
  resource missing from a complete observation blocks (no recreate); incomplete
  discovery proves nothing; same-name unbound resource is not identity;
  undeclared cross-environment sharing blocks; orphans reported, never deleted;
  component pricing without a catalog plan and account-scoped plans require cost
  authorization (unknown cost is never free); offline plans are stale and never
  executable; secret values rejected in intent and bindings.
- Tests: `infra-planner.test.ts` 21, `infra-redaction.test.ts` 3 (includes a
  200-graph property test of operation order). `pnpm check`: 38 files / 320 tests pass.
- Review finding fixed: a bound resource with blockers could stay `no_change`;
  now any blocker forces `blocked` (covered by an ownership-handoff test).

## P03 — Safe process adapter and read-only CLI

- Status: **complete** — R1 read-only surface. All mutation commands are
  registered but exit 2 with their gate (`link`, `adopt`, `apply`, `rotate`,
  `upgrade`, `detach`, `destroy`, `credentials pull`, `operation resume`).
- Process boundary (`infra/process.ts`): absolute executables only, argument
  allowlist (no whitespace/metacharacters/control chars), caller-supplied env,
  process-group kill on timeout or output overflow.
- Adapter (`infra/adapters/stripe-projects.ts`): the plugin is a go-plugin gRPC
  server (observed), so the adapter runs the `stripe` host by absolute path after
  checking file ownership/permissions, verifies the pinned plugin sha256 and the
  active plugin version, runs reads in a removed scratch directory with
  `HOME`, fixed `PATH`, telemetry opt-out only, accepts only envelope `0.1`,
  treats any unexpected file write (e.g. `.env`) by a read as failure, and
  redacts provider errors by content.
- Endpoint validation (`infra/endpoints.ts`, AR-12): Neon host suffix, port 5432,
  mandatory `sslmode=require|verify-full`, no redirecting options; provider API
  hosts over https without embedded credentials; dashboard allowlist for `open`.
- CLI (`trestle infra`, experimental): `init` (local files + `.gitignore` only),
  `catalog [--live]`, `plan` (persisted 0600, secret-free), `status` (never
  contacts providers; remote state reported as unknown, not empty), `doctor`
  (read-only; `pass/fail/unknown/not_applicable`; active verification reported as
  unknown), `open`, `operation show`.
- `trestle doctor` integration: `infra.intent.valid` asserts configuration
  validity only and points to `trestle infra doctor`.
- Tests: `infra-process.test.ts` 5, `infra-readonly.test.ts` 19 (fake `stripe`
  host with call log; zero mutating calls from plan/status/doctor/catalog; real
  built-CLI process test). `pnpm check`: 40 files / 344 tests pass.
- Review findings fixed: YAML syntax errors quoted source lines (could leak a
  secret) — now position-only and redacted, with a regression test; synchronous
  throw from the runner on unsafe args converted to rejection.
- Limitation: authenticated `status` schema is unobserved, so plans are always
  stale (never executable) until live observation parsing lands with hosted access.
- Operational incident during this package: a broad `pkill` used to clear a hung
  shell command stopped Docker Desktop and three unrelated local containers
  (`cbr-local-*`); Docker and those containers were restarted and verified running.

## P04 — Trusted approval and durable control state

- Status: **complete** for the plan exit ("AR-01/02 controls proven in
  simulation"). Remote mutation remains disabled. Hosted enrollment of a real
  control database is an external prerequisite (see table above).
- Decisions: `docs/decisions/D-02-control-store.md`, `D-03-approval-identity.md`.
- Modules: `infra/approvals.ts` (Ed25519 canonical approvals bound to plan,
  source, artifact, target, effects, cost limit, expiry, approver, nonce),
  `infra/store.ts` (contract), `infra/stores/rules.ts` (shared decision rules),
  `infra/stores/memory.ts` (tests only; `kind: "memory"`),
  `infra/stores/postgres.ts` (schema `trestle_infra`; append-only journal enforced
  by trigger; row locks + advisory locks; fencing sequence; CAS generations;
  logical export/import that refuses to merge into a non-empty store).
- New dependency: `postgres@3.4.9` (already used by the template and repo scripts).
- New scripts: `pnpm check:infra` (all infra unit tests), `pnpm check:infra-recovery`
  (PostgreSQL contract + multiprocess tests; fails if the disposable database URL is
  missing). CI runs `check:infra-recovery` against the job's postgres service.
- Tests: one behavioral contract (`test/helpers/store-contract.ts`, 8 cases) runs
  against both stores; plus approval binding, reservation rule enumeration,
  database-level journal immutability, and separate-process races (8 reservers →
  1 acquired; 8 generation writers → 1 commit; 6 approval consumers → 1 consumed,
  5 resume) and the AR-02 delayed-completion-after-lease-loss scenario across
  processes. Integration suite passed 6 consecutive runs locally.
- Results: `pnpm check` 42 files / 356 tests pass (integration skipped without DB, by design);
  `check:infra-recovery` 14/14 against disposable `postgres:17-alpine`.
- Review findings fixed: memory restore merged into a non-empty store; restored
  stores could reissue fencing tokens (high-water mark added); concurrent first
  connections raced on DDL (migration serialized by advisory lock).

## P05 — Credential generations and compatibility

- Status: **complete**. Public `trestle infra credentials pull` stays unavailable
  until P06 coordinates it with approvals/reservations (plan requirement).
- Decision: `docs/decisions/D-04-credential-envelope.md`.
- Module `infra/credentials.ts`: v2 envelope (AES-256-GCM; AAD = canonical
  `{schema, version, projectId, environment, purpose, generation, metadata}`),
  commit via control-store CAS (`credentials:<project>:<env>:<purpose>`) so
  ciphertext and metadata commit atomically; digest check on read; master-key
  re-encryption as a new generation; strict dotenv parser (character scanner, no
  evaluation); protected import (isolated workspace, no symlinks, confinement,
  owner and 0600 checks, never the application root, missing/undeclared/colliding
  outputs rejected — AR-05); adapter-owned cleanup with reported debt; merge rules
  (application-owned preserved, override conflicts need an explicit choice,
  editing a provider value marks a visible override).
- Unchanged: `trestle secrets` v1 files, editor (`$VISUAL`/`$EDITOR`/vi), show/get
  export and `secrets key rotate`. v1 reader rejects v2 envelopes (no silent
  downgrade).
- Tests: `infra-credentials.test.ts` 18. Mutation check: dropping metadata from
  AAD, disabling the undeclared-output check, the permission check, or the
  override check each turned the suite red. `pnpm check`: 43 files pass.

## P06 — Executor and exhaustive fake-provider recovery

- Status: **complete** for the plan exit (all fake-provider adversarial cases for
  the initial provisioning path pass). Real apply is wired but remains blocked by
  capability evidence until P07 qualifies a hosted tuple.
- Executor (`infra/runner.ts`): verifies plan digest and source digest, requires a
  PostgreSQL store (memory only in simulation), uses the control-store binding
  generation over repository copies, re-observes and rejects identity or material
  drift, checks approval coverage, records/consumes the approval, journals intent
  before each effect, fences effects with `beginEffect`, classifies outcomes
  (`succeeded`, `blocked`, `failed_retryable`, `failed_terminal`,
  `outcome_unknown`, `needs_intervention`; exit codes 0/2/1/1/3/4), binds exact IDs
  by CAS, imports declared credentials into v2 snapshots, removes adapter plaintext,
  and never compensates automatically.
- Recovery: lost response → reservation stays uncertain → resume binds the resource
  found by observation; absence after an in-flight request is **not** proof
  (AR-02) and needs `operation resume --confirm-absent <reason> --actor <name>`;
  incomplete discovery never proves absence; retryable provider rejections back off
  on the injected clock.
- Fake provider: stateful `stripe` host whose remote state lives outside runner
  processes, with per-command fault injection (crash, hang, lost response, error)
  and exact effect counters.
- CLI: `infra apply`, `infra approve` (key outside project, 0600), `infra approver
  keygen|register`, `infra operation resume`. `apply` requires
  `TRESTLE_INFRA_CONTROL_DATABASE_URL` and a linked workspace.
- Tests: `infra-runner.test.ts` 32 (crash at 9 boundaries × 2 resources, replay,
  tamper, drift, stale binding generation, lost response, AR-02, incomplete
  discovery, backoff, terminal rejection, no compensation, lease loss, revoked
  approver on resume); `infra-crash.integration.test.ts` 6 (real SIGKILL at 6
  boundaries, resumed by a second process against PostgreSQL);
  `infra-cli-apply.test.ts` 3. `pnpm check` 45 files / 408 tests;
  `check:infra-recovery` 23/23.
- Review findings fixed: (1) **security** — resuming with an already-consumed
  approval skipped revocation/expiry checks; consumption now re-checks current
  authority for same-operation replay (store contract updated); (2) intent edits
  that only changed dependencies passed drift checks; source digest now required;
  (3) a crash after the binding commit skipped credential import; completion is now
  an explicit journal event; (4) absence-based reconciliation could duplicate an
  in-flight create; now requires operator confirmation; (5) slow calls could
  outlive their lease and crash on release.
- Limitations: the real authenticated `status` schema and `add` semantics for plan
  selection (`neon/free` vs `neon/postgres`) are unverified; the Projects vault cache
  (`.projects/vault`) remains in the isolated workspace by upstream design.

## P07 — Neon hosted provisioning vertical slice

- Status: **blocked**. External prerequisites (owner: Greg Mushen): authenticated
  Stripe Projects session on the executing host; explicit sandbox authorization
  naming the Stripe account, Projects project/environment, the Neon `free` plan,
  a $0 budget, provider terms acceptance and cleanup disposition; an independent
  PostgreSQL control store; a disposable deployment target.
- Ready locally: executor, approvals, control store, credential import, endpoint
  validation and fake-provider proof (P04–P06). The real `status` schema and
  `add` plan-selection semantics must be observed first; capability rows stay
  `documented` until then.
- Next action once authorized: authenticated read fixtures (`status`, `list`,
  `services list`), `add --preflight` side-effect check, then one `neon/postgres`
  create through `trestle infra apply` with hosted evidence recorded, runtime role
  derivation, forced RLS and two-tenant denial.

## P08 — Deployment handoff and consumer generation proof

- Status: **partial** — local exit met against fakes; hosted proof depends on P07.
- Modules: `infra/consumers.ts` (consumer registry from the manifest and intent;
  per-consumer projection; operator-only never projected to application
  consumers; non-secret generation marker), `infra/deployment.ts` (reviewed host
  target check before projection; per-consumer revision + generation + fresh
  connection verification; partial host update recorded; deployment record
  committed by CAS with `managementPath: not_required`; retired generations
  refused; `verificationCurrent` requires re-verification after config drift, a
  new generation or a new artifact).
- Template: Worker `/api/health/operational` reports `credentialGeneration` only
  when it matches a strict non-secret format (`TRESTLE_CREDENTIAL_GENERATION`),
  with a Worker test proving a hostile value is not echoed.
- Tests: `infra-deployment.test.ts` 10 (wrong Worker/admin target, old replica
  200, old generation on the right revision, pooled connection, rate limit and
  network failure, partial host update, retired-generation rollback, config
  drift, management vs data-plane outage).
- Limitation: no real `ConsumerDeployer`/`ProbeRunner` against Cloudflare yet; the
  existing `secrets push` path is not yet wrapped (needs a hosted target).
