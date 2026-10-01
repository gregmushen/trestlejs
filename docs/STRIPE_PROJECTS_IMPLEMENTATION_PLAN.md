# TrestleJS Stripe Projects Implementation Plan

**Status:** Planning complete — implementation not started

**Date:** 2026-10-01

**Authority:** [Provisioning specification v0.2](STRIPE_PROJECTS_PROVISIONING_SPEC.md)

**Review baseline:** All 15 adversarial findings in specification section 35.

## 1. Outcome and scope

Implement Stripe Projects as Trestle's preferred backend for every supported,
verified infrastructure lifecycle operation. Retain direct-provider extensions
for named capability gaps. Preserve local development, existing deployments,
encrypted secret editing/reveal, and the customer billing boundary.

Deliver the capability in small tested PRs. Read-only functionality ships first.
Remote mutation stays disabled until approval, durable state, identity,
credential handoff, and recovery gates pass. Rotation ships separately from
creation and is qualified per provider operation, not globally.

This plan does not claim the new commands exist. It does not provision anything,
authorize purchases, rotate keys, publish a package, or submit a registry entry.
Implementation tickets below are pending. Planning completion means the work,
dependencies, decisions, and evidence gates have been defined.

## 2. Repository baseline and implementation starting point

Read-only inspection on 2026-10-01 found:

- The working checkout is `docs/admin-access-control-spec` at `9bc7211`, with
  alpha.31 package metadata and unrelated uncommitted work, including a Fatima
  secrets experiment. Do not base implementation on this old branch or stage
  its unrelated files.
- GitHub `main` resolves to `a4c16afef6ae0234766d453f4e52fbc1adc03504` at planning
  time. Re-resolve it before implementation; this is a pinned observation, not
  a claim that main will remain there.
- The reusable beta-upgrade worktree at `8bf806d` is also older than that remote
  main. It can be a workspace after normal branch preparation, not a current
  implementation baseline by assumption.

Verified mainline integration points:

| Existing path | Reuse or compatibility requirement |
| --- | --- |
| `packages/cli/src/cli.ts`, `runtime.ts` | Register the infrastructure namespace with injectable runtime boundaries; keep business logic out of the command registry |
| `packages/cli/src/manifest.ts`, `setup-plan.ts`, `plan.ts` | Use current CLI-owned schemas; do not design against the older `packages/core` layout |
| `packages/cli/src/setup-plan.ts` | Schema v1 rejects nonempty external/destructive operation lists; preserve that behavior |
| `packages/cli/src/secrets.ts` | Existing AES-GCM credentials bind to environment, not project/generation; support a versioned migration rather than claiming stronger existing guarantees |
| `packages/cli/src/providers.ts` | Existing provider configuration/readiness inspection is not an infrastructure lifecycle engine; reuse presentation where safe, not its configurable probe URLs as privileged authority |
| `packages/cli/src/evidence.ts` | Reuse release-ledger integration; its application-owned command execution is not an approval authority or privileged provisioning runner |
| `packages/cli/src/doctor.ts`, `structured-output.ts` | Integrate structured results without converting unknown/blocked infrastructure evidence into pass |
| `packages/cli/src/wrangler-config.ts`, `ci.ts` | Reuse host targeting and workflow validation; adapt current main rather than copying older preview wiring |
| `packages/create/template/scripts/cloudflare-*.mjs`, `neon-*.mjs` | Inventory existing provisioning/deployment responsibilities and assign a single owner before delegation |
| `packages/create/template/scripts/transactional-provider-preflight.mjs` | Preserve email/billing readiness and environment boundaries |
| `scripts/check-generated-project.mjs`, `check-adjacent-upgrade.mjs`, `check-customized-upgrade.mjs` | Extend generated-consumer and upgrade proof, not just framework unit tests |

Source references: [mainline tree](https://github.com/gregmushen/trestlejs/tree/a4c16afef6ae0234766d453f4e52fbc1adc03504),
[SetupPlan](https://github.com/gregmushen/trestlejs/blob/a4c16afef6ae0234766d453f4e52fbc1adc03504/packages/cli/src/setup-plan.ts),
[credentials](https://github.com/gregmushen/trestlejs/blob/a4c16afef6ae0234766d453f4e52fbc1adc03504/packages/cli/src/secrets.ts).

No runtime or test results from this planning pass are claimed.

## 3. Implementation rules

1. Prepare a clean branch from current main; preserve all existing user work.
2. Bring over only the reviewed provisioning spec and this plan initially.
3. Confirm applicable `AGENTS.md` instructions, especially before template edits.
4. Keep infrastructure opt-in and operation-specific until qualified.
5. Never infer remote authorization from a source-controlled `approved` flag.
6. Add tests with each behavior change, including adverse cases before live use.
7. Never weaken a failing gate to make an unsupported provider look supported.
8. Commit tested milestones with Greg Mushen authorship and no added coauthor.
9. Open a scoped PR per milestone; merge only against that PR's passing required
   checks. Package publication is a separate gate, not an automatic per-PR step.
10. Update the evidence ledger and this plan's task status with exact commits and
    results. Existing beta unknowns remain unknown unless directly re-proven.

## 4. Module boundaries

Proposed new modules under `packages/cli/src/infra/`:

```text
schema.ts / types.ts         intent, binding, capability, plan, operation schemas
capabilities.ts              operation-specific support and evidence expiry
planner.ts                   pure deterministic dependency graph and diff
policy.ts / approvals.ts     trusted authority, approval binding, replay controls
store.ts                    durable operation/generation/lease interfaces
stores/memory.ts             deterministic test store only
stores/local.ts              local inspection/simulation journal
stores/postgres.ts           proposed independent control-store implementation
runner.ts                   checkpoints, retries, recovery, effect execution
process.ts                  trusted child process and bounded sanitized output
adapters/stripe-projects.ts  versioned CLI translation, no shell interpolation
adapters/direct.ts           explicit extension dispatch, never silent fallback
credentials.ts              classified outputs and encrypted generation commit
rotation.ts                 provider-aware issuance/cutover/retirement workflow
consumers.ts                declared consumer graph and generation verification
verification.ts             separately authorized active probes
status.ts / doctor.ts        metadata and read-only evidence inspection
commands.ts                 CLI registration and consistent result formatting
```

Names are implementation targets, not promises of public package APIs. Keep the
first implementation in the CLI package; do not create another published SDK or
remote plugin framework. Existing application BillingService/EmailService APIs
stay unchanged.

Use small interfaces for `InfrastructureAdapter`, `OperationStore`,
`ApprovalAuthority`, `CredentialStore`, `ConsumerDeployer`, `ProbeRunner`,
`ProcessRunner`, and `Clock`. Inject these so failures are deterministic.
Provider adapters return normalized metadata or private credential handles;
never place raw credentials in public operation results.

## 5. Decision records required before mutation

These are bounded investigation tasks, not unspecified implementation choices.
Record each decision in `docs/decisions/` with evidence, rejected alternatives,
and a clear enable/block result.

| Decision | Proposed direction | Required decision owner and gate |
| --- | --- | --- |
| D-01: supported toolchain/output | Pin Projects/Stripe CLI versions and executable integrity; accept only verified schemas | CLI maintainer; P01 before P03 |
| D-02: control-store backend | Independent PostgreSQL control database with transactional generations, approvals, journal and mutation reservations; local/memory stores cannot authorize shared remote mutation | Infrastructure maintainer; P04 before P07 |
| D-03: approval identity | Protected operator identity or trusted CI deployment authorization bound to exact plan/artifact; no editable repository Boolean | Security/release maintainer; P04 before P07 |
| D-04: credential envelope | Versioned project/environment/purpose/generation-bound envelope and recoverable pointer commit; legacy reads remain explicit | Secrets maintainer; P05 before P07 |
| D-05: issuance recovery | Provider-specific response-loss strategy or unsupported unattended rotation | Provider maintainer; P01/P09 before P10 |
| D-06: registry bootstrap | Clearly separate native Projects consent from Trestle approval, then adopt exact identities | Release maintainer; P15 before publication |

Roles identify accountability; the executing maintainer can fill several roles.
Authorization for real account, cost, custody, or production changes must still
come from the designated human/account owner, not from this ownership table.

The proposed control database must exist independently before it can govern
remote creation. Initial enrollment uses an explicitly approved existing or
separately bootstrapped operator resource; do not recursively provision it
through a coordinator whose state does not yet exist. Prefer an existing
approved control resource for the first test, without using a tenant app DB.
Record its recovery authority and tested backup/restore procedure. If that
dependency is unavailable, continue read-only and fake-provider work; remote
apply remains disabled rather than falling back to an ephemeral journal.

## 6. Dependency graph and release checkpoints

```text
P00 baseline -> P01 capabilities -> P02 contracts -> P03 read-only adapter
                                      |                    |
                                      +------ P04 control -+
                                      +------ P05 secrets -+
                                                           |
                                            P06 fake executor proof
                                                           |
                                            P07 Neon hosted vertical slice
                                                           |
                                            P08 deployment/consumer proof
                                                           |
                                            P09 rotation fault model
                                                           |
                                            P10 hosted rotation qualification
                                                           |
                          +---------------- P11 Cloudflare / P12 Resend
                          +---------------- P13 lifecycle operations
                                                           |
                          P14 setup/CI/upgrades -> P15 registry -> P16 release
```

The diagram groups dependencies for readability. Each work package below lists
its exact prerequisites. Independent code work may proceed concurrently, but
this plan does not authorize additional agents or concurrent provider mutation.

| Checkpoint | Deliverable | What remains disabled |
| --- | --- | --- |
| R1 | P00–P03: local configuration, safe catalog/status/plan/doctor | All resource and credential lifecycle mutation |
| R2 | P04–P08: isolated staging provisioning and deployment proof | Unqualified rotation and other provider operations; production mutation |
| R3 | P09–P10: qualified rotation for named credential types | Unknown invalidation/recovery modes and shared keys without complete inventory |
| R4 | P11–P14: broad golden-path lifecycle and adoption | Every unsupported operation remains explicitly blocked |
| R5 | P15–P16: registry path and production qualification | Scheduled automatic rotation remains deferred and explicit opt-in |

Do not assign speculative calendar deadlines or package numbers. Size PRs by
reviewability and gate completion, not by number of features announced.

## 7. P00 — Establish the implementation baseline

**Dependencies:** None. **Owner:** Release maintainer.

- Re-resolve main and select a clean checkout/branch without switching or
  rewriting the user's dirty branch.
- Read repository instructions and run current baseline checks.
- Inventory conflicts with other in-progress secrets/provider changes. The
  Fatima experiment is neither imported nor removed by this work.
- Copy only these two reviewed documents into the implementation branch.
- Record current CLI/creator versions, existing generated scripts, package
  boundaries, and baseline test failures before implementation.

**Tests/evidence:** `pnpm check`; generated and upgrade checks using their
documented isolated PostgreSQL fixtures; distinguish pre-existing failures.

**Exit:** Clean scoped branch, reproducible baseline, no user changes lost.

## 8. P01 — Prove the capability and side-effect matrix

**Dependencies:** P00. **Owner:** Provider maintainer.

- Inspect current official docs, actual supported CLI help/catalog, and exact
  service identifiers for Cloudflare, Neon, and Resend.
- Establish D-01 and D-05 facts: structured output, account selection, automatic
  pulls, output paths, bundled effects, auth renewal, adoption, stable identity,
  retry behavior, rotation unit, invalidation, and response-loss recovery.
- Split read-only discovery from separately authorized sandbox experiments.
  Do not use `add`, `rotate`, or `remove` as harmless exploratory commands.
- Write `docs/STRIPE_PROJECTS_CAPABILITIES.md` and sanitized fixtures under
  `packages/cli/test/fixtures/stripe-projects/<tested-version>/`.
- Record unsupported/unknown cells explicitly with probe, owner, and next step.

**Tests/evidence:** Fixture secret scanner; every recorded operation describes
all side effects; tool/schema version mismatch produces unavailable support.

**Exit:** Reviewed matrix permits a narrow implementation or identifies exact
blocked paths. A provider logo in the catalog is not an exit criterion.

## 9. P02 — Contracts, manifest, and deterministic planning

**Dependencies:** P01. **Owner:** CLI maintainer.

- Add strict schemas for desired resources, bindings, capability evidence,
  credential metadata, operation graph, normalized errors, and public reports.
- Parse `.trestle/infrastructure.yaml` independently of SetupPlan v1.
- Implement canonical serialization, digests, dependency/cycle validation,
  immutable identity binding, safe unresolved create outputs, and drift rules.
- Model account-wide effects, costs, retain/delete policy, shared consumers,
  timeouts, compensation, and unknown preconditions in plan output.
- Reject secret values in intent and public metadata; map logical credential
  references rather than embedding strings in plans.

**Tests:** Proposed `infra-schema.test.ts`, `infra-planner.test.ts`: stable
digests across equivalent formatting; meaningful changes alter digests; cycle,
duplicate identity, cross-environment sharing, secret-bearing plan, unknown
price, drift and stale evidence rejection. Property tests cover operation order.

**Exit:** Pure plans have no process/network/file mutation beyond explicit
local plan persistence. Existing SetupPlan behavior remains unchanged.

## 10. P03 — Safe Projects process adapter and read-only CLI

**Dependencies:** P02. **Owner:** CLI maintainer.

- Implement pinned executable validation, argument arrays, restricted child
  environment, time/output bounds, exact account/project/environment checks,
  and private stdout/stderr capture with schema-based safe projection.
- Isolate Projects state/output from the developer's checkout. Never modify
  undocumented internal state to simulate an unsupported command.
- Register `infra init`, `catalog`, `status`, `plan`, `doctor`, `open`, and
  operation inspection. Expose mutation commands only as unavailable/pending
  until their gates are enabled.
- Integrate current `providers.ts` and `doctor.ts` with explicit evidence
  mapping. Credential-pattern presence cannot mean hosted readiness.
- Do not execute application-defined provider health URLs with privileged
  infrastructure credentials. Use adapter-owned validated probes.

**Tests:** Proposed `infra-process.test.ts`, `infra-readonly.test.ts`: hostile
arguments, path hijack, malformed/oversize output, secrets in nested errors,
unexpected automatic writes, wrong active environment, denied auth, version
drift, URL rejection; assert zero mutating provider calls from read commands.

**Exit:** R1; structured output distinguishes unknown, failure, and no change.

## 11. P04 — Trusted approval and durable control state

**Dependencies:** P02, P03. **Owner:** Infrastructure/security maintainer.

- Resolve D-02/D-03 and implement the control-store interface and first backend.
- Add store schema/migrations for operations, append-only events, approvals,
  binding generations, mutation reservations, and verification references.
- Authenticate the actor outside project source; persist approvals bound to
  canonical plan, artifact, scopes, cost limits, target and expiry.
- Consume approval once per operation; resume checks current authority without
  repeating committed effects. Policy changes cannot be self-authorized by PRs.
- Implement transactional reservations plus leases/fencing where possible.
  Uncertain provider outcomes leave a reservation that does not expire into
  permission to retry. Recovery explicitly reconciles it before release.
- Protect encrypted recovery material independently from the key being rotated.
  Define retention and recovery access. Backup the control store and rehearse
  its restoration before it governs real operations.

**Tests:** Proposed `infra-store.test.ts`, `infra-approval.test.ts`,
`infra-concurrency.integration.test.ts`: two processes, lost lease, delayed
provider response, plan alteration, replay, expired/revoked actor, lost journal,
stale generation, restore; run against disposable independent PostgreSQL.

**Exit:** AR-01/02 controls proven in simulation. CI concurrency groups alone
cannot satisfy this gate. Remote mutation is still disabled pending P05/P06.

## 12. P05 — Credential generations and compatibility

**Dependencies:** P02, P03, P04. **Owner:** Secrets maintainer.

- Resolve D-04. Add versioned authenticated project/environment/purpose/generation
  metadata without silently changing legacy file interpretation.
- Preserve edit, vi/editor selection, set/import, explicit show/export, and
  master-key rotation. Distinguish provider issuance from encryption-key rotation.
- Implement application-owned, provider-managed, and operator-only classification;
  explicit override conflicts; allowed output mappings; generation CAS.
- Implement protected temporary output parsing, path/owner validation, no shell
  evaluation, bounded input, encryption, durable commit pointer, restart recovery,
  and cleanup debt reporting. Never overwrite a user `.env` file.
- Coordinate ciphertext and safe metadata through a recoverable generation, not
  two independent renames. Recovery authority is separately tested.
- Implement internal pull/import engine. Public pulls remain unavailable until
  P06 proves coordination with concurrent edits and rotations.

**Tests:** Proposed `infra-credentials.test.ts`, `infra-envelope.test.ts`, plus
existing `secrets.test.ts`: cross-project/environment substitution, nonce and
authentication checks, stale pointer, key migration, incompatible old CLI,
dotenv injection, malformed multiline data, symlink, partial write, crash,
permissions, override collision, concurrent edit, raw-secret artifact scans.

**Exit:** Old files remain readable under explicit legacy handling; new files
cannot be silently downgraded. Tests prove no accidental value reveal.

## 13. P06 — Executor and exhaustive fake-provider recovery

**Dependencies:** P03, P04, P05. **Owner:** Infrastructure maintainer.

- Implement dependency-ordered effect execution, preflight/approval refresh,
  checkpoint persistence, bounded retries, ambiguity reconciliation and resume.
- Create a fake Projects executable with a provider state store independent of
  the runner process. Killing the runner must not erase simulated remote effects.
- Model response loss, duplicate request handling, delayed effects, outages,
  credential bundles, immediate/overlap rotation, and cleanup failure.
- Connect public `apply`, `link`, and credential pull through the same authority
  and state controls; enforce their complete side-effect contracts.
- Define explicit normalized completion/partial/unknown results and nonzero
  exit codes. Never compensate by deleting retained resources automatically.

**Tests:** Proposed `infra-runner.test.ts`, `infra-crash.integration.test.ts`.
Enumerate every effect and persist boundary; kill/restart before and after each.
Assert exact call counts, retained objects, outstanding keys, and artifact
redaction. Retry/backoff tests use an injected clock, never real sleeps.

**Exit:** All fake-provider adversarial cases for the initial provisioning path
pass. Recovery metadata names an actionable next step. Real apply may now be
enabled only for the isolated provider/environment qualified in P07.

## 14. P07 — Neon hosted provisioning vertical slice

**Dependencies:** P01–P06. **Owner:** Provider/database maintainer.

- Obtain explicit sandbox account/resource/cost/cleanup authorization and enroll
  the independent control store. Recheck plugin/account capability evidence.
- Provision one isolated Neon resource through Projects and bind its exact ID.
- Import bootstrap credentials as operator-only; create migration/runtime/admin
  roles through trusted database tooling and apply forced RLS.
- Generate a fixture application that declares an actual tenant resource.
  Seed two tenants and exercise allowed and forbidden operations through the
  runtime role; do not repeat the canary mistake of proving no declared resource.
- Reuse existing transport/deployment checks; validate direct/pooled endpoint
  and driver semantics, not just connection-string format.
- Re-run the same operation to prove no duplicate creation. Inject a bounded
  response ambiguity only where safely authorized; otherwise retain fake proof
  and label that hosted failure case untested.

**Tests/evidence:** Hosted resource identity, runtime-role isolation, deployment
and smoke evidence, operation journal, repeat call counts, retained/deleted
resource ledger, sanitized exact-commit report.

**Exit:** One real end-to-end path proven. A valid owner connection alone fails
the gate. No production claim and no live email required.

## 15. P08 — Deployment handoff and consumer generation proof

**Dependencies:** P07. **Owner:** Deployment maintainer.

- Define the consumer registry for customer/admin Workers, migrations, jobs,
  previews, queues/workflows and intermediaries actually enabled by the app.
- Reuse current host configuration and secret projection mechanisms, wrapped by
  approved target binding and consumer-specific credential selection.
- Bind artifact, host revision, configuration and credential generation.
  Add safe dependency probes that exercise new connections where required.
- Preserve direct-provider ownership of existing resources. Initial Neon proof
  can deploy to an approved existing Cloudflare target; it does not wait for a
  new Cloudflare provisioning adapter.
- Add generation-aware rollback and incomplete-consumer reporting. Do not deploy
  application-supplied hooks in the privileged provisioning stage.

**Tests:** Proposed `infra-consumers.test.ts`, `infra-deployment.test.ts`,
generated app tests: wrong Worker/admin target, old replica returning 200,
partial host update, stale pool, config drift, old-revision rollback, management
path unavailable while the provider data plane remains healthy.

**Exit:** R2; deployed evidence distinguishes provisioned/configured/deployed/
verified and proves all consumers in the declared initial scope.

## 16. P09 — Rotation state machine and fault proof

**Dependencies:** P04–P06, P08. **Owner:** Secrets/infrastructure maintainer.

- Implement rotation plans for the provider's real mutation unit, complete
  consumer and shared-account inventory, invalidation timing, downtime, and
  retirement verification. Inventory incompleteness blocks unattended mutation.
- Support overlap and immediate-invalidation state machines explicitly. Unknown
  behavior is unsupported, not an overlap default.
- Implement response-loss recovery proven by D-05; unrecoverable one-time keys
  with immediate invalidation remain blocked.
- Drain old revisions, verify new generation per consumer, retire the old key
  only under the proper strategy, and separate cutover from retirement evidence.
- Keep master-key rotation, API keys, database passwords, and webhook signing
  secrets as distinct types. Do not expose a generic rotate-all shortcut.

**Tests:** Proposed `infra-rotation.test.ts`, `infra-rotation-crash.test.ts`:
all transitions, bundled outputs, response loss before save, partial consumers,
revocation failure, expired overlap, delayed jobs, false 401/403 evidence,
unknown consumers, stale pull, revoked-key rollback, repeat plan application.

**Exit:** Every supported simulated strategy survives the full crash matrix.
Unsupported strategies produce no issuance call.

## 17. P10 — Hosted rotation qualification

**Dependencies:** P09 and fresh P01 evidence. **Owner:** Provider maintainer.

- Select one disposable credential type with the best demonstrated recovery
  semantics; choose from evidence, not a preselected provider assumption.
- Declare every consumer, blast radius, bounded probes, maintenance window if
  required, and cleanup. Do not use shared real application keys as test fixtures.
- Rotate through Projects, persist the encrypted generation, deploy consumers,
  verify new-key operation and old-key retirement with controlled evidence.
- Rehearse partial cutover/resume only where safe; record missing hosted failure
  cases explicitly rather than generalizing simulated proof.

**Exit:** R3 enables only the verified provider/service/credential/version tuple.
If no safe tuple exists, ship rotation planning plus explicit unsupported
execution; do not claim completion of the full rotation milestone.

## 18. P11 and P12 — Cloudflare and Resend breadth

**Dependencies:** P08; any rotation behavior also requires P09/P10 qualification.
**Owners:** Corresponding provider maintainers.

### P11: Cloudflare

- Implement exact catalog-supported account/resource lifecycle operations.
- Inventory Workers, Pages, R2, Queues, Workflows, Hyperdrive, domains, routes,
  account tier and token scope separately. Record direct extensions for gaps.
- Migrate responsibilities from generated `cloudflare-*.mjs` deliberately;
  disable competing writers per resource while retaining deployment functions.
- Test preview/customer/admin target isolation, account-wide quota/plan changes,
  partial bindings, adoption, resource identity, and retained-data behavior.

### P12: Resend

- Implement supported service/key lifecycle and explicit direct extensions for
  sender/domain/webhook operations not exposed by Projects.
- Preserve runtime sending scopes, safe staging redirection and no-send checks.
- Keep signing-secret rotation distinct from API-key rotation and qualify any
  receiver overlap before advertising it.
- Test sender readiness, insufficient key scopes, recipient protection, key
  bundle effects, webhook verification and configuration drift without live mail.
- An optional live-send gate requires fresh approval, named recipient, hard
  message budget and quota check; quota exhaustion must not trigger retries.

**Exit:** Per-operation conformance evidence and explicit limitations. Neither
provider receives a blanket supported badge from one successful API request.

## 19. P13 — Adoption, tier changes, detach and destruction

**Dependencies:** P06, P08, and capability proof for each target provider.
**Owner:** Infrastructure/provider maintainers.

- Implement exact-ID adoption with previous-writer handoff and no incidental
  credential/data/migration changes.
- Implement tier-change planning with refreshed pricing, account-wide effect,
  current currency, usage uncertainty, and authorization limits.
- Separate membership removal, detach, unlink, revocation, and deletion. Keep
  unsupported non-destructive detach blocked rather than invoking removal.
- Implement retain policy, consumer drain, reference recheck, backup/restore
  gate, exact-ID deletion, tombstones and post-delete credential cleanup.
- Track incomplete cleanup and orphans without automatically deleting them.

**Tests:** Proposed `infra-lifecycle.test.ts`: delete/recreate under same name,
unknown shared consumer, missing recovery proof, duplicate adoption, changing
price, unauthorized downgrade, partial cleanup, resume, no silent compensation.

**Exit:** Each operation's destructive and non-destructive semantics separately
proven. No account-wide paid change is made merely to complete this ticket.

## 20. P14 — SetupPlan, CI, upgrades and operational documentation

**Dependencies:** P08, P11, P12, P13; rotation docs depend on P10 support surface.
**Owner:** CLI/release maintainer.

- Introduce an explicitly versioned SetupPlan extension referencing infra intent.
  Preserve v1 rejection of nonempty external/destructive lists; never reactivate
  old `approved` fields as remote permission. Both entry points use one planner.
- Integrate protected CI plan/approval/apply/deploy/verify/cleanup stages. Separate
  untrusted builds from privileged mutation; use verified immutable artifacts.
- Add preview identity, TTL, limits, exact ownership, protected cleanup and
  independent mutation reservations. Workflow cancellation is not remote abort.
- Integrate safe evidence into existing ledgers. Public evidence status does not
  authenticate approvals; arbitrary evidence commands never run with provisioning
  credentials.
- Update CLI docs and setup-skill requirements to describe only enabled commands.
  Add canonical enable/adopt/rotate/recover/remove/exit guides.
- Add explicit envelope/config migrations and minimum CLI version errors.
  Rehearse pristine and customized adjacent-version upgrades, preserving user
  source and direct-provider resources.

**Tests:** Existing generated/upgrade checks plus proposed
`infra-setup-plan.test.ts`, `infra-ci.test.ts`, `infra-upgrade.test.ts`; verify
same-repository malicious PRs as well as forks; old plans cannot gain powers.

**Exit:** R4; a new app and an existing customized app both exercise the supported
path without manual undocumented repair. Unsupported paths are clearly reported.

## 21. P15 — Materialized starter and registry path

**Dependencies:** P14 and D-06. **Owner:** Release maintainer.

- Generate a materialized starter from one pinned Trestle release; no independent
  hand-maintained copy of framework architecture.
- Create a registry manifest with validated services, correct framework metadata,
  reproducible dependency installation and declared next steps.
- Prove installation succeeds before credentials exist. Inspect lifecycle scripts
  so installation cannot inherit later provisioning authority.
- Test local-manifest builds in an isolated directory. Record the external
  bootstrap consent boundary and adopt resulting resource IDs without duplicates.
- Test teammate onboarding/private state handling and no-secret publication.
- Submit a public registry entry only after qualification and explicit release
  authorization. If bootstrap semantics are incompatible, defer the registry
  variant while keeping the normal creator path functional.

**Tests:** Clean-directory build, exact source pin, secret scanner, idempotent
handoff, install-before-provision, budget/consent evidence, direct creator parity.

**Exit:** R5 registry evidence or a documented blocked registry path; never claim
Trestle approval covered provisioning that occurred before Trestle executed.

## 22. P16 — Production and release qualification

**Dependencies:** P14 and all provider operations being advertised; P15 for a
registry release. **Owner:** Release maintainer with designated account owner.

- Review every advertised operation against capability and adversarial evidence.
- Run protected staging on exact release artifacts, including recovery tests.
- Run separately approved production qualification only for the chosen scope.
  Production evidence cannot be inherited from test-mode billing or local fakes.
- Package-test the CLI and creator; rehearse current supported upgrades; inspect
  tarballs for hidden files, plaintext secrets, private bindings and ignored assets.
- Update release notes, support matrix and testing ledger. Label unknowns and
  blockers; do not close unrelated beta gaps.
- Publish the appropriate prerelease only after all required gates pass. Preserve
  a tested previous package plus compatible credential/control-state strategy;
  package rollback is not permission to downgrade encrypted generations.

**Exit:** Release evidence bundle, operational runbooks, explicit scope, and
approval. No scheduled rotation is enabled as part of this release.

## 23. Test commands and test layers

Existing root commands confirmed in the inspected mainline:

```sh
pnpm check
pnpm check:generated
pnpm check:upgrade
pnpm check:customized-upgrade
pnpm release:check
pnpm release:pack
```

Inspect each script's current inputs before execution. Supply isolated database
fixtures for integration rehearsals; never substitute production URLs. The
existing beta-specific upgrade script is version-scoped, not a permanent new
release gate without reviewing its assumptions.

Proposed additional scripts, to be added rather than claimed available:

| Script | Purpose | Credential authority |
| --- | --- | --- |
| `check:infra` | schemas, planner, adapters, credential and lifecycle unit tests | None |
| `check:infra-recovery` | multiprocess control-store and crash matrix | Disposable local control DB only |
| `check:infra-generated` | packed CLI/creator consumer and compatibility tests | Local fixtures only |
| `check:infra-hosted` | named capability-specific canary run | Explicit sandbox authorization and budgets |

Require branch/path coverage of each state transition and each fail-closed gate.
Use fault injection and invariant/property tests; raw test count or aggregate
coverage percentage alone is not an acceptance criterion. Mutate selected safety
checks deliberately in the test harness and confirm the tests become red.

## 24. Adversarial finding-to-test traceability

| Finding | Owning work | Required proof |
| --- | --- | --- |
| AR-01 approval tamper/replay | P04, P06 | Alter/replay plan; no unauthorized or duplicate effect |
| AR-02 stale runner | P04, P06 | Delayed remote completion after lease loss; no conflicting takeover |
| AR-03 lost issued key | P01, P09, P10 | Crash before persistence; recover safely or block issuance in advance |
| AR-04 stale/cross-project snapshot | P05, P08 | CAS rejection and envelope binding across old checkout/concurrent pull |
| AR-05 bundled effects | P01, P03, P09 | Reject unapproved sibling rotation and unexpected plaintext outputs |
| AR-06 privileged build code | P03, P04, P14 | Malicious install/workflow code receives no provisioning credentials |
| AR-07 false health/retirement proof | P08–P10 | Old replica, rate limit and network failure cannot prove rotation |
| AR-08 rollback and old jobs | P08–P10 | Old artifact and delayed job cannot resurrect revoked credentials |
| AR-09 mutating doctor | P03, P14 | Read-only command produces zero provider/fixture writes |
| AR-10 registry bypass | P15 | Bootstrap and Trestle authorization recorded as distinct scopes |
| AR-11 replaced deletion target | P13 | Old display name resolves to replacement; replacement survives |
| AR-12 malicious endpoint | P03, P05 | Reject wrong ownership/TLS/destination before sending any credential |
| AR-13 unsafe compensation | P06, P13 | Later-step failure cannot delete retained database |
| AR-14 stale capability evidence | P01–P03, P16 | Tool/behavior/scope change invalidates affected qualification |
| AR-15 management/data-plane confusion | P08, P16 | Management outage and provider outage yield different evidence |

## 25. Evidence and completion rules

Specification section 32 acceptance coverage:

| Scenario IDs | Required behavior | Work and evidence gate |
| --- | --- | --- |
| 1 | Local app without Projects | P00/P14, generated local application |
| 2–3 | Actual capabilities and side-effect-free planning | P01–P03, capability fixtures and call assertions |
| 4–5 | Duplicate-safe Neon provisioning and runtime RLS | P07, hosted two-tenant resource test |
| 6–7 | Encrypted import, editing and explicit reveal | P05/P06, envelope and command tests |
| 8 | Artifact deployment with declared credentials | P08, host revision and generation evidence |
| 9–10 | Complete rotation and old-key retirement | P09/P10, fault matrix and hosted credential proof |
| 11 | Recovery without blind retry | P06/P09/P10, journal and effect-count assertions |
| 12 | Account/environment drift refusal | P02–P04/P07, mismatched-target negative tests |
| 13 | Non-destructive adoption | P13/P14, preserved resource identity and data |
| 14 | Cloudflare/Resend delegation and explicit gaps | P11/P12, per-operation conformance |
| 15–16 | Authorized tiers, retention and removal | P13, cost approvals and lifecycle tests |
| 17–18 | Management-outage behavior and honest evidence | P03/P08/P16, outage and report tests |
| 19 | Approval/source privilege protection | P04/P14, tamper/replay and malicious-source tests |
| 20 | Response-loss and stale-runner safety | P04/P06/P09, multiprocess crash tests |
| 21 | No resurrection of retired keys | P05/P08/P09, generation-aware rollback tests |
| 22 | Distinct bootstrap authorization | P15, registry handoff evidence |

All work packages are pending as of this plan's date. Update them to in progress,
blocked, or complete only with the corresponding evidence; no box is implicitly
checked by the earlier design review.

Each PR records task ID, source and artifact digests, toolchain version, test
commands, fixture/provider scope, safe result links, limitations, and remaining
owned resources. Hosted evidence additionally records account/project/resource
identities in the appropriate protected store, consumer generations, cost/send
budgets, and cleanup status. Public summaries expose only safe metadata.

Do not mark a ticket complete for a passing mock when its exit requires hosted
evidence. A missing external prerequisite becomes a named blocker with an owner;
it does not stop independent safe work or justify silently weakening the gate.

Final acceptance requires all 22 scenarios from specification section 32 to be
mapped to evidence, with unsupported advertised behavior removed or the release
explicitly limited. Registry and production claims retain their separate gates.

The next executable step is **P00**, followed by the bounded **P01 capability
investigation**. No remote lifecycle command runs before the corresponding
authority and safety prerequisites are satisfied.
