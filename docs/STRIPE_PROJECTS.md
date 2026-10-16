# Infrastructure with Stripe Projects

`trestle infra` manages infrastructure lifecycle through
[Stripe Projects](https://docs.stripe.com/projects). It is separate from
`trestle payments stripe`, which configures your application's customer
billing. All `trestle infra` commands are experimental: pass `--experimental`
or set `TRESTLE_EXPERIMENTAL=1`.

This guide describes what the installed CLI does today. Operations without
verified provider evidence report themselves as blocked with the reason;
nothing falls back to a different provider path silently. The current evidence
for each provider, service and operation is in
[STRIPE_PROJECTS_CAPABILITIES.md](STRIPE_PROJECTS_CAPABILITIES.md) and from
`trestle infra catalog`.

## What works now

| Command | What it does | Remote effects |
| --- | --- | --- |
| `trestle infra init --backend stripe-projects` | Writes `.trestle/infrastructure.yaml`, an empty bindings file, and ignores `.trestle/infrastructure.local/` | None |
| `trestle infra project create --env <env> --application-id <id> --stripe-account <acct_id> --name <name>` | Writes a bootstrap plan; real creation is blocked by the pinned native retry/idempotency gap | None until approved apply |
| `trestle infra link <neon\|cloudflare> --env <env>` | Writes a provider-grant plan, including possible account creation and explicit terms acceptance; currently blocked by qualification evidence | None until a qualified approved apply |
| `trestle infra catalog [provider] [--live]` | Shows recorded evidence per service and operation; `--live` reads the current catalog in an isolated directory | Read only |
| `trestle infra plan --env <env> [--observe]` | Writes a secret-free, digest-bound plan (mode 0600); `--observe` reads fresh identity/resources without pulling credentials | Read only with `--observe` |
| `trestle infra status --env <env>` | Shows bindings, toolchain qualification and orphans; remote state is reported as unknown, not empty | None |
| `trestle infra doctor --env <env>` | Read-only readiness: `pass`, `fail`, `unknown`, `not_applicable` | Read only |
| `trestle infra open <provider>` | Prints an allowlisted dashboard URL | None |
| `trestle infra approver keygen` / `approver register` | Creates an Ed25519 approver key outside the project; registers its public key in the control store | Control store only |
| `trestle infra approve <plan-file>` | Signs an approval bound to one plan, operation, target, effect set and expiry | None |
| `trestle infra apply <plan-file> --approval <file>` | Executes an approved plan with fresh preconditions | Provider, only for qualified operations |
| `trestle infra operation show <id>` / `operation resume <id>` | Shows the canonical control-store operation, events and reservations with sanitized diagnostics; resumes only qualified operations | Provider, only for qualified operations |
| `trestle infra adopt`, `upgrade`, `detach`, `destroy` | Write exact-ID lifecycle plans with their safeguards | None |
| `trestle infra rotate <credential-binding>` | Writes a rotation plan for the provider's real rotation unit and consumers | None |
| `trestle infra database setup --resource <name> --yes` | Runs your Drizzle migrations and role scripts with the operator-only owner credential, then commits only the verified restricted runtime credential for Workers | Database (migrations, roles) |
| `trestle infra deploy --worker-target <name> --worker-url <url> --artifact-digest <digest>` | Pushes the committed runtime credential and a generation marker with `wrangler secret bulk`, then verifies through `/api/health/operational?probe=database` | Worker secrets |
| `trestle infra database rotate-runtime … --accept-interruption <reason> --actor <name>` | Rotates the runtime password, cuts Workers over, proves the old password is rejected and retires it; `--resume <operation-id>` recovers an interrupted run | Database role, Worker secrets |
| `trestle infra pages build --surface <app\|site\|admin>` | Compiles Functions into `dist/_worker.js` without provider/GitHub credentials | None |
| `trestle infra pages register --env <env> --surface <surface> --account <id> --project <name> [--api-worker <name>] --actor <id> --confirm-target <account/project>` | Administrator enrollment of an existing Pages host and its exact API binding; rejects a target owned by another environment | Provider reads; control-store metadata only |
| `trestle infra pages plan --env <env> --surface <surface> --account <id> --commit <sha> --repository <owner/repo>` | Snapshots config, assets and precompiled Functions for artifact-bound approval; new host adapter remains blocked pending hosted qualification | None |

`trestle infra credentials pull` remains unavailable. Provider-link and Pages
plans expose their qualification blockers and cannot turn local/fake tests into
permission for real provider mutation.

### Bootstrap and account grants

Real project creation is currently blocked: pinned native `init` retries its
create POST without a proven shared idempotency key across attempts. The
[hosted qualification record](STRIPE_PROJECTS_HOSTED_QUALIFICATION_20261016.md)
explains this boundary and the retained uncertain attempt. A single wrapper
invocation is not proof of a single native create.

The application ID is a stable control-store identity, not a new name for every
run. `project create` plans manual project initialization only, with no template,
install, provider service, paid plan or implicit terms acceptance. Approve the
saved plan with the normal registered Ed25519 approver, then apply it. The
independent control database must already exist; Trestle cannot provision the
store that governs its own bootstrap.

An unresolved project ID is explicitly `pending:…` in the plan. The executor
journals intent, serializes the application/environment, explicitly selects the
Stripe merchant, observes the exact resulting project ID and commits its binding
before reporting success. An ambiguous initialization is never retried. Resume
uses the original private workspace, or leaves the operation uncertain.

The pinned provider link can create an account. Existing-account-only selection
is not proven: the default link plan stays blocked. `--allow-account-creation`
only adds that possibility to the review; it does not grant consent or override
missing capability evidence. `--accept-provider-terms` likewise adds a distinct
effect to the signed review. A completed association request is not proof that
Projects selected a particular Neon organization or Cloudflare account. Check
that identity before provisioning into an existing organization. Linking and
resource creation cannot hide account creation in an unreviewed argument flag.

### Pages host extension

Pages is not advertised as a Projects catalog service. The generated deployment
workflows already have direct Pages provisioning/service-binding steps; this
extension adds the separate configuration and artifact/authority handoff. It
deploys only to an existing, administrator-enrolled host. It never creates a
Pages project or upgrades an account plan during upload.

Use a dedicated `wrangler.pages.jsonc` containing **plain JSON in the supported
subset**: name, `pages_build_output_dir: "./dist"`, compatibility date/flags and
service bindings. Arbitrary build hooks, variables and other configuration
fields are rejected. The existing API Worker configuration stays separate.
Build the frontend, then run `pages build` if Functions are present. Rebuild the
frontend before rebuilding Functions; existing `_worker.js` output and another
task's deploy-config redirect are never overwritten.

Register the exact account/project and API Worker through a trusted control-store
administrator, separately from deployment. A deployment cannot enroll itself or
change that policy through repository configuration. The target cannot be shared
across environments without a separate migration review. Review the Pages plan
and sign it with `infra approve … --artifact-digest <digest from the plan>`.
Apply uses only snapshotted config/assets and precompiled Functions with
`--no-bundle`; no source compilation receives deployment credentials. It checks
the clean commit, repository, pinned Wrangler implementation, account access and
existing project. Production additionally requires an exact-SHA successful,
completed `push`/`main` run of `.github/workflows/deploy.yml` in that repository.

The operation marker and artifact digest must be observed at the Pages hostname.
An upload timeout, old marker or missing receipt stays uncertain; resume verifies
without uploading again. Artifact delivery is separate from API/database/auth,
browser and clinical readiness. A standalone hosted native-adapter probe now
verifies the real upload receipt,
release marker, asset delivery and Pages-to-Worker binding. The full signed
apply path remains unverified while the project binding is unresolved, so real
apply remains blocked. No provider login or editable plan field removes that gate.

### Paid R2 qualification

R2 create remains unqualified at the recorded toolchain. Local tests cover its
paid-service confirmation, exact-ID binding and response-loss recovery, but do
not enable it. A paid-service plan now needs a positive approved cost limit;
zero is not paid-service consent. The adapter passes `--confirm-paid-service`
only for that reviewed paid operation. A limit is not a provider spending cap.
R2 also requires explicit `configuration: { name: <bucket-name> }` and optionally
`location_hint` from the recorded catalog enum. The logical resource name is
only an alias, not the bucket name. Configuration is included in plan review,
source/material drift and the committed binding; changing it requires separate
resource/migration review. Only this service's validated flat configuration may
use the single-argument JSON channel; raw flags/shell syntax remain rejected.
Hosted qualification requires separately authorized disposable resources, terms,
cost, account identity and cleanup scope before the capability record changes.

### What apply can do

`apply` requires every operation to have hosted evidence for the pinned
toolchain. Qualified today: `neon/postgres` create and rotate,
`cloudflare/workers` create, and `resend/email` create and rotate. Declared plans
are provisioned before their services. Everything else stops at its
preconditions with the reason.

## Concepts

- **Intent** (`.trestle/infrastructure.yaml`): desired resources per remote
  environment; never secret values. `local` never uses remote infrastructure.
- **Bindings** (`.trestle/infrastructure.bindings.json`): reviewed exact
  identities. The control store's generation is authoritative; an old checkout
  cannot overwrite a newer binding.
- **Control store**: an independent PostgreSQL database named by
  `TRESTLE_INFRA_CONTROL_DATABASE_URL`. It holds the append-only journal,
  approvers, single-use approvals, fenced reservations and credential
  generations. It must not be an application database. Local files are never
  used as the journal for remote changes.
- **Approvals**: signed records verified against approvers registered in the
  control store. An `approved: true` field, a plan digest, a Stripe login or a
  workflow change are not approval.
- **Credential snapshots**: Projects-managed credentials are imported from an
  isolated workspace into version 2 encrypted snapshots bound to project,
  environment, purpose and generation. Your `trestle secrets` files, editor
  (`$VISUAL`, `$EDITOR`, vi), `secrets show/get` and `secrets key rotate` are
  unchanged. Editing a provider-managed value creates a visible local override;
  a later pull asks you to keep it, accept the provider value, or move it to
  application ownership.

## Safety rules you will see

- Plans block on account, project or environment drift, unknown cost, a name
  match standing in for identity, undeclared sharing between environments, and a
  generated script that still writes the same kind of resource
  (`directWriterDisabled` records the handoff).
- Credentials reach Workers only when their scope is proven least-privilege. The
  Projects Neon bootstrap URL is owner-privileged and stays operator-only; derive
  a runtime role instead.
- Every effect is journaled before it starts. A timeout or lost response is
  `outcome_unknown`; resume binds the resource found by observation and never
  retries blindly. If the resource is not visible yet, resume needs
  `--confirm-absent <reason> --actor <name>` after you confirm no request is
  still pending.
- Projects `add` is not idempotent: a second `add` with the same name creates
  `<name>-2`. While holding the target's reservation, `apply` re-observes right
  before every create and refuses if that name or a `<name>-N` sibling already
  exists. If a second resource really is intended, rerun with
  `--allow-duplicate <reason> --actor <name>`; the CLI warns, and the override is
  recorded in the operation journal.
- Nothing is deleted to roll back a failure. Retained resources are reported.
- Deployment records `provisioned`, `configured`, `deployed` and `verified`
  separately; a 200 from an old replica is not verification. Rotation retires
  an old credential only after every consumer is verified on the new generation
  and drained, and only with provider-specific proof; retired generations can
  never be redeployed.

## Recovery

1. With `TRESTLE_INFRA_CONTROL_DATABASE_URL` configured, `trestle infra operation show <id>` shows the canonical operation, events and related uncertainty reservations with sanitized diagnostics. It never substitutes a local checkpoint for the durable record. Without that URL, legacy local checkpoint inspection remains available but cannot prove durable operation state.
2. `trestle infra operation resume <id> --env <env> --plan <file> --approval <file>`
   re-checks approver authority, approval expiry, target identity and drift, then
   continues from the last committed step. An expired approval needs a renewal
   for the same operation; committed effects are not repeated.

## Existing applications and leaving Projects

Upgrading the `trestlejs` package never provisions infrastructure, moves
credentials, or changes deployment workflows. Existing resources keep their
current owner until you plan an adoption. Projects reports existing-resource
linking as unsupported for Neon, Cloudflare and Resend today, so adoption plans
stay blocked.

To leave Projects: keep using your `trestle secrets` files and deployment
workflow, and transfer ownership explicitly. Do not assume removing a Projects
association preserves a resource: `stripe projects remove` deprovisions it, and
no non-destructive detach is proven.

## Local development

Local development and `pnpm check` need no Stripe, Cloudflare, Neon or Resend
account. Local PostgreSQL, email capture and billing are unchanged.
