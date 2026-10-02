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
| `trestle infra catalog [provider] [--live]` | Shows recorded evidence per service and operation; `--live` reads the current catalog in an isolated directory | Read only |
| `trestle infra plan --env <env>` | Writes a secret-free, digest-bound plan (mode 0600) | None |
| `trestle infra status --env <env>` | Shows bindings, toolchain qualification and orphans; remote state is reported as unknown, not empty | None |
| `trestle infra doctor --env <env>` | Read-only readiness: `pass`, `fail`, `unknown`, `not_applicable` | Read only |
| `trestle infra open <provider>` | Prints an allowlisted dashboard URL | None |
| `trestle infra approver keygen` / `approver register` | Creates an Ed25519 approver key outside the project; registers its public key in the control store | Control store only |
| `trestle infra approve <plan-file>` | Signs an approval bound to one plan, operation, target, effect set and expiry | None |
| `trestle infra apply <plan-file> --approval <file>` | Executes an approved plan with fresh preconditions | Provider, only for qualified operations |
| `trestle infra operation show <id>` / `operation resume <id>` | Inspects or resumes an operation from its journal | Provider, only for qualified operations |
| `trestle infra adopt`, `upgrade`, `detach`, `destroy` | Write exact-ID lifecycle plans with their safeguards | None |
| `trestle infra rotate <credential-binding>` | Writes a rotation plan for the provider's real rotation unit and consumers | None |
| `trestle infra database setup --resource <name> --yes` | Runs your Drizzle migrations and role scripts with the operator-only owner credential, then commits only the verified restricted runtime credential for Workers | Database (migrations, roles) |
| `trestle infra deploy --worker-target <name> --worker-url <url> --artifact-digest <digest>` | Pushes the committed runtime credential and a generation marker with `wrangler secret bulk`, then verifies through `/api/health/operational?probe=database` | Worker secrets |
| `trestle infra database rotate-runtime … --accept-interruption <reason> --actor <name>` | Rotates the runtime password, cuts Workers over, proves the old password is rejected and retires it; `--resume <operation-id>` recovers an interrupted run | Database role, Worker secrets |

`trestle infra link` and `trestle infra credentials pull` exit with status 2 and
the gate that blocks them.

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

1. `trestle infra operation show <id>` shows the journal with no secret values.
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
