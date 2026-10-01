# TrestleJS Stripe Projects Provisioning Specification

**Status:** Draft v0.2 — design only; adversarial review incorporated

**Date:** 2026-10-01

**Review:** Section 35 records the adversarial findings, requirement changes,
and required falsification tests. These are design resolutions, not tested
implementation guarantees.

**Component:** Infrastructure provisioning, environment lifecycle, credentials,
and deployment orchestration

**Preferred provisioning backend:** Stripe Projects

**Implementation plan:** [Work packages, dependencies, tests, and release gates](STRIPE_PROJECTS_IMPLEMENTATION_PLAN.md)

**Parent specification:** [TrestleJS Specification](TRESTLEJS_SPEC.md)

**Related designs:** [Integration Primitives](INTEGRATION_PRIMITIVES_SPEC.md),
[Proof-Oriented Engineering](PROOF_ORIENTED_ENGINEERING_SPEC.md)

## 1. Purpose

Trestle should use as much of Stripe Projects as is practical for infrastructure
provisioning and lifecycle management. This includes account linking, resource
creation, credential retrieval and rotation, environment membership, service
plan changes, status, and controlled removal.

The goal is not a thin setup shortcut. Projects becomes the preferred backend
for supported infrastructure operations. Direct-provider adapters fill specific
gaps rather than duplicating capabilities already proven through Projects.

The architectural rule is:

**Trestle owns application intent, safety, configuration, and proof. Stripe
Projects manages supported infrastructure operations. Providers own their
external resources.**

This document specifies future behavior. New commands, schemas, and contracts
below are proposed; their presence here is not evidence of implementation.
Writing this specification does not authorize provisioning, spending,
credential rotation, provider terms acceptance, or resource deletion.

## 2. Documented baseline and evidence boundary

As reviewed on 2026-10-01, Stripe describes Projects as public preview. Its
documentation covers provider linking, provisioning, environment management,
credential pulls and rotation, upgrades, removal, status, and structured CLI
output. Cloudflare, Neon, and Resend appear in its provider list.

Credential pulls materialize local files; they do not install production-host
variables. Projects also stores credentials remotely in Stripe Secret Store.
Environment membership is separate from resource deletion. Removal can leave
previous credential material behind. These are integration constraints, not
proof of any particular provider's lifecycle guarantees.
[Source: Stripe Projects](https://docs.stripe.com/projects)

Stripe also documents a community template registry: manifests reference
application source at a pinned commit and declare services. The build flow
installs application dependencies before provisioning services.
[Source: Build templates](https://docs.stripe.com/projects/templates)

No live Projects provisioning or rotation conformance result is claimed here.
Provider availability does not prove resource coverage, least-privilege scopes,
safe adoption, unattended authentication, or zero-downtime rotation.

## 3. Goals

1. Make Projects the preferred provisioning path for supported operations.
2. Preserve an explicit, working direct-provider path for capability gaps.
3. Reuse provider lifecycle machinery instead of rebuilding it.
4. Provision and adopt resources without duplication or competing ownership.
5. Preserve local encrypted credentials, editor access, and explicit reveal.
6. Coordinate rotation through deployment and verified consumer cutover.
7. Keep application deployment independent of a runtime Projects connection.
8. Make mutations reviewable, bounded, resumable, and auditable.
9. Preserve explicit environment, account, project, and resource identity.
10. Support existing projects without silently migrating their infrastructure.
11. Test failures, ambiguity, retries, isolation, and recovery extensively.
12. Publish a Trestle starter in the Projects registry after conformance proof.

## 4. Non-goals

This work does not replace Trestle's BillingService, EmailService, Better Auth,
PostgreSQL authorization model, application migrations, or deployment contract.

Infrastructure subscription charges are separate from customers paying for an
application's plans. `trestle payments stripe ...` remains customer billing.

Projects bindings are deployment/operator infrastructure. They are not tenant
Connections from the Integration Primitives design. A tenant administrator or
support session cannot provision platform infrastructure or retrieve its keys.

This is not a new general-purpose infrastructure language, a promise to support
every Projects provider at launch, or a distributed transaction across vendors.

## 5. Ownership boundaries

| Concern | Responsible system |
| --- | --- |
| Desired application capabilities and environments | Trestle application source |
| Reviewed operation graph, authorization, and evidence | Trestle |
| Supported account and resource lifecycle operations | Stripe Projects |
| Provider resource existence, limits, and actual credentials | Underlying provider |
| Unsupported provider operations | Explicit direct-provider extension |
| Database roles, grants, forced RLS, and migrations | Trestle database tooling |
| Worker bindings, host secret projection, application deployment | Trestle deployment tooling |
| Customer subscriptions and entitlement projections | Existing application billing boundary |
| Application-owned secret values | Trestle encrypted credentials |
| Projects-managed credential issuance | Provider through Projects |
| Deployed readiness | Trestle checks against the deployed application |

There must be one lifecycle owner for each resource. Ownership also identifies
which adapter may mutate each field or subresource. For example, Projects may
own a database instance while a Trestle extension owns its application roles.
The extension must not resize, replace, or delete the instance behind Projects.

## 6. Architecture

```text
Application manifest + environment policy
                  |
         Trestle infrastructure planner
                  |
         reviewed, identity-bound plan
                  |
         durable operation coordinator
                  |
       +----------+--------------------+
       |                               |
Stripe Projects adapter       direct-provider extensions
       |                               |
       +------------- providers -------+
                         |
            validated resource/credential outputs
                         |
        encrypted credentials + typed configuration
                         |
         database setup / bindings / deployment
                         |
         application checks + scoped evidence
```

The coordinator runs outside the application runtime. A running Worker must
not need the Projects CLI, its account authorization, or its credential vault.

## 7. Capability discovery and support policy

Each adapter exposes a versioned capability descriptor. Support is recorded by
provider, exact service identifier, operation, plugin version, and relevant
account/tier restrictions. A single `supported: true` per provider is inadequate.

Required operation metadata includes:

- discovery, linking, creation, adoption, inspection, and deletion support;
- credential enumeration, retrieval, issuance, rotation, and revocation support;
- plan/tier transitions and their cost and reversibility properties;
- environment scoping and cross-environment sharing behavior;
- retry, idempotency, pagination, rate-limit, and ambiguous-outcome behavior;
- rotation invalidation timing and overlap support;
- unattended authentication requirements;
- structured-output schema and supported tool versions;
- evidence status, last verification time, and known limitations.

Evidence statuses are `documented`, `locally_tested`, `hosted_verified`,
`unsupported`, and `unknown`. These describe observations, not interchangeable
levels of readiness. A required unknown safety property blocks the mutation.

Evidence is scoped to the operation, toolchain, relevant provider behavior, and
account constraints, with a policy-defined freshness window. Changed scopes,
tools, behavior, or counterexamples invalidate affected qualification until
re-tested. Earlier evidence does not authorize a different implementation.

Capabilities describe all underlying command effects, including automatic
credential pulls, local writes, account creation, and related credential
changes. If a command bundles an unapproved effect that cannot be disabled or
safely isolated, block it rather than describing only its primary effect.

If an operation is proven through Projects, use Projects. If it is unsupported,
offer a declared extension. An outage, expired login, or transient error must
never trigger an automatic switch to a different resource owner.

## 8. Initial provider capability matrix

The following rows are investigation and implementation requirements, not a
claim that every operation is already available through Projects.

| Provider | Prefer delegation where supported | Trestle responsibilities and required probes |
| --- | --- | --- |
| Cloudflare | Account association, supported service provisioning, plan changes, credential lifecycle | Verify exact Workers/Pages/R2/Queues/Workflows/Hyperdrive coverage; configure bindings, routes, host secrets, and deployments; inspect account-wide effects |
| Neon | Account association, database provisioning, supported credential lifecycle | Verify branches, role-level credentials, endpoints, pooling, region and recovery controls; establish migration/runtime/admin roles and forced RLS |
| Resend | Account association, supported service and key lifecycle | Verify key scopes, sender/domain management and webhook-secret support; enforce staging delivery policy and explicit live-send opt-in |
| Additional providers | Any verified capability needed by an application | Add conformance coverage and consumer mappings before claiming support |

The first integration spike produces a checked-in matrix with exact service
identifiers from the current catalog. Do not invent identifiers from provider
names. Catalog changes are reviewed; they do not silently expand permissions.

## 9. Source, state, and credential authority

Separate four types of information:

1. **Desired configuration:** source-controlled application intent.
2. **Bindings:** stable identities associating intent with external resources.
3. **Observed state:** timestamped provider observations, which can become stale.
4. **Credentials:** protected values with provenance and consumer mappings.

Projects retains its own state. Trestle must not manually rewrite undocumented
Projects internals or treat its local cache as authoritative provider state.
Use supported interfaces and versioned parsing boundaries.

Proposed application-owned files:

```text
.trestle/
  infrastructure.yaml             # desired configuration; no secret values
  infrastructure.bindings.json    # reviewed safe IDs and ownership metadata
  infrastructure.local/           # ignored local journal/cache, restrictive mode
config/
  credentials.yml.enc             # existing local encrypted credentials
  credentials/<environment>.yml.enc
```

Projects-created state files require a separate version-control policy review.
Do not infer that a file is safe to publish from its name or upstream advice.
Private account associations and resource IDs may be inappropriate in a public
starter. Verify teammate linking without committing secrets or private state.

In CI, operation journals and recovery material require a durable protected
store independent of an ephemeral runner and of the application database being
provisioned. Secret values never belong in ordinary CI artifacts or Git.

Maintain monotonic binding and credential generations in the protected control
store. Repository files propose bindings; an old checkout cannot override a
newer accepted generation. Writes use compare-and-swap against that generation.
Define journal retention, access, backup, recovery, and encryption-key custody
before remote mutation is enabled. Journal access must not depend on the
credential being rotated.

## 10. Resource identity and manifest

Each resource has a stable logical ID, environment identity, lifecycle owner,
provider account binding, service identity, external resource identity, deletion
policy, and credential-consumer references.

Illustrative schema, subject to implementation validation:

```yaml
schemaVersion: 1
backend: stripe-projects
environments:
  staging:
    projectsBinding: staging-infrastructure
    resources:
      database:
        provider: neon
        service: neon/postgres
        lifecycleOwner: stripe-projects
        disposition: create
        deletionPolicy: retain
        credentialBindings:
          database-bootstrap:
            output: DATABASE_URL
            destination: infrastructure-only
```

The output above is not automatically the runtime database URL. Trestle must
inspect its privilege and endpoint semantics and derive or provision the
appropriate application roles before wiring runtime access.

Resource names are labels, not identity. A safe binding includes the Trestle
project ID, Projects project ID, Stripe account ID, provider account ID,
environment ID, and exact external resource ID where available.

New resources may have unresolved IDs in the plan. Resolve them from the
journaled create operation and validated account-scoped observations, then bind
dependent steps to those exact IDs. Destructive or credential-changing steps
against existing resources require immutable IDs or an equivalently verified
identity mechanism. Name-only lookup is insufficient.

Sharing is explicit. Two environment names pointing to the same database or
key do not constitute environment isolation. The planner surfaces shared
resource, credential, quota, and billing blast radius.

## 11. Environment selection and concurrency

Every remote mutation requires an explicit `--env`. The target cannot be
inferred from a developer's current Projects environment selection.

The adapter must establish and verify the intended Projects account, project,
and environment before a mutation. Prefer explicit scoping supported by the
pinned CLI. If a version requires mutable active-environment state, use an
isolated workspace or an exclusive lock with pre/post identity verification.
Never switch a shared developer checkout's active environment in a CI job.

Acquire locks for the actual mutation scope, including shared account-level
resources. Cross-machine coordination cannot rely on local lockfiles alone.
Production mutation requires a shared lease and durable journal, or a proven
single-writer deployment mechanism. Lost leases stop new mutation attempts.

A lease does not fence a provider request already in flight. A replacement
runner must reconcile that request before takeover. Use downstream fencing
tokens where supported; otherwise use a serialized dispatcher that never
releases an uncertain target for conflicting work. Killing a child process is
not proof its remote operation stopped. Dashboard changes and raw CLI use
invalidate observations and require reconciliation; Trestle cannot prevent
external writers it does not control.

Preview identities include application, repository, and PR/run identity. Preview
resources cannot inherit production credentials or mutate shared production
membership. Cleanup targets exact owned preview IDs, not names or wildcards.

## 12. Planning and approvals

Trestle computes its own reviewable plan; do not assume Projects supplies a
native dry-run, transactional apply, or immutable plan token.

Each plan includes:

- source/configuration digest and exact tool/adapter versions;
- account, project, environment, and resource bindings;
- fresh observed state and observation time;
- dependency-ordered operations and credential-consumer changes;
- cost implications, account-wide effects, downtime, and data-loss risks;
- capability evidence and unknowns;
- preconditions, verification steps, and recovery options;
- plan digest, expiration, and required approvals.

Classifications include `no_change`, `create`, `adopt`, `configure`, `rotate`,
`upgrade`, `detach`, `delete`, `blocked`, and `unknown`.

Planning and status never provision, rotate, pull secret values, accept terms,
or modify billing. Offline planning labels observations stale. Apply refreshes
preconditions and rejects material drift instead of quietly revising the plan.

Approval is an authenticated control-plane record, not an editable plan field.
Bind it to canonical plan bytes/digest, source and artifact digests, operation
ID, target identities, allowed effects, cost/downtime limits, expiry, and actor.
A digest detects changes but does not authenticate the approver. Production
policy and approver authority come from a protected source outside the change
requesting privilege.

Apply consumes approval for one operation. Replaying the plan returns or
resumes that operation; it cannot authorize a second purchase or rotation.
Resume rechecks authority, approval validity, target state, and checkpoints.
Expired/revoked approval requires renewal for remaining effects without
repeating committed effects. Changed effects require a new plan. Emergency
forward recovery needs explicit bounded policy or fresh approval, not an
implicit bypass.

Paid operations require explicit cost authorization identifying account,
currency, tier, recurring versus usage charges, and any applicable budget.
Unknown cost cannot be labeled free. A local approval limit is not a provider
spending cap. Terms acceptance and payment-method setup remain explicit human
or previously recorded organizational authorization.

## 13. Proposed CLI surface

Use `trestle infra` for infrastructure lifecycle. Do not put these commands under
`trestle payments stripe` or create a second customer-billing interface.

All commands in this table are proposed additions.

| Command | Contract |
| --- | --- |
| `trestle infra init --backend stripe-projects` | Write local configuration; no remote resources or purchases |
| `trestle infra catalog [provider]` | Inspect sanitized service capabilities and evidence |
| `trestle infra link <provider> --env <env>` | Explicit account authorization/linking; no implicit account or service creation |
| `trestle infra adopt <resource> --env <env>` | Plan association with an existing exact resource identity |
| `trestle infra plan --env <env>` | Produce an immutable, secret-free operation plan |
| `trestle infra apply <plan-id> --env <env>` | Execute the approved plan with fresh preconditions |
| `trestle infra status --env <env>` | Inspect bindings, observed state, drift, and incomplete operations |
| `trestle infra doctor --env <env>` | Read-only infrastructure readiness checks |
| `trestle infra credentials pull --env <env>` | Import validated declared credentials; no provider rotation |
| `trestle infra rotate <credential-binding> --env <env>` | Create a rotation plan; does not rotate until apply |
| `trestle infra upgrade <resource> --env <env>` | Create a reviewed tier-change plan |
| `trestle infra detach <resource> --env <env>` | Plan association removal while retaining the resource |
| `trestle infra destroy <resource> --env <env>` | Plan destructive removal with explicit safeguards |
| `trestle infra operation show <id>` | Show sanitized checkpoints and recovery requirements |
| `trestle infra operation resume <id> --env <env>` | Resume verified unfinished steps, not repeat blindly |
| `trestle infra open <resource> --env <env>` | Open an allowlisted provider dashboard URL |

Adopt/detach are distinct contracts; they must not call a provider command that
deletes resources. Unsupported detach/adopt returns an explicit limitation.

Linking is a security-sensitive grant: confirm account and scopes and record
authorization. A command that cannot separate account creation from linking
needs an approved account-creation plan. Credential pull writes local protected
state: use generation locks and conflict rules, and never deploy implicitly.

Read commands support versioned `--json` output. Mutations report an operation
ID, completed steps, unresolved outcomes, and a nonzero result unless their
declared completion criteria pass. Plain status is redacted even in debug mode.

The existing SetupPlan remains the application setup entry point. A versioned
extension may reference infrastructure intent and expose the same operation
graph through `trestle plan diff` and `trestle apply`. This requires schema and
upgrade work; it must not make previously safe source-only apply unexpectedly
purchase or delete infrastructure. Existing plans remain source-only unless
they explicitly opt into infrastructure execution.

## 14. Provisioning and adoption

Provisioning follows a dependency graph: authorization, resource creation,
credential validation, application-specific configuration, deployment, checks.
Persist intent before each side effect and the observed outcome afterward.

Use provider idempotency only where verified. A Trestle operation ID is not
itself proof that a provider deduplicates requests. After a timeout, reconcile
by supported external identity before retrying creation. If the result cannot
be determined safely, stop with `outcome_unknown` and recovery instructions.

Adoption verifies account, environment, region, service/tier, resource identity,
current consumers, existing automation, and preservation requirements. A match
by display name alone is insufficient. Switching lifecycle ownership requires
an explicit handoff that disables the previous writer.

No adoption operation recreates a database, replaces credentials, imports
production data, or rewrites migration history as an incidental setup step.
Resource deletion defaults to `retain`, particularly for stateful services.

Do not automatically delete resources to roll back a partially successful graph.
Compensation is a separate effect covered by the original approval or a new
plan. Retry counts, elapsed time, backoff, and cost budgets are bounded.
Exhaustion leaves owned resources and a recovery record, not a recreate loop.

## 15. Credential classification and provenance

Credential metadata records source, issuance authority, environment, binding,
scope, version/reference if available, import time, rotation policy, and known
consumers. Do not publish raw or unsalted secret hashes as identifiers.

Three categories remain distinct:

1. **Projects-managed credentials:** issued by the provider through Projects;
   synchronized into an encrypted Trestle deployment snapshot.
2. **Application-owned secrets:** generated or edited through Trestle; not
   uploaded to Projects without a separate explicit opt-in.
3. **Operator provisioning credentials:** available only to the infrastructure
   process; never deployed to the application merely because they were pulled.

Non-secret configuration remains typed configuration. Public keys, service
URLs, secret-bearing database URLs, and privileged tokens are classified by
their actual contents and authority, not their names alone.

No pulled owner/admin database credential becomes a Worker runtime credential
without privilege validation. No Resend account-wide token becomes a send-only
runtime key if the adapter cannot prove the required scope.

## 16. Encrypted credentials and explicit editing

Preserve Trestle's local encrypted credentials and environment-bound encryption.
Developers can use their configured editor, including vi, and intentionally
show or export decrypted values through existing secret commands.

Normal planning, status, doctor, audit, and CI output never reveal values.
Explicit reveal/export is a separate user-invoked capability, not an incidental
side effect of troubleshooting. Editor temporary files and recovery files use
restrictive permissions and documented cleanup behavior.

Editing a Projects-managed value creates a visible local override. It does not
rotate the provider credential or update Stripe's remote store. A later pull
must report the conflict and require a choice: retain the override, accept the
provider value, or move the binding to application ownership. No silent
last-writer-wins merge. Application-owned values are preserved on every pull.

Credential issuance authority remains the provider. Trestle's encrypted
snapshot is the approved deployment input, not an independent key issuer.
Projects remote storage and credential access are disclosed during setup;
applications that prohibit that custody use an explicit alternative backend.

New infrastructure credential snapshots and recovery envelopes bind ciphertext
to project ID, environment ID, purpose, schema version, and generation using
authenticated metadata. The current environment-only envelope is not project-
bound. This requires a versioned migration/compatibility path; legacy files
cannot satisfy the new provenance claim by inference.

## 17. Secure credential handoff

Prefer a tested supported structured channel if available. Do not assume that
`--json` means secret values are never printed or written locally.

If the pinned plugin materializes dotenv files, the adapter must:

1. Select an isolated, ignored, permission-restricted output location.
2. Verify path confinement and reject symlinks and unexpected file ownership.
3. Parse values as data; never `source`, evaluate, or execute dotenv contents.
4. Validate exact environment/account/resource provenance and allowed names.
5. Detect missing fields, duplicate/colliding mappings, and conflicting values.
6. Keep privileged provisioning outputs separate from runtime outputs.
7. Commit the encrypted snapshot and provenance as one recoverable generation,
   with a single atomic pointer or transactional commit record.
8. Remove only adapter-owned temporary plaintext after safe persistence.
9. Detect and report interrupted cleanup without exposing values.

Test quoting, multiline values, special characters, malformed content, and
hostile shell expressions. Never overwrite or delete an existing developer
`.env` file. Do not promise forensic erasure on SSDs or journaled filesystems.

Provider-issued credentials, Trestle master keys, Stripe CLI login credentials,
and GitHub deployment credentials have separate lifecycles. Rotating one does
not imply the others were rotated or revoked.

Two independent file renames are not an atomic snapshot/metadata commit. Use
durable writes, generation checks, and restart verification. A stale pull cannot
overwrite a newer rotation or edit. Pending snapshots cannot be deployed.

Before connection or health probing, validate provider endpoint ownership,
account/resource identity, destination policy, TLS, and required query options.
A syntactically valid URL must not redirect credentials to an arbitrary host,
disable verification, or select unexpected privileged access. Never put secret
values in process arguments, shell history, command displays, or unprotected
crash diagnostics.

## 18. Rotation semantics

Rotation means replacing a provider credential and completing its declared
consumer cutover. Pulling an existing value is synchronization, not rotation.

`trestle secrets key rotate` continues to rotate the local encryption key. It
must never be relabeled as provider credential rotation.

The rotation unit is the provider's actual mutation unit. If a command rotates
several outputs, include all affected bindings and consumers in the plan and
lock scope. A single-binding CLI argument cannot hide bundle-wide effects.

Each rotation plan declares:

- exact credential/resource/account target and issuance owner;
- all known consuming applications, environments, jobs, and external systems;
- whether the key is shared and whether consumer discovery is complete;
- provider invalidation timing, overlap/grace support, and expiry;
- validation, deployment, restart, and connection-pool requirements;
- outage risk and any approved maintenance window;
- recovery capability if the old key is already invalid;
- billing or quota effects and required approvals.

Unknown invalidation behavior blocks automated production rotation. Shared
account keys require cross-project coordination; knowing only this repository's
consumers is not sufficient. Do not promise automatic rotation of a key whose
unknown external consumers could be broken.

## 19. Rotation state machine and recovery

```text
planned -> preflight_passed -> issuance_requested
                                  |
                   +--------------+--------------+
                   |                             |
              new_issued                  outcome_unknown
                   |
          encrypted_snapshot_saved
                   |
          consumers_updated -> consumers_verified
                                      |
                  old_credential_retired -> completed
```

Every transition is journaled without secret values. The provider's actual
invalidation model determines which transitions can be controlled by Trestle.

`old_credential_retired` is a required fact, not necessarily a final API call:
immediate invalidation may establish it during issuance. If retirement cannot
be verified, report `cutover_verified_retirement_unknown`, not `completed`.

### Overlapping credentials

When independently issuing and revoking keys is supported, retain the old key
during cutover, verify every required consumer, then revoke it. Confirm new-key
success and old-key rejection with scoped probes after revocation. An external
grace period must finish before claiming revocation proof.

### Immediate invalidation

When rotation immediately invalidates the old key, prepare all consumers and
deployment authority first. Require an approved interruption window unless a
tested provider-specific strategy avoids it. After issuance, failures require
forward recovery with the new credential; redeploying an old secret is not a
rollback strategy.

### Ambiguous or interrupted rotation

Do not automatically issue another key after timeout. Reconcile credential
version/state through supported interfaces. If a newly issued key cannot be
retrieved again, saving the successful response is insufficient: the process
can die after issuance but before saving. Unattended issuance needs tested
recovery across that response-loss window, such as retrieving the issued key,
safe idempotent replay, or reconciling and revoking an identifiable orphan while
the old key remains valid. An unrecoverable one-time response combined with
immediate invalidation blocks unattended rotation before issuance. Supervision
does not remove this risk; a manual exception needs a documented recovery and
outage procedure.

Never claim completion when one consumer still uses the old value. Record
`partial_cutover`, `outcome_unknown`, or `needs_intervention` explicitly. Resume
uses checkpoints and revalidation; it cannot simply repeat the entire command.

Verification must prove use of the new generation, not just HTTP 200 from an
old healthy replica. Record each consumer's revision/generation and perform a
scoped dependency check, including background jobs, retries, scheduled work,
admin services, and intermediaries. Missing generation evidence remains unknown.
Drain or fence old revisions before retiring keys they can still use.

Old-key probes distinguish credential rejection from network failure, rate
limiting, insufficient permissions, or missing test resources. Use provider-
specific safe probes and a new-key control check; generic 401/403 or timeout
alone is not universal proof. Email sends and payments require separate approval.

Database credential verification includes new connections, not just an existing
pool. Hyperdrive or other intermediary credentials and pools are separate
consumers. Webhook signing-secret changes require receiver overlap/replay
handling where supported; API-key rotation does not rotate webhook secrets.

## 20. Deployment integration

Provisioning success is an intermediate result. Trestle must still:

1. Establish role-specific database credentials, grants, and forced RLS.
2. Apply migrations through the established migration authority.
3. Resolve typed configuration and generated application bindings.
4. Project only declared credentials to each Worker, admin service, and job.
5. Deploy the intended immutable application artifact.
6. Verify each consumer and record its deployed revision.

Record `provisioned`, `configured`, `deployed`, and `verified` separately.
Readiness gates must not collapse these into one green status.

The admin and customer planes retain separate configuration and privilege.
Email-dependent auth is ready only with verified sender/adapter configuration.
Billing entitlements still come from the PostgreSQL projection after verified
provider events. Provisioning authorization never grants an application role.

A Projects outage must not stop an already deployed application from serving.
Using a previously approved credential snapshot during deployment requires an
explicit freshness policy and cannot conceal known revocation or drift.

The availability promise covers loss of the Projects management path while the
provider data plane and deployed credentials remain valid. It does not cover
provider outage, billing suspension, expiry, or remote revocation.

Deployment records bind the artifact to an approved configuration/credential
generation. Reverting code does not restore obsolete secrets. Rollback selects
a compatible approved generation and cannot resurrect known revoked keys from
Git, old CI artifacts, or host revisions. Configuration drift requires renewed
verification even when the application commit matches.

## 21. Database-specific requirements

Neon provisioning must preserve the established separation between migration,
runtime, and privileged administration roles. Tests must exercise runtime
credentials under forced RLS, not merely establish a connection as an owner.

Connection configuration must distinguish direct versus pooled endpoints and
any Hyperdrive intermediary. Projects provisioned a database does not prove
that a selected driver, Worker transport, migration path, or pool is correct.

Backup, restore, preview branch creation, and branch deletion use separately
declared capabilities. Adopting Projects cannot change retention or destroy
existing recovery points without explicit review.

## 22. Removal, detachment, and orphan reconciliation

Distinguish environment-membership removal, project detachment, account
unlinking, credential revocation, and provider resource deletion. They are not
aliases and cannot be inferred from a generic upstream `remove` verb.

Destructive plans show exact IDs, all known consumers, data affected, retention
and backup requirements, and shared-resource consequences. Production deletion
requires explicit target confirmation and independent authorization policy.

After deletion, reconcile stale credential snapshots, host bindings, Projects
cache/state, and local temporary files using supported operations. Deleting a
local file is not proof of remote key revocation. Failure to clean up produces
an unresolved security/operations item, not success.

Orphan detection is read-only. Never delete resources merely because a manifest
entry disappeared or a provider listing was incomplete.

Destruction stops new consumers, drains active work, verifies required backup/
restore evidence, rechecks identity and shared references, then deletes and
reconciles credentials/bindings. A backup-exists flag is not restore evidence
where recovery proof is required. Incomplete reference discovery blocks deletion.
A resumed deletion must not target a replacement that reused an old name.

## 23. Upgrades, costs, and provider billing

Prefer Projects for verified service-plan changes. Before applying, recheck the
current tier, intended tier, region, quotas, price, and account-wide impact.
Downgrades may be destructive and must be classified independently of upgrades.

Changing an infrastructure plan must not modify application customer billing
products or entitlements. Avoid naming collisions between infrastructure tier
identifiers and the application's Starter/Pro/Business plans.

No automatic paid upgrade follows a failed health check. A prior approval for
one account or tier does not authorize another. CI credentials and unattended
flags do not constitute spending or terms acceptance authority.

## 24. CLI adapter security and compatibility

Start with a narrow adapter around the supported Projects CLI. Pin and test
Stripe CLI/plugin versions; do not install the latest plugin on every apply.
Prefer a stable supported API later only when it improves the same contract.

The adapter must use argument arrays, an explicit working directory, a minimal
child environment, bounded execution, and validated structured output. It must
not execute provider-supplied commands or interpolate resource names into shell
scripts. Validate URLs before opening them and treat all provider text as data.

Capture stdout/stderr privately, sanitize before display, and never enable
upstream verbose/debug output blindly. Redaction by key name alone is not
sufficient. Tests inject credentials into nested errors and unexpected fields.

Malformed output, incompatible versions, truncated results, or unknown schemas
fail closed. No parsing human tables as the durable machine interface. Do not
assume commands are safe in CI merely because they accept noninteractive flags;
prove authentication, renewal, account scope, and failure behavior separately.

Verify executable provenance and integrity, including plugins; a version string
alone does not identify trusted code. Do not run dependency install scripts,
generator hooks, or application executables in the privileged provisioning
process. Separate untrusted build/test stages from credential-bearing mutation
stages and consume verified immutable artifacts.

Project source can request capabilities, not grant them. Pull-request changes
to manifests, workflows, executable paths, or approval policy cannot expand
runner authority before trusted review. Provider login is not Trestle operation
authorization.

## 25. Durable execution and audit

An operation record contains intent digest, actor, approval reference, account
and environment identities, tool versions, timestamps, dependency/checkpoint
states, safe provider request IDs, evidence, and recovery classification.

Normalized outcomes include `succeeded`, `blocked`, `failed_retryable`,
`failed_terminal`, `outcome_unknown`, `partial_cutover`,
`cutover_verified_retirement_unknown`, and `needs_intervention`.
Cancellation stops future steps; it does not undo an
already accepted provider operation.

Persist an audit intent before mutation. If durable storage is unavailable,
do not start. If journaling fails after a side effect, stop further changes and
preserve a restrictive local emergency record for reconciliation. Do not claim
an atomic commit between provider mutation and audit persistence.

Semantic events include `infra.plan.created`, `infra.apply.started`,
`infra.resource.created`, `infra.resource.adopted`, `infra.credentials.imported`,
`infra.rotation.started`, `infra.rotation.partial`, `infra.rotation.completed`,
`infra.resource.deleted`, and `infra.operation.recovery_required`.

Use logical IDs, duration, operation ID, environment, and normalized categories.
Never log keys, connection strings, raw environment output, auth URLs, payment
details, or unrestricted provider response bodies.

## 26. Doctor and operational visibility

Read-only doctor checks include:

- supported tool versions and adapter capabilities;
- correct account/project/environment binding;
- credentials present by name and expected provenance;
- least-privilege scopes where inspectable;
- resource existence and configuration drift;
- lifecycle ownership conflicts and shared-resource dependencies;
- stale snapshots, overrides, and incomplete rotations;
- expected host projections and deployed revisions;
- database role/RLS and application checks available to that environment;
- cleanup debt and unresolved operations.

Checks distinguish `pass`, `fail`, `unknown`, and `not_applicable`. Remote access
failure is not a healthy empty result. Doctor does not repair resources, pull
secret values, send email, trigger payment, or rotate credentials.

Doctor may resolve already-held credentials internally to authenticate a safe
read-only probe; it does not fetch new Projects values or mutate snapshots.
Active RLS write/rollback tests, webhook delivery, and fixture creation belong
to separately authorized verification jobs. Doctor reports their scoped
freshness/evidence rather than executing them under a read-only label.

Optional admin visibility shows sanitized infrastructure health and operation
history behind explicit platform permissions. Mutating infrastructure controls
are not part of the first admin UI and cannot be reached through impersonation
or customer support context.

## 27. Local development, CI, and previews

Local development remains usable without Stripe, Cloudflare, Neon, or Resend
accounts. Local PostgreSQL, local email capture, and local billing retain their
existing contracts. Projects is a remote infrastructure path, not a dependency
for editing application code or running core tests.

CI separates read-only planning, approved mutation, deployment, verification,
and cleanup authority. Untrusted fork jobs receive no provisioning credentials.
This also applies to unreviewed same-repository branches and privileged workflow
triggers that check out untrusted head code.
Scheduled rotation is a later explicit opt-in after manual conformance proof;
it is never enabled merely by selecting Projects.

Read-only jobs use least-privilege metadata access where available. If Projects
authentication is broadly privileged, isolate the trusted inspection process
from untrusted code and disclose the limitation. Calling read commands does not
turn its token into a read-only token.

Preview automation uses bounded counts, region/tier constraints, TTLs, and
explicit ownership tags where supported. An expired TTL schedules reviewed
cleanup policy; it does not authorize deleting shared resources.

Email probes remain non-sending by default. Live delivery requires a designated
mailbox, a small declared message budget, and explicit opt-in. Billing probes
use test mode and cannot substitute live keys to bypass a missing test setup.

## 28. Existing projects and migration

Existing projects remain on their current provisioning owner until explicitly
adopted. Updating the Trestle npm package must not re-provision infrastructure,
move credentials into remote storage, or replace working deployment workflows.

Migration procedure:

1. Inventory current accounts, resources, consumers, and automation owners.
2. Produce a read-only comparison against Projects capabilities.
3. Identify adoptable resources and direct-provider gaps.
4. Review credential custody, output-name mappings, costs, and ownership changes.
5. Adopt one non-production environment with retained resources.
6. Validate deployment and failure recovery before expanding.
7. Update documentation, bindings, and exclusive writer configuration.

Keep a tested exit path: export safe inventory, retain usable encrypted
application credentials, and explicitly transfer resource ownership. Do not
assume removing a Projects association preserves the resource; prove detach
semantics before using it in an exit procedure.

## 29. Setup skill and documentation

The setup skill proposes Projects as the preferred remote provisioning path
for verified providers. It asks about application needs, existing infrastructure,
environment isolation, region, budget, and credential custody in product terms.

It must explain required account authorization and paid changes before acting,
show the reviewed plan, and describe capability gaps honestly. It cannot bypass
Trestle policy by invoking the raw CLI when the adapter blocks an operation.

Document one canonical path for new applications, adoption, environment setup,
credential pulls, vi editing, explicit reveal, rotation, interrupted cutover,
provider outage, deletion, and exit from Projects. Generated instructions name
the installed CLI's supported capabilities, not aspirational commands.

## 30. Stripe Projects starter distribution

Maintain one generator source of truth. Produce the registry starter as a
tested materialized application from a pinned Trestle release; do not create a
second independently maintained starter architecture.

The registry entry must declare only services it actually uses and identifiers
verified in the current catalog. Pin source and dependency versions and publish
an accurate framework classification. Do not label TanStack Router usage as
TanStack Start unless the application actually uses Start.

The build-time install step must succeed before credentials exist. Follow-up
Trestle configuration handles credential import, database roles, bindings, and
deployment after provisioning. Do not invent a post-provision hook; use a
documented mechanism or explicit next-step command.

Native Projects builds can provision before a Trestle plan is approved. Label
these actions as Projects-governed bootstrap, not Trestle-approved execution.
Before publication, prove bootstrap scope, pricing/consent UX, credential output
location, and ownership handoff. Trestle adopts resulting IDs without creating
duplicates. If services cannot meet this bounded bootstrap policy, use the
ordinary Trestle creator with Trestle-governed provisioning and defer the registry
variant. Do not advertise identical approval guarantees across the two paths.

Registry distribution is complete only after a clean external checkout can
build, provision within its approved scope, run locally, deploy, and pass the
declared checks. Registry publication is a separate release action, not an
automatic consequence of adopting this spec.

## 31. Testing requirements

Core tests require no live accounts. Use a fake Projects executable with
versioned fixtures and a deterministic provider state model.

Required coverage:

| Area | Required adverse cases |
| --- | --- |
| Planning | Drift, stale plan, changed account, unknown cost, unsupported capability, no remote side effects |
| Identity | Same resource names across accounts/projects, wrong active environment, shared key, conflicting ownership |
| Concurrency | Two local processes, two CI runners, lease expiry, environment selection race |
| Provisioning | Timeout after creation, duplicate retry, partial graph, unavailable discovery, interrupted journal |
| Credentials | Collision, missing output, malformed dotenv, shell expressions, symlink, restrictive permissions, interrupted cleanup |
| Secret editing | Application values preserved, provider override conflict, explicit reveal only, master-key rotation remains separate |
| Rotation | Overlap, immediate invalidation, unknown response, unretrievable key, one consumer fails, old key rejected, safe resume |
| Deployment | Admin/customer separation, wrong secret target, existing pool hides failed new database credential |
| Deletion | Shared resource, retain policy, missing backup, stale credentials, unsupported detach, orphan not automatically deleted |
| CLI boundary | Unsupported version, malformed JSON, secret-bearing stderr, timeout, process cancellation, hostile resource label |
| Authorization | Fork CI, missing approval, unknown actor, changed cost, tenant/support-session denial |
| Compatibility | Existing direct-provider application unchanged, pristine generated app, adjacent-version upgrade |

Real-provider conformance runs are opt-in, isolated, cost-bounded, and labeled
with exact account/service/tool versions and environment. Cleanup evidence is
part of the test result. A failed cleanup leaves an explicit owned-resource
ledger item.

Each section 35 finding requires a regression/falsification case. Inject process
termination before and after every external effect, encrypted generation commit,
and journal update. Run competing coordinators and delayed responses after lease
expiry. Assert provider call counts, surviving resources/keys, secret artifacts,
and absence of unauthorized effects, not only the final error message.

## 32. Acceptance scenarios

Integration acceptance requires evidence that a developer can:

1. Generate and run a local application without a Projects account.
2. Inspect actual supported service operations and their evidence levels.
3. Review a plan without creating resources or exposing credentials.
4. Provision an isolated Neon resource through Projects without duplicates.
5. Establish least-privilege runtime access and demonstrate forced RLS.
6. Import declared credentials into environment-bound encrypted storage.
7. Edit with vi and intentionally reveal values without changing provider keys.
8. Deploy the same application artifact with only its declared credentials.
9. Rotate a supported credential and verify every declared consumer.
10. Observe old-key rejection where the provider supports controlled revocation.
11. Recover from interrupted provisioning and partial rotation without blind retry.
12. Detect environment/account drift and refuse the unsafe operation.
13. Adopt an existing resource without recreating it or changing its data.
14. Use verified Projects operations for Cloudflare and Resend, with explicit
    extensions for unimplemented provider capabilities.
15. Preview and authorize cost/tier changes without mixing customer billing.
16. Retain or remove resources according to explicit lifecycle policy.
17. Continue serving an already deployed application during a Projects outage.
18. Inspect secret-free operation evidence and distinguish unknown from passing.
19. Reject altered/replayed approval and privilege escalation from project source.
20. Recover or block response-loss rotation and stale-runner takeover explicitly.
21. Prevent old deployments or concurrent pulls from restoring retired keys.
22. Distinguish Projects bootstrap approval from Trestle apply approval.

Passing an adapter fixture test is not hosted proof. A successful database
connection is not RLS proof. One working consumer is not rotation completion.

## 33. Delivery phases and gates

### Phase 1: Capability and safety investigation

Pin tools, inspect the actual catalog, record service/operation coverage, verify
credential output behavior, authentication, adoption, and rotation semantics.
Produce sanitized fixtures. No automatic production changes.

Exit: a reviewed matrix, complete side-effect descriptors, and a credential-
handoff design covering response-loss recovery. Unknown
properties remain explicit blockers for their respective operations.

### Phase 2: Read-only foundation

Implement typed configuration, safe bindings, status, capability inspection,
doctor, plan generation, redaction, and compatibility tests.

Exit: deterministic plans, trusted approval/replay protection, and no remote
mutation from read-only commands. Before Phase 3, durable state, generation
commits, serialized mutation, recovery access, and tool integrity must be
implemented and fault-tested; they are not deferred to production.

### Phase 3: Neon end-to-end proof

Provision one isolated database, import credentials, establish roles/RLS, wire
and deploy a generated app, verify it, and exercise timeout/recovery behavior.

Exit: hosted evidence for that exact path and documented cleanup disposition.

### Phase 4: Credential lifecycle

Implement consumer inventory, encrypted checkpoints, rotation planning,
cutover verification, interruption recovery, and provider-specific conformance.

Exit: at least one real supported credential lifecycle proven end to end;
other rotation modes remain unavailable until separately proven.

### Phase 5: Broad golden-path integration

Delegate verified Cloudflare and Resend operations, add tier/adoption/removal
paths, integrate SetupPlan and CI, and retain explicit provider extensions.

Exit: every advertised operation has fixture coverage and appropriate hosted
evidence; unsupported capabilities have actionable boundaries.

### Phase 6: Registry and production qualification

Validate the materialized starter, teammate onboarding, adjacent-version
upgrades, production policy, recovery runbooks, and registry submission.

Exit: publish only the proven support surface. This work is a new feature
milestone and does not retroactively expand or close unrelated beta ledger gaps.

## 34. Open implementation questions

1. Which exact Cloudflare, Neon, and Resend service operations are exposed by
   the pinned Projects release and by the authorized accounts?
2. Does credential rotation preserve overlap, immediately invalidate, rotate
   multiple outputs together, or require provider-specific recovery?
3. Can credentials be retrieved safely without persistent plaintext output?
4. Can existing resources be adopted and detached without destructive side effects?
5. What is the supported unattended authorization and token-renewal model?
6. Which shared-state and lease mechanism will support cross-runner recovery?
7. Can provider scopes satisfy Trestle's runtime least-privilege requirements?
8. How will private account associations be shared safely across teammates?
9. Which resource classes have stable identities and safe timeout reconciliation?
10. What provider-specific evidence is needed before production rotation?

These questions gate the affected implementation, not the architecture. The
direction is settled: **delegate as much verified infrastructure lifecycle as
possible to Stripe Projects, while Trestle owns safe application integration.**

## 35. Adversarial review ledger

Review performed against Draft v0.1 on 2026-10-01. Severity describes the
consequence if implemented literally. Every item is addressed at the
requirements level in v0.2; implementation and provider conformance remain open.

| ID | Severity | Counterexample to the earlier draft | Resolution and required falsification test |
| --- | --- | --- | --- |
| AR-01 | Critical | An attacker edits plan approval or replays an approved rotation twice. | Section 12: authenticated external approval, canonical digest, single-operation consumption; tamper/replay causes no second side effect. |
| AR-02 | Critical | A runner loses its lease while its provider request continues; its replacement issues a conflicting mutation. | Section 11: reconcile in-flight uncertainty, fence or serialize; delayed responses cannot duplicate mutation. |
| AR-03 | Critical | Rotation invalidates the old key, then the response is lost before the new key is saved. | Section 19: prove response-loss recovery or block unattended issuance; crash at this boundary cannot be mislabeled recoverable. |
| AR-04 | High | A stale pull or old checkout replaces a newer credential/provenance generation. | Sections 9, 16–17, 20: project-bound generations, compare-and-swap, atomic commit, safe rollback; reject concurrent/stale writes and cross-project envelope substitution. |
| AR-05 | High | An upstream command rotates sibling credentials or writes plaintext outside the expected output. | Sections 7, 13, 17–18: full side-effect and rotation-unit inventory; unapproved bundle effects block execution. |
| AR-06 | Critical | A PR install hook runs with account-wide provisioning credentials. | Sections 12, 24, 27: protected policy, trusted artifacts, build/mutation separation; untrusted scripts never receive privileged credentials. |
| AR-07 | High | A health check passes on an old replica, or network failure is mistaken for key revocation. | Section 19: generation-specific consumer proof and safe provider-specific retirement probes; generic health and network failure remain insufficient. |
| AR-08 | High | Rollback restores a retired key, or queued work still runs on an old revision. | Sections 19–20: drain old revisions and bind approved credential generations; rollback and delayed jobs cannot resurrect retired keys. |
| AR-09 | High | Doctor runs write-based RLS verification while advertised as read-only. | Section 26: separate active verification jobs; doctor makes no mutation calls or fixture writes. |
| AR-10 | High | Starter provisioning bypasses Trestle approval while advertising that guarantee. | Section 30: explicit bootstrap policy and ownership handoff; acceptance checks distinguish approval paths. |
| AR-11 | High | Resumed cleanup deletes a replacement resource with the old display name. | Sections 10, 22: stable identity and fresh reference/backup checks; replacement resource survives. |
| AR-12 | High | A provider output directs a privileged database probe to an attacker-controlled endpoint. | Section 17: endpoint ownership, TLS, and destination validation; reject hostile URLs before credential transmission. |
| AR-13 | High | Failure in a later step causes automatic compensating database deletion. | Section 14: compensation needs approved effects; fault injection preserves retained resources. |
| AR-14 | High | Provider rotation behavior changes but old conformance evidence remains permanently trusted. | Section 7: scoped, expiring evidence and invalidation; changed capability/tool behavior revokes qualification. |
| AR-15 | Medium | The availability promise is interpreted as immunity to provider outage or revocation. | Section 20: management-path-only guarantee; report data-plane failure independently. |

Review completion means these design gaps were found and addressed in the spec.
It does not mean implementation security, provider behavior, or release gates
have been verified. Open questions in section 34 remain implementation gates.
