# D-02: Control-store backend

**Status:** accepted (implemented locally; not enrolled for hosted use)
**Date:** 2026-10-01 · **Owner:** Infrastructure maintainer · **Gate:** P04 before P07

## Decision

An independent PostgreSQL database (schema `trestle_infra`) is the only store
that may authorize shared remote mutation. It holds:

- `operations` and an append-only `operation_events` journal (a trigger rejects
  `UPDATE`/`DELETE`);
- `approvers` (public keys and revocation) and single-use `approvals`;
- `reservations` with monotonically increasing fencing tokens, lease expiry,
  an `inflight_effect` marker and an `uncertain` state;
- `generations` for compare-and-swap of binding and credential generations.

Rules:

1. A reservation whose lease expired while an effect was in flight becomes
   `uncertain`. Uncertain reservations never expire into permission; only an
   explicit `reconcile` releases them (AR-02).
2. Every effect call is preceded by `beginEffect`, which checks the caller's
   fencing token and live lease inside the same transaction.
3. Generations advance only by CAS against the expected generation (AR-04).
4. The in-memory store implements the same contract for deterministic tests and
   is refused for remote mutation (`kind: "memory"` is never accepted by the
   executor for non-fake adapters).
5. The control database must not be an application tenant database and must
   exist before it governs creation; it is never provisioned by the coordinator
   it serves.

## Backup and restore

`exportControlState`/`importControlState` produce a logical snapshot. Restore
preserves consumed approvals, uncertain reservations and generations, so a
restore cannot re-enable an approval replay or release an uncertain target.
Tested in `infra-store.integration.test.ts`. Provider-level backups (e.g. Neon
point-in-time restore) are additionally required before hosted enrollment.

## Rejected alternatives

- Local files or the CI cache as a journal: lost with the runner; no cross-runner
  exclusion.
- CI concurrency groups: do not fence a provider request already in flight.
- Storing the journal in the application database being provisioned: circular.
