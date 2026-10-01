# D-04: Credential envelope and generation commit

**Status:** accepted (implemented locally)
**Date:** 2026-10-01 · **Owner:** Secrets maintainer · **Gate:** P05 before P07

## Decision

Infrastructure credential snapshots use envelope **version 2**, separate from
the existing application credentials files (version 1), which keep their
current format, location, editor, show/export and master-key rotation behavior
unchanged.

Version 2 envelope (`trestle.credentials.v2`):

- AES-256-GCM with a fresh 96-bit nonce per encryption.
- Additional authenticated data is the canonical JSON of
  `{ schema, version, projectId, environment, purpose, generation, metadata }`,
  where `metadata` lists each value's name, classification, binding, provider,
  resource identity, consumers, import time and override flag — never values or
  value hashes.
- Decryption requires the caller's expected project, environment, purpose and a
  minimum generation; an envelope moved between projects, environments, purposes
  or older generations fails authentication or the expectation check.
- Purposes: `deployment` (provider-managed values projected to consumers) and
  `operator` (operator-only provisioning credentials, never deployed).

## Commit

The envelope is the `data` of a control-store generation
(`credentials:<project>:<environment>:<purpose>`), committed by compare-and-swap
against the generation it was derived from. One transactional commit replaces
"ciphertext file + metadata file" renames. A stale pull, an old checkout or a
concurrent edit fails the CAS and must re-read. Local copies are caches; a cache
whose generation is behind the store is never deployed.

## Compatibility

- Legacy v1 files remain readable through the existing `trestle secrets`
  commands only; they never satisfy a v2 provenance claim.
- A CLI that only understands v1 rejects v2 envelopes ("Unsupported encrypted
  credentials format"), so an old CLI cannot silently downgrade a snapshot.
- Master-key rotation of a v2 snapshot re-encrypts into the next generation; it
  is never described as provider credential rotation.

## Recovery

The master key for an environment is held independently of every provider
credential in the snapshot, so rotating a provider key never locks the operator
out of the journal or snapshot.
