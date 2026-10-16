# Independent review of Trestle PR #246

Reviewed branch `codex/stripe-projects-production-support` at `a9f3cf3f5dceda2a3136064a9e4fd09e4678757c` against base `58a659a`.

Decision: changes requested before merge or hosted qualification. Two actionable findings follow. No implementation files were changed.

## R1 — P1: Check the bootstrap binding after acquiring its reservation

Location: `packages/cli/src/infra/bootstrap.ts:71–85` (especially the acquisition at line 79 and use of the earlier `current` at line 85).

`current` and the operation's start events are read before acquiring the application/environment reservation. A second process can read an absent binding, pause before its reservation call reaches the store, and then acquire the reservation after the first process has created, bound and released its project. When the two processes use different legitimate private workspaces (for example, separate clones), the second workspace is still empty. The second process therefore sends another `init`, and only afterward discovers the binding conflict at line 122. The canonical binding survives, but a second remote project has already been created and the operation throws instead of reporting a controlled state.

Deterministic local reproduction: `node /tmp/trestle-pr246-bootstrap-race.mjs`. It uses the reviewed build, the in-memory store, fake adapters, two signed approvals and two empty private workspaces. It delays the second operation immediately before the actual store `reserve` call, completes the first operation, then resumes the second. Observed output: `initCalls: 2`; first operation succeeds; second raises `generation conflict ... expected 0, current 1`.

Required fix: after obtaining the reservation, re-read the authoritative application/environment binding and this operation's start events before deciding whether initialization is permitted. Reject another operation's newly committed binding before any provider call. Preserve the existing uncertainty/workspace protections. Add a regression covering the late reservation acquisition with distinct workspaces and assert exactly one initialization, no orphan and a controlled blocked/retry result for the loser. Prefer a PostgreSQL/multiprocess variant in addition to a deterministic seam test.

## R2 — P2: Keep mixed completed/pending provider associations uncertain

Location: `packages/cli/src/infra/provider-link.ts:91–99`.

Post-link reconciliation filters associations to `status === "complete"` before counting them. A status document containing one completed association and another pending (or otherwise unrecognized) association for the same provider is consequently accepted as success, and its account-wide uncertainty fence is removed. The pre-link check at lines 75–78 correctly rejects this same ambiguous document, so the outcome currently depends on which side of the link call discovers it. Clearing the fence while a second authorization is pending permits subsequent operations even though that pending grant can still complete.

Deterministic local reproduction: `node /tmp/trestle-pr246-link-ambiguity.mjs`. Fake status is initially empty; after the fake link it contains Neon requests `facctrq_first/complete` and `facctrq_second/pending`. The reviewed executor reports `succeeded` and `getReservation(...)` returns `undefined`.

Required fix: validate the complete, unfiltered association set during reconciliation: exactly one matching provider row, and that row must be completed. Preserve uncertainty for duplicates, pending rows or unknown states. Add regressions for complete+pending, complete+unknown and duplicate complete associations, including a resume that never issues a second grant.

## Verification and scope

Independently ran six focused files: bootstrap, provider link, Pages, process arguments, R2 and private workspace tests. Result: **40 tests passed**, six files, no skips. The two reproductions above also ran locally and confirm the uncovered behavior.

Reviewed the complete diff, including CLI wiring, signed approval handling, new bootstrap/store boundaries, provider grant disclosure, R2 configuration/typed argv channel, Pages compilation/artifact staging, host/service enrollment, exact-SHA staging checks, credential environment separation, existing-test changes and documentation. No additional actionable findings were established in those areas.

I did not rerun the full 530-test suite or the PostgreSQL recovery suite; their reported results are author evidence, not this reviewer's independent execution. No provider mutation, account creation, paid operation, terms acceptance, deployment, live credential access or merge occurred. Provider-link, R2 and Pages hosted gates remain closed; their real receipts, account identities and service-binding behavior still require the separately authorized hosted qualification after these findings and CI are resolved. This report does not approve release or deployment.

## Re-review of the fixes, October 16, 2026

Reviewed the uncommitted diff from `a9f3cf3f5dceda2a3136064a9e4fd09e4678757c`: `bootstrap.ts`, `provider-link.ts` and their three changed test files. Both reported findings are resolved; no remaining blocker was established in this diff.

- R1: the binding and start-event reads now occur after reservation acquisition. A newly committed binding blocks initialization, and the losing caller releases its newly acquired reservation. An existing uncertain reservation remains fenced on a wrong-workspace resume. The new unit regression covers distinct private workspaces and delayed acquisition; the new integration regression uses two PostgreSQL connections and a separate fake provider process, asserts one remote project/init, preserves the winner's binding and checks reservation cleanup.
- R2: reconciliation validates the entire provider association set before accepting its one completed row. The three new cases cover completed+pending, completed+unknown and duplicate completed rows, replays, fencing of a different operation and eventual recovery without issuing another grant.

Independently reran both focused files: **21 tests passed**, no skips. Reran both original reproduction scripts against the updated build: the bootstrap race now makes exactly one initialization and returns a controlled `blocked` result for the loser; the mixed provider status now returns `outcome_unknown` and retains its uncertain reservation/in-flight effect. No implementation files were changed by the reviewer.

The author's full disposable-PostgreSQL run is separate evidence and was still in progress at the time of this re-review. I did not independently rerun that integration suite. CI and actual hosted account/resource/Pages qualification remain separate gates; this re-review approves the two local fixes, not production deployment or release.

## Read-only review of local hosted qualification preparation

Reviewed `/Users/gregmushen/.codex/qualifications/trestle-prod-qual-20261016`, especially `operator/control-bootstrap.mjs`, against the owner's approved synthetic scope. No remote execution was performed by this reviewer.

One execution blocker was found and fixed during review: the installed Neon CLI emits an unquoted connection URI even when `--output json` is set; the helper's unconditional JSON parse would therefore fail after creating the control project. The script now uses `connection-string --extended` and reads `connection.connection_string`. I checked that behavior against the installed handler at `.../neon/dist/commands/connection_string.js:128–141`, and the modified operator script passes `node --check`.

No remaining blocker was established in the preparation inspected. The control bootstrap explicitly selects the Scribbl profile/organization, checks its free plan, refuses reuse by name, creates only the authorized independent control project, and uses an exclusive pre-effect journal so timeout/lost response cannot silently trigger another create. Create/list output excludes credentials; the connection response stays in process memory and is saved through the existing encrypted-secrets helper. The journal and success/error logs contain identifiers/status only. The qualification root and operator directory are private; master keys are ignored by the supplied ignore rules. The synthetic Worker returns only the test probe, and the Pages binding names that Worker under the intended account-specific Worker config. State remains `prepared_local_only` with no resources recorded.

This is a read-only preparation review, not proof of remote identities, provider free-plan enforcement, hosted behavior, usage charges, CI completion or deployment. The reviewer did not run the operator script, read real credentials or provision anything.

## First hosted bootstrap: follow-up static triage

A subsequent hosted attempt returned an unresolved bootstrap outcome. Static/local investigation is recorded in the [hosted triage and qualification record](STRIPE_PROJECTS_HOSTED_QUALIFICATION_20261016.md). It establishes a new native-plugin retry safety blocker, confirms that requested-account manual mode itself is valid, and identifies missing durable inspection/outcome diagnostics. It does not establish the original call's root cause or justify retrying it. No provider calls or credential reads were made by the reviewer during this triage.

## Re-review of bootstrap gate, diagnostics and durable inspection

Reviewed the uncommitted framework diff from `812aa3b7b083761cbb1a40def4deea23e719d271`. The real bootstrap capability now correctly stays blocked for the native retry/idempotency uncertainty. Test-only simulation evidence is explicit and not wired into the real CLI. Durable operation inspection correctly prefers the PostgreSQL record/events/reservations and does not silently fall back to local checkpoints when a control database is configured. The added reservation lookup is scoped by a parameterized operation ID. Diagnostic events preserve the uncertainty/no-resend behavior.

One remaining finding (P2) in `redaction.ts:safeInfraDiagnostic` / `sanitizedInfraValue`: ordinary opaque credentials are not redacted. A synthetic direct call with `Authorization: Bearer cfsyntheticopaquetoken01234567890123456789` returns that header unchanged; a synthetic nested record containing `CLOUDFLARE_API_TOKEN` and `password` members also prints their values. The existing content recognizers do not identify arbitrary Cloudflare-style tokens or passwords. The new diagnostic persistence and durable inspector should additionally redact auth headers/common secret assignments and credential-named object fields, while retaining content scanning for credentials hidden under innocent keys. Add synthetic regressions for these cases. No real credential was used in this reproduction.

Independently ran bootstrap, provider-link, Pages and redaction files: **37 tests passed**, four files, no skips. Did not run another PostgreSQL suite concurrently with the author's full run. No provider calls or credential reads occurred. Pending the sanitizer correction, the local re-review remains changes requested; the native bootstrap remains intentionally unqualified, not fixed by these diagnostics changes.

## Final local re-review after the sanitizer correction

Rechecked the complete uncommitted diff from `812aa3b7b083761cbb1a40def4deea23e719d271`, including the narrow sanitizer follow-up. The opaque-credential finding is resolved for the demonstrated Bearer/Basic headers, credential-labeled assignments and nested credential-named fields. Content-based scanning is retained for values under unrelated keys, and nonsecret fencing/public-key/operation metadata is preserved. The added synthetic regression covers the original counterexamples.

Independently reran the four focused files: **38 tests passed**, no skips; `git diff --check` passes. No remaining actionable blocker was established in this local diff. The real bootstrap gate is still closed; fake-provider tests do not reopen it. The canonical durable inspector and bounded diagnostic changes are acceptable for this scope. This is approval of these local changes, not a claim that arbitrary unlabelled free-form text can always be identified as secret.

The full serial PostgreSQL/build/typecheck run remains the author's separate verification. I did not run a competing database suite. No remote actions or credential reads occurred during re-review. The existing native bootstrap attempt remains uncertain/fenced, and its native duplicate-create behavior remains unqualified. Hosted Pages adapter evidence is separate from normal signed-apply qualification and does not itself change the gate.

## Independent review of observe-only bootstrap inspection

Reviewer: Codex independent reviewer `/root/trestle_246_independent_review`.
Date: October 16, 2026. Reviewed the uncommitted inspection diff based on
`a1c703741b09cafda5c2270668e3de1cf1a87a01`.

Decision: **accepted for observation only; no actionable blocker found in this
change**. This acceptance does not qualify native project creation, approve
binding reconciliation, or resolve the existing unknown attempt.

`inspectBootstrap` exposes only operation/event/reservation/generation reads and
an adapter with `observe`; it has no creation, binding or fence-clearing method.
It checks the stored operation's exact plan digest/environment, original intent
and workspace, reservation/binding ownership, observed account/environment and
empty-project identity, and any recorded creation receipt. Expired creation
approval and the closed creation capability no longer prevent these reads.
Missing or inconclusive provider state stays unresolved. Even a matching
observation explicitly reports `observationOnly: true` and leaves the store
unchanged. The CLI invokes this separate boundary rather than resuming apply,
sanitizes its output, and returns a nonzero outcome when unresolved.

Independent verification: bootstrap, provider-link, Pages and redaction suites
pass **42 tests in four files**, no skips; `git diff --check` passes. The new unit
cases cover expired/blocked creation authority, missing configuration,
plan/operation/workspace mismatch, account/receipt mismatch, sanitized output
and unchanged durable state. The CLI/PostgreSQL regression was reviewed in
source but was not rerun by this reviewer while the author's serial database
suite was active. No provider commands, live credential reads, remote changes
or implementation edits occurred during this review.

Additional denial cases worth adding as follow-up coverage are foreign
reservation ownership or effect IDs, foreign/conflicting committed bindings,
missing/duplicate bootstrap intent events, incomplete or nonempty observations,
wrong observed environment, pending/malformed project IDs and an observation
exception. Their corresponding checks are present in the reviewed code; these
are coverage recommendations, not established implementation defects.

The original empty-workspace attempt remains unknown and fenced. Current
absence from a listing cannot justify another initialization. A future binding
or fence change requires its separately reviewed reconciliation contract and
fresh signed authority for the exact original operation and project identity.
