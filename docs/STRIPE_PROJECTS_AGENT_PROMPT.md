# Agent prompt: implement Stripe Projects provisioning end to end

Use the following as the implementation agent's task. The prompt starts below.

---

Implement the TrestleJS Stripe Projects integration end to end, including tests,
failure recovery, generated-application verification, documentation, and release
qualification. Execute the implementation plan; do not stop after writing
another plan, adding command stubs, or finishing the first milestone.

## Authoritative inputs

Repository: `https://github.com/gregmushen/trestlejs.git`

The reviewed documents currently live at:

- `/Users/gregmushen/work/code/gstack/docs/STRIPE_PROJECTS_PROVISIONING_SPEC.md`
- `/Users/gregmushen/work/code/gstack/docs/STRIPE_PROJECTS_IMPLEMENTATION_PLAN.md`

Read both completely, including the specification's adversarial review ledger
and the plan's test/acceptance mappings. Then read applicable `AGENTS.md` files
and use required skills. If these absolute paths do not exist on your host, use
the same repository-relative paths or request the missing documents; do not
reconstruct their requirements from this prompt.

The specification defines the behavior. The implementation plan defines work
packages P00–P16, decisions D-01–D-06, dependencies, and release checkpoints
R1–R5. This prompt directs execution without weakening those requirements.

If current code or provider behavior contradicts a document, investigate and
record the discrepancy. Make a narrow, evidence-backed design adjustment when
it preserves the intended guarantees. Do not silently relax security, custody,
cost, data-preservation, or completion requirements to make progress appear green.

## Start safely on current main

1. Inspect repository/worktree state and resolve current remote `main`.
2. The document-authoring checkout was an older branch with unrelated uncommitted
   work, including a secrets experiment. Treat that as a warning to inspect, not
   as immutable current state. Never reset it, switch it underneath another task,
   stage its unrelated changes, or use it as the implementation baseline.
3. Reuse a suitable clean managed worktree or prepare a separate clean worktree
   following the environment's rules. Use `codex/` branches unless instructed
   otherwise. Start implementation from current main, not a historical SHA
   quoted in the plan.
4. Bring over only the reviewed specification, implementation plan, and this
   prompt if they are not yet present on main. Do not overwrite newer versions;
   reconcile differences explicitly.
5. Verify current source layout and scripts. In particular, do not implement
   against the obsolete `packages/core` schema layout merely because it exists
   in the document-authoring checkout.
6. Run and record baseline checks. Distinguish pre-existing failures from your
   changes. Read template-specific instructions before editing generated code.

## Objective and boundaries

Use Stripe Projects for as much verified infrastructure lifecycle as possible:
account linking, resources, credentials, rotation, environments, tiers, status,
adoption, and controlled removal. Direct-provider extensions cover explicit
gaps; they must not become silent fallback writers during a Projects outage.

Trestle continues to own application intent, authorization, encrypted deployment
snapshots, database roles/forced RLS, deployment wiring, and readiness proof.
Projects must not become a runtime dependency of a running application.

Preserve these boundaries throughout:

- `trestle infra ...` is infrastructure lifecycle. `trestle payments stripe ...`
  is customer billing. Do not combine them.
- Local development and core tests require no external provider account.
- Preserve vi/editor access and intentional decrypted show/export. Normal output,
  plans, logs, CI artifacts, and diagnostics remain secret-free.
- Provider credential rotation is separate from local encryption-key rotation.
- Existing applications retain their resource owners and working deployment path
  until explicitly adopted. Package upgrades cannot reprovision infrastructure.
- Old SetupPlan documents cannot gain remote mutation powers from an upgrade.
- Tenant roles and support/impersonation sessions cannot operate platform
  infrastructure or retrieve provisioning credentials.
- Do not create a new published SDK, generic workflow platform, or unrelated
  framework redesign to complete this feature.

## Execution loop

Maintain one durable progress record in
`docs/STRIPE_PROJECTS_IMPLEMENTATION_STATUS.md` and update the implementation
plan's statuses as work advances. Start the record with P00–P16 pending; do not
count the completed design review as completed implementation.

For each work package:

1. Check its dependencies and current source/provider facts.
2. Resolve required decision records with concrete evidence. Prefer the plan's
   proposed direction where it satisfies the constraints; do not ask the user
   to make ordinary implementation decisions.
3. Add tests that expose the expected failure before or with the implementation.
4. Implement real behavior in small, maintainable modules and integrate the CLI,
   generator, deployment path, or docs required by that package.
5. Run focused tests, relevant integration/consumer checks, and required full CI.
6. Perform an adversarial review of the diff. Fix findings and rerun affected
   tests before claiming the package complete.
7. Record exact evidence, limitations, resources left behind, and task status.
8. Commit the scoped change, open its PR, obtain passing required checks, and
   merge under the authorized milestone workflow. Continue with the next package.

Do not pause for approval between ordinary code/test milestones. Do not stop
after R1 because the CLI help looks complete. Keep progressing through every
safe, unblocked part of the plan until the full scope is delivered or completion
genuinely requires additional authority or an unavailable external prerequisite.

If a hosted gate is blocked, leave it blocked and continue independent local
implementation and tests. You may build dependent interfaces against explicit
fakes, but that does not satisfy a hosted dependency or enable real mutations.
Do not mark P10 complete merely because rotation is correctly reported unsupported.

## Mandatory safety gates

Before any live provisioning or rotation:

- Verify the actual plugin, executable integrity, JSON schema, target account,
  project, environment, service, and full command side effects.
- Have authenticated approval bound to the plan, operation, artifact and scope.
  An editable `approved: true`, plan digest alone, provider login, or repository
  workflow modification is not approval authority.
- Have durable state and recovery access independent of the application resource
  being created or the key being rotated. Resolve the control-store bootstrap
  dependency explicitly; no ephemeral-journal fallback for shared remote writes.
- Pass the fake-provider crash/concurrency gates before the real operation.
- Confirm exact resources, consumers, budgets, scope and cleanup disposition.

Implement the specification's fail-closed rules, especially:

1. Consume approval once per operation; replay cannot create another side effect.
2. A lost lease does not cancel an in-flight provider request. Reconcile uncertain
   outcomes before another runner can mutate the same target.
3. Protect against the issuance-response-loss window. Persisting a received key
   is not sufficient proof of recoverability if the response was never received.
4. Use project/environment/purpose/generation-bound credentials with durable
   generation commits and compare-and-swap. Old checkouts and concurrent pulls
   must not overwrite new generations.
5. Inventory the provider's true rotation unit and all affected consumers.
6. Prove new-generation use per consumer, then prove old-key retirement according
   to provider semantics. Generic HTTP 200 or an arbitrary 401/403 is insufficient.
7. Old application revisions and rollback cannot resurrect retired keys.
8. No untrusted builds, install hooks, or application commands execute with
   provisioning authority. Separate build and mutation stages.
9. Doctor is read-only; active RLS writes and other effects require separately
   authorized verification jobs.
10. Native Projects starter bootstrap and Trestle apply have distinct approval
    boundaries. Document and test the handoff without creating duplicate resources.

## Testing requirements

Implement all tests in the plan and make each AR-01–AR-15 finding falsifiable.
Maintain coverage mapping for all 22 specification acceptance scenarios.

Required layers:

- Strict schema, canonical plan, identity, policy, and capability tests.
- A fake Projects executable whose remote state survives runner termination.
- Credential parsing, encryption/migration, override, redaction and filesystem
  safety tests, including hostile and malformed input.
- Disposable control-store integration tests with competing processes, delayed
  responses, lease loss, stale writes, and restart/recovery.
- Crash injection before and after external effects, journal writes, and
  encrypted-generation commits. Assert actual side-effect counts and retained
  resources, not just error messages.
- Rotation tests covering overlap, immediate invalidation, unrecoverable issuance,
  bundle effects, shared consumers, partial cutover, retirement and rollback.
- Real CLI process tests, not only imported helper tests.
- Packed CLI/creator tests from a fresh directory, generated application checks,
  pristine and customized adjacent-version upgrade rehearsals.
- An isolated hosted Neon app with a real declared tenant resource, two tenants,
  least-privilege runtime credentials, forced RLS and cross-tenant denial.
- Scoped hosted provider/rotation conformance where authorized and supported.
- CI trust-boundary tests, explicit adoption/removal tests, and registry bootstrap
  tests before those capabilities are advertised.

Use the current repository's documented commands and inputs. The plan lists
existing `pnpm check`, generated/upgrade, and release checks; confirm them before
running. Add proposed infrastructure scripts as real runnable gates. Never say
a script passed if it was not present or not executed.

Do not reduce assertions, skip a failing security case, or broaden a mock to
accept incorrect behavior. Record pre-existing failures separately. Keep live
credentials out of ordinary unit tests. Use an advanceable clock for retries.
Run tests on the final edited artifact, not only an earlier commit.

## External authority and provider access

Implement locally and pursue the scoped PR/merge workflow without routine
permission requests. Do not infer blanket authority for real infrastructure
from the phrase “end to end.”

New spending, paid-tier changes, provider terms acceptance, credential custody
changes, rotation of existing real application keys, destructive operations,
production deployment, npm publication, and public registry submission require
explicit applicable authorization. Existing trusted user authorization can be
used only for its exact scope; access to a token does not establish that scope.

Before a hosted test, identify the authorized account, environment, disposable
resources, allowed effects, budget, and cleanup. Never use another application's
keys or infrastructure merely because they are discoverable on the machine.
Do not print credentials or dump shell configuration/secret files into output.

Live email remains off by default. Do not send signup/reset emails as a routine
test technique. A live-send test needs separate opt-in, a named mailbox, a small
hard message budget, and a quota check. Billing tests use test mode; never swap
in live keys because test configuration is missing.

When new authority is required, ask a precise, consolidated question stating
the target, action, expected effect/cost and reason. Continue independent safe
work while awaiting an answer. Never fabricate hosted evidence, bypass a gate,
or mark a blocked release step complete.

## Git, PRs and release discipline

- Keep unrelated files untouched and unstaged. Never force-push shared history
  or reset user changes to obtain a clean tree.
- Use Greg Mushen's verified configured commit identity. Add no Codex, Claude,
  or other coauthor trailers; do not guess a missing email identity.
- Keep PRs scoped to reviewable milestones. Include tests, known limitations,
  capability status and the relevant work-package IDs.
- Attach created PRs to the task when the tool is available. An attachment UI
  limitation is not evidence that GitHub creation failed; report it accurately.
- Recheck exact head SHA, required CI, review requirements and mergeability
  before merge. Never bypass protection or claim success while CI is pending.
- After merge, inspect required mainline checks and carry fixes forward before
  building the next release on a known failing baseline.
- Package and registry publication have separate qualification and authorization
  gates. Prepare release artifacts and evidence while awaiting any required
  human authentication or approval; do not claim publication prematurely.

## Evidence, persistence and definition of done

Keep progress durable across interruptions. For each package record status,
branch/commit/PR, tests and exact results, environment, tool versions, artifact
identity, limitations, next step, and remaining owned resources. Keep sensitive
provider identity and recovery data in the protected store, not public PR text.

Communicate concise progress updates during work. If the session must hand off,
write a precise checkpoint so continuation does not repeat a provider mutation.
Never create a background automation or new user-visible task unless requested.

Before final completion:

1. Reconcile P00–P16 against their actual exit criteria.
2. Review all AR-01–AR-15 tests and all 22 acceptance scenarios.
3. Run final applicable framework, generated, upgrade, recovery and release gates.
4. Perform a final adversarial review and fix material findings.
5. Reconcile cleanup, orphan resources, plaintext artifacts and pending rotations.
6. Confirm documentation matches installed CLI capabilities and advertised support.
7. Verify claimed PR merges, package publication and deployments directly.

Report what is implemented, merged, published, locally verified and hosted
verified separately. List remaining external prerequisites or unknown paths
with owners and exact next actions. Unsupported safe behavior is valuable, but
is not proof that the requested provider operation works.

The objective is a working, tested integration—not an impressive checklist.
Start with P00 now and execute the plan.
