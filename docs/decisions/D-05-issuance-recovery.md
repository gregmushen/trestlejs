# D-05: Issuance response-loss recovery

**Status:** accepted — **unattended rotation unsupported** for all providers at
plugin 0.45.0
**Date:** 2026-10-01 · **Owner:** Provider maintainer · **Gate:** P01/P09 before P10

## Facts

- `stripe projects rotate <resource>` exists for every resource; documentation
  states only that credentials are rotated and that `env --pull` runs
  automatically afterwards.
- Not documented and not observed: whether the old credential is invalidated
  immediately, whether an overlap window exists, how many outputs rotate
  together, and whether a newly issued value can be retrieved again after the
  response is lost. The Stripe Secret Store copy (`env --pull`) is a candidate
  re-retrieval path but is unproven for the window between provider issuance and
  Secret Store persistence.

## Decision

1. Rotation execution is modeled per (provider, service, credential type,
   plugin version) tuple with fields `invalidation`, `overlap`, `bundle`, and
   `reRetrieval`. Any `unknown` safety field blocks issuance before any call
   (spec §19; plan P09 exit "unsupported strategies produce no issuance call").
2. The only strategy that may be enabled for unattended use is one where
   re-retrieval after response loss is proven in a hosted sandbox (P10), or
   where overlap is proven and an orphaned new key is identifiable and
   revocable while the old key stays valid.
3. Until P10 evidence exists, `trestle infra rotate` produces a rotation plan
   and reports execution as `blocked` with the unknown fields named.

## Rejected alternatives

- Treating a persisted successful response as recoverable: the process can die
  after issuance and before persistence (AR-03).
- Defaulting unknown behavior to overlap.
