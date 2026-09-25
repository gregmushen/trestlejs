# TrestleJS Platform Hardening Specification

**Status:** Implementation contract; P2, P3 and P5 done, P1 existing-app migration and P4 gaps open. Rebased on `main` at `0.1.0-beta.1` (`6a331a0`). The first draft was written against `0.1.0-alpha.42`.

**Parent specification:** [TrestleJS Specification](TRESTLEJS_SPEC.md)

## 1. Objective

Make the existing foundation safe for four things:
- related tenant records;
- private background work;
- application crons;
- the lifetime of event provenance.

These are focused changes to existing mechanisms, not new subsystems. Existing generated applications own their source, so each change ships with an adoption note: updating the package does not patch copied files or migrate their database.

| Change | Status on `main` | Needed before |
|---|---|---|
| P1 Tenant-safe generated relationships | Done for newly generated relations; existing-app migration open | relying on generated tenant relationships |
| P2 Trusted background execution | Done (§3) | private background handlers |
| P3 Preserve application crons | Done | deploying application crons |
| P4 Order-safe billing reconciliation | Done (alpha 91–94); gaps in §5 open | paid launch |
| P5 Provenance lifetime and replay | Done (§6) | provenance cleanup; required by P2 |

Remaining: the P1 preflight and constraint migration for existing applications, and the P4 gaps.

**Lifecycle rule (P2 + P5).** A private handler executes (start, retry, dead-letter replay or Workflow resume) only while its committed event is at most 14 days old, measured from the committed `occurredAt` with an injected clock. Workflows reverify at every execution of the consume step. Committed provenance is retained for 30 days. So pruning never removes provenance that permitted work can still need, and needs no Workflow-state exclusion.

## 2. P1: Tenant-safe generated relationships

**Problem.** `packages/cli/src/generate-resource.ts` generates relations as `uuid(col).references(() => parent.id, …)`, a reference by ID only, and `resource add-field` uses the same path. A child's tenant policy doesn't guarantee that its parent belongs to the same tenant. This is a gap in referential integrity; no cross-tenant read exploit has been demonstrated.

**Required behavior**
1. Every generated relation between tenant resources enforces equal tenant identity at the database: a composite foreign key from `(organization_id, <parent>_id)` to the parent's `(organization_id, id)`, backed by a unique constraint on the parent.
2. Keep the ID primary key and the public API. Clients never submit a tenant value; the execution context supplies it.
3. Optional parent references may be null. Tenant identity is never null.
4. Reject unsupported relation targets before writing any files. Never quietly fall back to an ID-only reference.
5. Keep the declared delete behavior. A composite `SET NULL` must never null the tenant column, so name the child column in the action (PostgreSQL 15+ `ON DELETE SET NULL (col)`) or keep the prior behavior some other way.
6. Forced RLS and the restricted runtime grants stay as they are. The composite constraints add to RLS.

**Generator and migrations**
- Generation and add-field produce the same protection.
- When several relations point at the same parent, generate the parent's unique constraint only once.
- Constraint names are stable and fit PostgreSQL's identifier limit.
- Generator metadata and migration snapshots stay consistent.
- For existing projects, provide a preflight query that finds cross-tenant links and missing parents.
  - It never repairs, reassigns or deletes rows.
  - It aborts with counts and guidance for the operator.
  - Add and validate the new constraints before dropping the old reference, and document the locking involved.

**Acceptance.** Test against real PostgreSQL using the restricted runtime role:
- same-tenant creates and updates succeed;
- cross-tenant links fail on both insert and update, even when the parent ID is known;
- null optional references succeed, and missing parents fail;
- deleting a parent follows the declared policy and never nulls tenant identity;
- the migration succeeds on valid data and fails safely on invalid data;
- generation and add-field produce equivalent constraints;
- the existing isolation suites still pass.

## 3. P2: Trusted background execution

**Status: done.** Implemented in the generated template:
- `verifyCommittedEvent` (`packages/db/src/event-provenance.ts`) reloads the committed outbox row and compares every execution-relevant field canonically (`occurredAt` by instant), then rejects rows older than 14 days. `handleEventWithInbox` (Queue) and the Workflow step use it, with or without webhooks. The Workflow Queue consumer also verifies and authorizes (tenant provenance) before `create`, so a forged message cannot claim the stable instance ID and an event the Workflow would reject goes to the dead-letter queue without starting an instance.
- **Authority.** Undeclared registrations are `"verified"`: the committed event, `organizationId`, `log` and `clock`, and no database. `{ authority: "tenant" }` adds `context.data`, a lazily opened tenant database under forced RLS, closed after the handler completes or fails. `{ authority: "system" }` needs no tenant and gets neither. Missing tenant provenance is `tenant_provenance_missing`, never wider access. Generated handlers declare `"tenant"`.
- **Not a sandbox.** Handlers still receive the raw Worker `environment`, including `DATABASE_URL`, so a handler can bypass its declared authority. The context is the supported seam; closing this needs a breaking handler signature.
- **Entitlements.** `{ requires: { entitlement } }` reads the tenant's current entitlements at handling time. If absent, only that handler is skipped (`event.handler.skipped`, reason `not_entitled`); webhook projection still runs and the event completes. A later grant does not re-run it.
- **Failures.** `PermanentEventError` (`provenance_missing`, `provenance_mismatch`, `provenance_expired`, `tenant_provenance_missing`) never reaches the handler and leaves no inbox row. Queues log `queue.event.rejected` with ID and reason, no payload, and retry into Cloudflare's dead-letter queue; Workflows throw `NonRetryableError`. Neither is acknowledged as handled. Store and other transient errors stay retryable.

**Problem.** Re-reading the committed event (`findCommitted`, `packages/db/src/outbox.ts`) is used only on the webhook paths (`webhook-projection.ts`, `webhook-runtime.ts`, `webhook-work.ts`). Application handlers in `apps/worker/src/async-runtime.ts` receive the queue envelope without verification, and the Workflow path doesn't verify anything.

**Required boundary.** A queue or Workflow message is a reference to work, never the authority for it. Before a private handler runs:
1. Validate the event against its registered schema.
2. Re-read the committed event and its trusted tenant provenance by event ID.
3. Check the supplied envelope against the committed record, field by field: identity, type, version, resource, payload, idempotency and correlation data. Compare canonically, so key order can't cause a false mismatch.
4. Give the handler the committed record as its input. That record is the only source of tenant identity.
5. Resolve the handler's declared authority, its scoped database, services, logger and injected clock.
6. Load current authorization and entitlement state where the handler needs it. A past event doesn't grant permanent permission.

Move the verification out of the webhook code into a shared primitive, and use it on the private Queue and Workflow paths. It must work when outbound webhooks are disabled.

**Registration contract**
- Handlers explicitly declare tenant or system execution and the narrow capabilities they need. A missing declaration fails closed.
- A system principal identifies an operation. It is not an administrator, it doesn't impersonate a user, and it doesn't bypass RLS.
- Missing tenant provenance never promotes a handler to global access.
- Handlers that only parse or log may stay unscoped, but they get no access to private data.
- Existing handlers get an explicit adoption path. Legacy registrations don't silently gain authority.

**Failure semantics**
- Unknown, mismatched or expired provenance never reaches the handler. Record a structured failure category and the event ID, without the payload.
- Transient failures retry a bounded number of times. Invalid messages go to the dead-letter queue and are never marked as handled.
- Inbox completion follows successful handler completion. Don't claim exactly-once delivery.

**Acceptance**
- Valid events reach the handler with the committed tenant.
- A forged payload, resource, tenant, type or version can't reach private code.
- Missing provenance fails closed.
- Queue and Workflow paths enforce the same boundary, including with webhooks disabled.
- Duplicates, failures, retries and database outages keep the inbox correct.
- Concurrent handlers for different tenants never share tenant context.
- Fixed-clock tests are deterministic.

## 4. P3: Preserve application crons

**Problem.** `packages/create/template/scripts/queue-config.mjs` replaces the target environment's crons with `["* * * * *"]` whenever Queues or R2 are enabled, and `queue-config.test.mjs` asserts that. The `scheduled` handler in `apps/worker/src/index.ts` ignores which trigger fired.

**Required behavior**
- Keep the environment's existing cron expressions, in order.
- Append the framework's minute expression only when Queues or R2 need it and it isn't already there.
- Remove duplicates without reordering the rest.
- Keep other trigger properties and all unrelated configuration.
- When no capability needs maintenance, add nothing and remove nothing.
- Rendering is idempotent and never mutates its input.
- A malformed trigger list is reported as a configuration error, never replaced.
- The `scheduled` handler runs framework maintenance only on the framework tick, which is `controller.cron === "* * * * *"`. Every other cron dispatches to the application.

**Relationship to the planned scheduler.** The roadmap backlog replaces the minute tick with a due-time Durable Object scheduler plus slower maintenance crons. Those crons must merge with the application's crons by the same rules, so this fix stays needed.

**Acceptance.** Test:
- missing and empty lists;
- an hourly application cron;
- a minute cron that's already present;
- duplicates and unrelated trigger properties;
- Queues only, R2 only, both, and neither;
- repeated rendering;
- other environments left unchanged;
- dispatch with both an application trigger and the framework trigger.

## 5. P4: Order-safe billing reconciliation (remaining gaps)

Alpha 91–94 made billing order-safe:
- verified webhooks fetch current Stripe state;
- a per-subscription generation counter fences out stale writers (migration 0029, `packages/db/src/billing-events.ts`);
- an older in-flight lookup is marked superseded;
- tenant ownership is immutable;
- the projection, entitlements, outbox and receipt commit together.

Remaining:
- **Durable reconciliation request.** Reconciliation runs inside the webhook request. A successful response should mean the receipt and the reconciliation work are committed, not that the provider fetch succeeded. Queue it through the existing outbox or inbox.
- **Local adapter parity.** The local payment adapter should reconcile the same way, so local tests cover the ordering behavior.
- **Live sandbox evidence** before paid launch; this is already a beta gate in the ROADMAP.

## 6. P5: Provenance lifetime and replay

**Status: done.** The window is declared and enforced. Supported delivery and replay last 14 days (`EVENT_REPLAY_WINDOW_DAYS`) and committed provenance is kept for 30 (`EVENT_PROVENANCE_RETENTION_DAYS`). `pruneSucceeded` and `countPrunableSucceeded` refuse a cutoff newer than now − 30 days, with the latest allowed cutoff in the error. Pruning goes through migration-created SECURITY DEFINER functions (`trestle_prune_outbox_provenance`, `trestle_count_prunable_outbox_provenance`), owned by the NOLOGIN role `trestle_retention` and executable only by the migration role. `trestle_retention` holds column-level SELECT on the columns the checks read, DELETE on `outbox_message`, and SELECT-only RLS policies on `webhook_message` and `webhook_delivery`; no login is left a member of it. The functions see every tenant's rows despite forced RLS and skip any row still referenced by an inbox claim active within the replay window or by a non-terminal webhook delivery. `trestle queue prune` reports the count and the age of the oldest succeeded row kept. A pruned row surfaces as P2's `provenance_missing`; an older row that still exists is `provenance_expired`. "Succeeded" means *sent to the Queue*, not consumed: a message still queued has no inbox row, so only the 30-day window protects its provenance. Migration 0033 adds `trestle_retention`, its grants and policies, the functions and a `webhook_message(source_event_id)` index. A non-superuser migration role (Neon's database owner, for example) is granted `trestle_retention` only for the ownership transfer and revoked again. Webhook replay follows the same window: customer and platform replay of a failed delivery are refused (`provenance_expired`) once its source outbox row is pruned or older than 14 days, and a native delivery in that state is settled as `exhausted` (`provenance_expired`) by its Queue consumer or the recovery cron rather than left in retry.

**Problem.** `trestle queue prune --before <cutoff> [--apply]` deletes succeeded outbox rows older than a cutoff the operator chooses (`pruneSucceeded`, `packages/db/src/outbox.ts`). A row is marked succeeded when it's published, which can happen before downstream work finishes. Pruning can therefore delete the provenance P2 needs to authenticate a delayed message, retry, dead-letter replay or Workflow.

**Required contract**
- Declare the supported window: maximum queue delay, retries, dead-letter replay age, Workflow duration, plus a safety margin. Derive retention from those limits instead of picking a number.
- Reject a prune cutoff inside the declared window, with an actionable error.
- Never delete provenance that pending or active work still references. If completion can't be determined, keep the row.
- A late replay outside the window fails closed with a distinct "provenance expired" outcome. Authority is never reconstructed from the queue payload.
- Cleanup is bounded and safe to run concurrently. Report counts and the age of the oldest row kept.
- Keep "published", "consumer completed" and "replay eligible" separate in both code and docs.

Keep full outbox rows as the provenance store for now. Add a separate compact store only if storage cost is measured and becomes a problem.

**Acceptance**
- An event is published and marked succeeded, consumption is delayed, prune runs, and the handler still succeeds inside the window.
- Also cover retry, a pending Workflow, dead-letter replay, boundary times with an injected clock, concurrent cleanup, and explicit expiry outside the window.
- An invalid retention configuration never deletes required rows.

## 7. Definition of done

Each change includes:
- a focused regression test;
- documented defaults;
- an adoption note for generated applications: which template files changed, migrations, handler-registration updates, and operational settings.

Security and integrity tests run against real PostgreSQL with the actual runtime grants. Record executed and skipped suites separately: a green run with no database configured is not evidence. A clean canary generated from the changed template must install, typecheck, test, build, and pass `trestle architecture check` and `trestle doctor`. Completion evidence names the framework commit, the canary result, the migrations tested, and any verification that can only happen in a deployment.

For existing installations:
- pause provenance pruning before deploying trusted consumers;
- apply additive migrations before the code that needs them;
- run the relationship preflight before adding constraints;
- recover with forward fixes, never by restoring stale billing writes or permissive background authority.
</content>
</invoke>
<invoke name="Bash">
<parameter name="command">cd ~/work/code/gstack-specs && grep -n "controller.cron\|scheduled" packages/create/template/apps/worker/src/index.ts | head -5; grep -n "pruneSucceeded\|findCommitted" packages/create/template/packages/db/src/outbox.ts; ls packages/create/template/packages/billing/src/ | grep -i event; grep -n "references(() =>" packages/cli/src/generate-resource.ts | head -3