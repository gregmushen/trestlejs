# Read-only triage of first hosted bootstrap ambiguity

Framework HEAD: `812aa3b7b083761cbb1a40def4deea23e719d271`.
Pinned local Projects plugin: `0.45.0`, SHA-256 `187cbb898aed495a54aa357b29d71234105c15d29e1ec195019cc570d9b3bf77`.

No provider command, mutation, credential read, uncertainty clearing or retry was performed by this reviewer. This investigation inspected repository source and JavaScript source embedded in the local plugin binary via `strings`.

## The original cause is not established

The captured command's `--account` plus `--mode manual` combination is valid in the embedded `initCommand` handler. Its condition rejects an account only with guided/template mode or preflight. Removing explicit manual mode is therefore not an evidence-based fix.

A bare preflight is not an exact simulation of the requested-account flow. Explicit `--account` invokes `resolveAuthorizedAccountContext`, which calls `hasPluginOwnedCredential`, checks the signing merchant, and runs `enforceAccountReadiness` using the `account_readiness` endpoint. It can stop before project creation for account-readiness/context/authentication reasons; this is a possible difference, not proof of the actual cause.

The wrapper erased the original reason. `bootstrap.ts:103–104` converts any thrown exception to an undifferentiated unknown answer; it also does not append the adapter's returned unknown reason or its final observation failure. The durable events cannot now distinguish a local process exception, unparseable native output or an actual transport ambiguity. A short elapsed time, empty workspace or currently empty listing does not prove that no remote request was issued.

Keep this operation uncertain. Do not repeat init or clear its fence from these observations alone.

## New safety blocker: the native init retries its own create POST

Although Trestle invokes init at most once, the pinned plugin's embedded `initCommand` code uses `maxRetries = 2` around:

```
client.typedRawRequest("POST", `${PROVISIONING_INTERNAL_PREFIX}projects`, {
  ...catalogPartition && { catalog: catalogPartition },
  name: initTarget.projectName
});
```

Except for an immediate 403, its catch waits five seconds and makes another call. No stable idempotency key is supplied across these calls. The embedded typed wrapper forwards each call to SDK `rawRequest`. `createStripeSdkClient` sets `maxNetworkRetries: 1`, and the SDK's `_defaultIdempotencyKey` generates a fresh UUID for each new raw request. That protects an SDK's internal retransmission, but does not deduplicate the surrounding init loop's separate second call.

Source can be located with:

```
strings <pinned-plugin> | sed -n '224210,224258p'
strings <pinned-plugin> | sed -n '186405,186455p'
strings <pinned-plugin> | sed -n '186588,186610p'
strings <pinned-plugin> | sed -n '163945,163963p'
```

The exact runtime offsets are incidental; search for `const maxRetries = 2`, `Creating project`, `createStripeSdkClient`, `createTypedRawRequest` and `_defaultIdempotencyKey` to relocate them.

One wrapper call can issue two create requests with different SDK idempotency keys. Without a proven server-side deduplication guarantee, this cannot establish the required single-project behavior when the first response is ambiguous. The fake provider currently cannot expose this native internal loop. This does not prove a duplicate occurred in the first hosted attempt; it does prevent treating the bootstrap mutation as qualified for its no-duplicate guarantee. Block further bootstrap creation until a qualified native path/version provides stable idempotency or eliminates that application-level retry, or separately review a supported implementation that provides that guarantee. Do not bypass the pinned toolchain or repeat the existing uncertain operation.

## Recovery tooling must read the durable journal

`commands.ts:348–358` implements `infra operation show` by reading only `.trestle/infrastructure.local/operations/<id>.json`. The new bootstrap, link and Pages paths store their actual operations/events in the independent PostgreSQL store and do not create this file. The documented inspector consequently reports no operation when its authoritative journal exists.

Make operation inspection read the control-store operation/events and related reservation state, with sanitized output and explicit unavailable/not-found distinctions. A local file may be optional cached reporting, but must not be authoritative or conceal the durable record. Add a CLI regression for a bootstrap stored only in PostgreSQL.

Persist a bounded, redacted/allowlisted adapter outcome classification and observation-failure reason before returning unknown in new paths. Do not dump raw child output, credentials, stacks or provider authorization links into public logs. A deterministic local adapter rejection should retain its classified status; genuine ambiguity must continue to remain fenced.

## Maintainer qualification results and fixes

The owner approved this bounded synthetic run after independent review and CI passed at `812aa3b`. Production and application payments remained outside scope. The run created one independent free Neon control project, one tiny synthetic Cloudflare API Worker and one Pages project. Exact private account/resource identities and encrypted recovery locations are retained in the downstream deployment record. No provider grant or R2 create was attempted; no automatic cleanup, paid-plan change or payment-method change occurred.

The first project bootstrap remains `outcome_unknown` with its in-flight effect fenced. Read-only observations still show no new Projects project and no local project configuration. Those observations do not prove the absence of an outstanding effect. The operation was not repeated, cleared or rebound.

The real Pages host adapter passed native account/project/clean-revision preflight, compiled-Functions upload, structured deployment-receipt validation, exact operation/artifact marker retrieval, static asset delivery and a real Pages-to-Worker service-binding request. Pinned Wrangler: `4.135.0`; reviewed implementation digest `349a64add4ed2638c36ef64e20ad694951172fff01c2127aa79db036872bb9a6`; artifact `sha256:b9709a6d999820a0c04e238fe87c43f4882113ce9570c7c070375170fa7b0f9a`. This standalone native-adapter probe was explicitly identified as conformance, not a normal executable InfraPlan or signed apply. It does not promote the full Pages path, production staging checks, real API/database readiness or clinical acceptance.

Wrangler's new-project creation path initially tried to delegate Pages creation to Workers, then failed locally before deployment. Both the Pages and delegated Worker targets were independently observed absent. Installed implementation inspection confirmed that `pages project create --force` explicitly selects Pages for that new target, which matched the owner's Pages request. That native creation succeeded. Existing Pages targets do not take the delegation branch; the adapter already requires an existing target. No automatic deployment to a different resource kind was accepted.

Follow-up changes block real bootstrap creation on the native retry/idempotency unknown; expose durable operation/events/reservations through `infra operation show`; and retain bounded, credential/URL/header-redacted native outcome diagnostics. Fake bootstrap fixtures explicitly opt into qualified simulation evidence and cannot enable CLI mutation. New safety and diagnostic regressions failed before their corresponding fixes. Opaque token/password/header redaction also received a separate failing regression after independent re-review.

Further project bootstrap, provider grant and R2 qualification requires a supported path with proven stable create idempotency, plus reconciliation of the existing uncertain operation. Do not silently upgrade the plugin, patch the vendor binary, bypass the evidence gate or treat a current empty listing as permission to retry. Full signed Pages apply remains unverified while the project binding is unresolved. Retain the synthetic resources and the independent journal.

## Bootstrap recovery investigation

The owner subsequently asked to resolve the blocker and reconcile the original
attempt while leaving application payments alone. Plugin `0.50.0` was downloaded
through the official installer into a separate credential-free local directory;
the active `0.45.0` installation was not upgraded. Candidate SHA-256:
`a06ef1e255e98c24da711cccb5832896ad3cca9505786910115696b3b4a20ab9`.
Its embedded manual-init implementation retains the same two-attempt create
loop and does not supply a shared idempotency key. This source inspection is
not a hosted probe or proof that a duplicate occurred. Upgrading alone does
not resolve the blocker. The official Tools operation search returned no
Projects creation or historical request-log operation; no feedback was sent.

Read-only inspection again found only the earlier framework test project.
The original attempt's private workspace still returns `NO_PROJECT_CONFIG`.
Dashboard request-history inspection requires the owner's sign-in; no
credentials were entered or authentication attempted on the owner's behalf.
The original request's outcome and cause remain unproven.

An independently identified local recovery gap is addressed by
`infra project inspect`: creation expiry and the withdrawn create capability
previously prevented apply from reaching observation at all. The separate
inspection function receives only store read methods and an `observe` adapter.
It validates the original operation/digest/workspace/target, checks reservation
ownership and conflicting receipts/bindings, and reports a sanitized observation.
It has no binding write, reservation write, credential pull or initialization
path. It accepts an expired original plan for observation only. Inspection of
the retained real attempt returns `unresolved`; no fence was removed.

Resolution needs two separate pieces of evidence:

1. Original-attempt evidence: a terminal provider/request record identifying
   every created project, or authoritative confirmation that the request did
   not create a project and cannot still complete. Preserve the original
   account, UTC time, operation ID and plan digest in the private operator
   record. A current name search or elapsed time is insufficient. An observed
   identity alone does not authorize binding/fence changes; those require fresh
   signed reconciliation authority for the original operation and exact identity.
2. Future-create support: a supported native implementation exposing a durable
   per-operation idempotency key across all retries, or a proven single-attempt
   create path without an application-level resend. Qualify response loss and
   recovery against that exact implementation before reopening the gate.

Do not use native `pull` as an observation shortcut. Static independent review
found it unconditionally fetches environment credentials, writes local env/vault
state and can rotate expiring credentials; no metadata-only flag is exposed in
the inspected code. An undocumented private-API replacement, vendor-binary
patch or repeated `init` is not adopted by this investigation.
