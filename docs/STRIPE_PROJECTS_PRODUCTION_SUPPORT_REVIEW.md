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
