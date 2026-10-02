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
| P07 Neon hosted slice | complete | P07 PR | Real `trestle infra apply` created and bound Neon through Projects; RLS proven with a runtime role |
| P08 deployment/consumers | complete | #243, #244 | Wrangler deployer + health probe; generated Worker verified on real Cloudflare; runtime rotation cut over |
| P09 rotation fault model | complete | P09–P13 PR | Simulated strategies survive the crash matrix; unsupported strategies make no issuance call |
| P10 hosted rotation | complete | P07 PR | neon/postgres rotation qualified; Trestle rotation recovered by re-retrieval and proved retirement |
| P11 Cloudflare | partial | Resend/Cloudflare PR | workers create hosted-verified (no deploy token issued); rotate unsupported; deployment not exercised |
| P12 Resend | partial | Resend/Cloudflare PR | email create + rotate hosted-verified; key is full-access (operator-only); no email sent; sender/domain still direct |
| P13 lifecycle operations | partial | P09–P13 PR | Exact-ID adopt/tier/detach/destroy planning with safeguards; execution blocked by capability evidence |
| P14 SetupPlan/CI/upgrades/docs | partial | P14–P15 PR | SetupPlan v2 reference, CI trust check, docs, skill; preview automation blocked on hosted access |
| P15 registry starter | blocked | P14–P15 PR | D-06: registry variant deferred (bootstrap provisions before Trestle approval and writes plaintext .env); manifest validator ready |
| P16 release qualification | blocked | — | Local gates pass on the final tree; no advertised mutation is qualified; publication needs authorization |

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

## P09 — Rotation state machine and fault proof

- Status: **complete** (plan exit: every supported simulated strategy survives the
  crash matrix; unsupported strategies produce no issuance call).
- Module `infra/rotation.ts`: rotation plans for the provider's real mutation unit
  (`bundle`), affected outputs and consumers, inventory completeness, and
  blockers for unknown invalidation, unknown bundle, immediate invalidation
  without proven re-retrieval (AR-03), undeclared sibling outputs (AR-05), overlap
  without a Projects revoke operation, and missing provider-specific retirement
  probes. `rotationPlanDocument` makes the rotation a digest-bound plan, so
  approvals bind the exact unit. Execution journals each state, issues at most
  once (a re-issue after an ambiguous request needs a recorded operator
  confirmation), recovers lost responses by re-retrieval, keeps the old value only
  in an encrypted recovery envelope under the environment master key, cuts over
  through P08 deployment proof, refuses to retire while any consumer is unverified
  or undrained (delayed jobs, AR-08), and retires only on provider-specific old-key
  rejection with a working new-key control (AR-07); retired generations can never
  be redeployed.
- `ROTATION_PROFILES` is empty: no tuple is qualified, so `trestle infra rotate`
  writes a blocked rotation plan.
- Tests: `infra-rotation.test.ts` 17 (blocking matrix with zero issuance calls;
  happy path; termination at 6 states; lost response; partial cutover; undrained
  jobs; inconclusive retirement; false 401 without control; replay; provider
  rejection; stale pull and rollback after rotation; mismatched approval).
  Mutation check: 5 deliberate weakenings each turned the suite red.

## P10 — Hosted rotation qualification

- Status: **blocked** on P07 hosted access and an authorized disposable credential.
  Rotation execution remains unsupported; no completion is claimed.

## P11 — Cloudflare

- Status: **partial**. `DIRECT_WRITERS` records the generated scripts that already
  write R2 buckets, Queues and Worker settings; the planner blocks a
  Projects-owned resource of those kinds until intent records
  `directWriterDisabled: true`. Generated scripts are unchanged and remain the
  owners. Gaps (no Pages, Workflows, routes or Worker deployment in the catalog)
  stay direct extensions. No per-operation hosted conformance exists.

## P12 — Resend

- Status: **partial**. Credentials projected to application consumers require a
  recorded `least_privilege` scope in capability evidence; Resend's account-wide
  key and Neon's owner URL are blocked from Workers until proven or derived.
  Sender/domain/webhook management remains in the existing direct
  `resend-status`/`resend-webhook` commands. Webhook signing-secret rotation is a
  separate rotation unit. No live email was sent.

## P13 — Adoption, tier changes, detach and destruction

- Status: **partial** (semantics proven locally; execution blocked by evidence).
- Module `infra/lifecycle.ts` and CLI `infra adopt|upgrade|detach|destroy`: exact-ID
  plans with safeguards. Adoption needs an exact ID verified in the bound account,
  no duplicate adoption, and a named previous writer. Tier changes need a fresh
  price within a declared limit, flag account-wide plans, label downgrades
  destructive and qualify tiers by provider. Detach stays blocked instead of
  using a deleting command. Destroy needs `deletionPolicy: delete`, exact-ID
  confirmation, a complete reference scan, drained work and verified restore, and
  refuses when the name now resolves to a replacement (AR-11).
- Tests: `infra-lifecycle.test.ts` 8; CLI planning test in `infra-cli-apply.test.ts`.

## P14 — SetupPlan, CI, upgrades and documentation

- Status: **partial**.
- SetupPlan: `schemaVersion: 2` adds only an optional `infrastructure` reference
  (`.trestle/infrastructure.yaml`, remote environments). Version 1 plans cannot
  carry it, `approved` fields stay rejected, external/destructive lists stay
  rejected, and a newer schema version reports "requires a newer trestle CLI".
  `trestle plan diff` lists infrastructure as `external` items from the same
  planner; `trestle apply` records them as handed off and performs no remote work.
- CI trust (`infra/ci-trust.ts`, surfaced as `ci.infra.trust` by `trestle ci
  validate` only when a workflow runs `trestle infra`): privileged commands
  (`apply`, `approve`, `operation resume`, `approver register`) must not be
  reachable from untrusted triggers (pull requests from forks or the same
  repository, `pull_request_target`, comments, `workflow_run`), must run in a
  protected environment, and must not install with lifecycle scripts, run
  application code, check out pull-request head code or interpolate event data.
  The control-store secret may not appear in untrusted-trigger workflows. Branch
  rules requiring review of workflow changes remain the primary control.
- Upgrades: infrastructure files are opt-in; upgrading the package never creates
  them, provisions, or moves credentials. v1 credential files are untouched; v2
  envelopes are rejected by older CLIs. The Worker health field (P08) and the setup
  skill section flow through the normal source upgrade.
- Docs: `docs/STRIPE_PROJECTS.md` (canonical guide describing only installed
  behavior), CLI README section, setup-skill section (both copies, parity test).
- Not done (blocked): preview identity/TTL/cleanup automation and protected CI
  apply/deploy/verify stages need a hosted target; `link` and public credential
  pull remain unavailable.
- Tests: `infra-setup-plan.test.ts` 4, `infra-ci.test.ts` 6.

## P15 — Materialized starter and registry path

- Status: **blocked (documented)** — see `docs/decisions/D-06-registry-bootstrap.md`.
  `stripe projects build` provisions before any Trestle approval and writes
  plaintext credentials (including an owner database URL) to `.env`, which
  conflicts with Trestle custody; exact-ID adoption of bootstrap resources is
  unsupported. No registry entry was submitted.
- Ready: `infra/registry.ts` generates and validates a manifest from one pinned
  release (40-character `ref`, recorded catalog service IDs, `--ignore-scripts`
  install, no provisioning in install, no TanStack Start mislabel, secret scan).
- Tests: `infra-registry.test.ts` 2.

## P16 — Production and release qualification

- Status: **blocked**. No provider operation is hosted-verified, so there is no
  advertised mutation to qualify, and npm publication / registry submission need
  explicit release authorization. Nothing was published; no production or hosted
  resource was created.
- Final local gates on `d655d1b` (all P00–P15 changes; disposable
  `postgres:17-alpine`): `pnpm check` pass (52 files, 458 tests);
  `release:check` pass; `release:pack` pass (local tarballs only);
  `check:infra-recovery` pass (23/23); `check:upgrade` pass;
  `check:customized-upgrade` pass; `check:generated` pass (first attempt failed
  on a database left dirty by an interrupted earlier run; passed on a recreated
  database).
- Tarball inspection: no `.env`, `.projects` or `.trestle/infrastructure.local`
  entries. The secret-pattern scan matched only pre-existing fake fixtures in
  template tests (`sk_live_sensitive`, `whsec_sensitive`, `whsec_notifications`,
  a base64 test key); no real credentials.
- Owned resources left behind: none remote. Local only: disposable Docker
  container `trestle-sp-pg`, Projects plugin 0.45.0 installed under
  `~/.config/stripe/plugins`, worktree `trestle-stripe-projects`.

## Adversarial finding coverage (AR-01–AR-15)

Each finding has a falsifiable test that fails if the control is removed. "Local"
means proven against fakes or a disposable local PostgreSQL; no finding has
hosted provider proof yet.

| Finding | Tests | Evidence level |
| --- | --- | --- |
| AR-01 approval tamper/replay | `store-contract` (single use, replay = resume, revoked on resume), `infra-store.test` (signature binds every field), `infra-runner` (replay, altered plan, uncovered effects, revoked approver), `infra-store.integration` (6 concurrent consumers → 1) | Local |
| AR-02 stale runner | `store-contract` (in-flight lease loss stays uncertain), `infra-store.integration` (cross-process delayed completion), `infra-runner` (absent-but-unproven create is not retried) | Local |
| AR-03 lost issued key | `infra-rotation` (immediate + unproven re-retrieval blocks before issuance; lost response recovered by re-retrieval; ambiguous request needs operator confirmation) | Local (hosted: P10 blocked) |
| AR-04 stale/cross-project snapshot | `infra-credentials` (envelope substitution, CAS), `infra-runner` (stale binding generation), `infra-rotation` (stale pull after rotation) | Local |
| AR-05 bundled effects | `infra-capabilities` (complete effect inventory), `infra-readonly` (adapter refuses mutating commands; unexpected `.env` write fails a read), `infra-credentials` (undeclared sibling outputs rejected), `infra-rotation` (undeclared bundle output blocks) | Local |
| AR-06 privileged build code | `infra-process` (only the supplied environment reaches children), `infra-ci` (untrusted triggers, missing environment, lifecycle scripts, app code, head checkout, interpolation) | Local (validator); hosted CI not exercised |
| AR-07 false health/retirement proof | `infra-deployment` (old replica, old generation, pooled connection, rate limit, network failure), `infra-rotation` (inconclusive probe, 401 without new-key control) | Local |
| AR-08 rollback and old jobs | `infra-deployment` (retired generation refused), `infra-rotation` (undrained jobs block retirement; rollback after rotation refused) | Local |
| AR-09 mutating doctor | `infra-readonly` (plan/status/doctor/catalog make zero mutating calls; doctor reports active verification as unknown) | Local |
| AR-10 registry bypass | D-06; `infra-registry` (manifest cannot provision in install; lifecycle scripts disabled) | Documented; registry deferred |
| AR-11 replaced deletion target | `infra-lifecycle` (name resolving to a replacement is refused; exact-ID confirmation) | Local (planning) |
| AR-12 malicious endpoint | `infra-readonly` (Neon host, TLS, port, redirecting options; API hosts) | Local |
| AR-13 unsafe compensation | `infra-runner` (terminal failure retains earlier resource; no `remove` effect ever) | Local |
| AR-14 stale capability evidence | `infra-capabilities` (version, hash, schema drift and expiry downgrade to unknown) | Local |
| AR-15 management/data-plane confusion | `infra-deployment` (deployment needs no Projects path; data-plane failure is unverified) | Local |

## Acceptance scenarios (spec §32)

| # | Scenario | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Local app without a Projects account | `pnpm check`, `check:generated` with no provider accounts; infra is opt-in | Local proof |
| 2 | Inspect supported operations and evidence | `trestle infra catalog`, `infra-capabilities`, `infra-readonly` | Local proof |
| 3 | Plan without creating resources or exposing credentials | `infra-readonly` (zero mutating calls, plan 0600 and secret-free) | Local proof |
| 4 | Provision Neon through Projects without duplicates | Hosted: `trestle infra apply` created `tdb`, replay resumed with no second create; fakes for crash matrix | **Hosted verified** |
| 5 | Least-privilege runtime access and forced RLS | Hosted: runtime role on the real Neon database, forced RLS, cross-tenant denial; owner URL proven BYPASSRLS | **Hosted verified** |
| 6 | Import into environment-bound encrypted storage | Hosted: real outputs imported to an operator v2 snapshot, plaintext removed | **Hosted verified** |
| 7 | Edit with vi and reveal without changing provider keys | `trestle secrets` unchanged; `infra-credentials` override rules | Local proof |
| 8 | Deploy the artifact with only declared credentials | Hosted: generated Worker received only the runtime credential via `trestle infra deploy`, verified by generation marker and fresh connection as `trestle_runtime` | **Hosted verified** |
| 9 | Rotate and verify every consumer | Hosted: `rotate-runtime` cut the deployed Worker over to generation 2, verified it, proved old-password rejection, retired generation 1 | **Hosted verified** |
| 10 | Observe old-key rejection | Hosted: old password `28P01`, new key accepted | **Hosted verified** |
| 11 | Recover interrupted provisioning and rotation | Crash matrix and SIGKILL locally; hosted rotation resumed by re-retrieval without re-issuing | **Hosted verified** (rotation) + local |
| 12 | Refuse account/environment drift | `infra-planner`, `infra-runner` | Local proof |
| 13 | Adopt without recreating | `infra-lifecycle` planning; Projects reports adoption unsupported | Blocked (provider capability) |
| 14 | Cloudflare/Resend through Projects with explicit extensions | Hosted: Resend email and Cloudflare Workers provisioned through Projects; Resend rotation qualified; Cloudflare deploy needs direct auth (extension) | **Hosted verified** (provisioning) |
| 15 | Authorize cost/tier changes without customer billing | `infra-lifecycle` tier planning, `infra-planner` cost rules | Local proof (planning) |
| 16 | Retain or remove per lifecycle policy | `infra-lifecycle` destroy planning | Execution blocked (exact-ID delete unproven) |
| 17 | Serve during a Projects outage | `infra-deployment` (no Projects path in deployment) | Hosted unverified |
| 18 | Secret-free evidence; unknown distinct from pass | `infra-readonly` doctor/status, runner store scans | Local proof |
| 19 | Reject altered/replayed approval and source escalation | AR-01 tests, `infra-setup-plan` (v1 cannot gain infrastructure), `infra-ci` | Local proof |
| 20 | Response-loss and stale-runner safety | AR-02/AR-03 tests | Local proof |
| 21 | Prevent old deployments or pulls from restoring retired keys | AR-04/AR-08 tests | Local proof |
| 22 | Distinguish Projects bootstrap from Trestle approval | D-06 | Blocked (registry deferred) |

## P07 and P10 — hosted results (2026-10-02)

- P07 **complete**: see "Hosted qualification run" in
  `docs/STRIPE_PROJECTS_CAPABILITIES.md`. Code changes from evidence: real `status`
  parser (`parseStatus`, real fixtures), created identity from `data.service.key`,
  `ignoredOutputs` for reviewed non-secret outputs, neon/postgres `create`/`inspect`
  hosted-verified with `*_CONNECTION_STRING` marked owner-privileged.
- P10 **complete** for the single qualified tuple neon/postgres at plugin 0.45.0
  (`rotationProfileFor`). Bug found by hosted run and fixed: rotation required
  stable identifier outputs to change; now only the profile bundle must change
  (`RotationPlan.rotates`), with a regression test. Response-loss recovery was
  exercised for real (issued, not committed, resumed by re-retrieval, one issuance).
- Still blocked: P08 hosted deployment (no Cloudflare target authorized),
  P11/P12 hosted conformance, P13 exact-ID deletion (Projects `remove` takes a
  name), P15 registry, P16 publication.
- Cleanup: Neon databases `tdb`, `database`, accidental `database-2` and the
  `neon-plan` removed; Neon unlinked; local plaintext outputs, vault caches, test
  master key, approver key and the local control database deleted. Left: empty
  Projects project `trestle-sp-test` (no delete command), empty Neon account, an
  expiring unclaimed Stripe sandbox (`acct_1ULdNYDs6h0xbR0K`, 2026-10-08), and this
  CLI logged in to the MyScribbl live account.
- Incidents: the sandbox `rkcs_test_` key and two disposable scratch keys (test
  master key, local approver key) were printed once in command output; all were
  deleted, and redaction now covers the `rkcs_` prefix (#236).

## Migrations wiring and real deployer (2026-10-02)

- `trestle infra database setup` (#243): template Drizzle migrations and role
  scripts run with the operator-only owner credential (scratch HOME, database
  variables only); only the verified runtime credential is committed for Workers.
- `trestle infra deploy` (#243, #244): `WranglerDeployer` (`wrangler secret bulk`,
  values on stdin) and `OperationalHealthProbe` (generation marker plus a fresh
  connection that must report the runtime role); bounded re-probe window for edge
  propagation.
- `trestle infra database rotate-runtime` (#243): accepted interruption window,
  new password sealed in a recovery envelope before issuance (resume reuses it),
  cutover through the deployer, `28P01` rejection proof, old generation retired.
- `trestle infra apply` provisions declared plans before services (#244).
- Hosted proof: see "Hosted end-to-end app run" in the capabilities doc.
- Limitation: placeholder values were used for the generated Worker's unused
  Resend/Stripe secrets in the disposable test; real apps supply their own.
