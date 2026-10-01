# D-06: Projects template registry bootstrap

**Status:** accepted — **registry variant deferred**; normal `create-trestlejs`
path remains the supported way to start a Trestle application
**Date:** 2026-10-01 · **Owner:** Release maintainer · **Gate:** P15 before publication

## Facts (docs.stripe.com/projects/templates, 2026-10-01)

`stripe projects build` reads a registry manifest, copies the template at a
pinned commit, runs `install_command` (a shell command), initializes the Projects
workspace, provisions every declared service, and prints `next_steps`. There is
no post-provision hook. Provisioned credentials are written to the project's
`.env`. Local testing is available with `--template-manifest`.

## Conflicts with Trestle guarantees

1. **Approval boundary.** Services are provisioned by Projects before any
   Trestle plan or signed approval exists. This is Projects-governed bootstrap,
   not Trestle-approved execution (AR-10), and cannot be labeled otherwise.
2. **Credential custody.** Provisioning writes plaintext credentials (including an
   owner-privileged `DATABASE_URL`) to `.env` in the application root. Trestle
   applications forbid plaintext `.env` files and keep secrets in encrypted
   credentials; the Projects bootstrap URL must stay operator-only.
3. **Identity handoff.** Adopting bootstrap-created resources needs exact-ID
   adoption, which Projects reports as unsupported for Neon, Cloudflare and
   Resend at plugin 0.45.0.
4. **Install authority.** `install_command` runs before credentials exist, which
   is acceptable, but the materialized starter must not ship lifecycle scripts
   that a later privileged process could inherit.

## Decision

- Do not submit a registry entry. Ship the manifest generator and validator
  (`packages/cli/src/infra/registry.ts`) so a qualified entry can be produced
  from one pinned release without a hand-maintained starter.
- Revisit when either Projects offers a bootstrap mode that defers provisioning
  until an explicit next step, or Trestle can import bootstrap `.env` output into
  encrypted credentials and remove it as a documented, tested next step and
  exact-ID adoption is supported.
- Never advertise identical approval guarantees for the registry and creator
  paths.

## Evidence required before publication

Clean-directory `--template-manifest` build in an isolated account, install
before provisioning, bootstrap scope and pricing/consent UX, credential output
location, handoff without duplicates, teammate onboarding, secret-free
publication, and explicit release authorization.
