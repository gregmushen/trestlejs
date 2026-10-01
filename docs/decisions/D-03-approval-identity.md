# D-03: Approval identity

**Status:** accepted (implemented locally)
**Date:** 2026-10-01 · **Owner:** Security/release maintainer · **Gate:** P04 before P07

## Decision

An approval is an Ed25519-signed canonical record, verified against an approver
registry stored in the control database, not in the repository.

Signed payload: approval ID, operation ID, environment, plan digest, source
digest, artifact digest (or null), target identities (Stripe account, Projects
project and environment), allowed effects, cost limit, expiry, approver ID and a
random nonce.

- The private key lives outside the repository (default
  `~/.config/trestle/approver.ed25519`, mode 0600) or in a protected CI secret
  scoped to a deployment environment.
- Registering or revoking an approver requires control-store administrator
  access. A pull request cannot add an approver, widen its scope, or change the
  verifying key.
- `consumeApproval` is transactional and single-use per operation. Replaying the
  same approval for the same operation returns the existing operation (resume);
  for a different operation it is rejected.
- Expired, revoked or scope-mismatched approvals are rejected; resume after
  expiry needs a fresh approval for remaining effects only.

Not authority: an editable `approved: true`, a plan digest by itself, a Stripe or
provider login, or modifying a repository workflow.

## Rejected alternatives

- Repository flags or a committed approvals file: editable by the requester.
- Git commit signatures alone: authenticate authorship, not authorization for a
  specific plan and target.
