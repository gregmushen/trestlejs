# D-01: Supported Projects toolchain and output

**Status:** accepted (enables read-only adapter; mutation remains gated)
**Date:** 2026-10-01 · **Owner:** CLI maintainer · **Gate:** P01 before P03

## Decision

- Pin the Projects plugin by version **and** sha256 of the executable
  (`0.45.0`, `187cbb89…3bf77`). The Stripe CLI host is recorded (`1.51.0`) but
  the adapter executes the plugin binary through `stripe projects` only after
  verifying the plugin hash at its resolved path. A mismatch makes every
  capability `unknown` (fail closed).
- Accept only the observed JSON envelope `version: "0.1"`. Any other envelope
  version, a missing `ok`, non-JSON stdout, or output over the size bound is a
  schema failure, never a partial parse.
- Run every plugin invocation, including read commands, in an adapter-owned
  scratch directory, because `catalog` writes `.gitignore` and `.projects/cache`
  into the working directory (observed). Never run it in the application root.
- Never pass `--debug`, `--accept-tos`, `--confirm-paid-service`, or `--yes`
  unless the operation's approved effects include that acceptance.
- Child environment: allowlist `PATH` (fixed directories), `HOME`, and the
  explicit Stripe auth variable for the operation; nothing from the developer
  environment by default.

## Rejected alternatives

- Version-string-only pinning: a version string does not identify trusted code.
- Parsing human tables: not a durable interface.
- Installing the latest plugin per run: silently changes behavior (AR-14).

## Evidence

`docs/STRIPE_PROJECTS_CAPABILITIES.md`, fixtures under
`packages/cli/test/fixtures/stripe-projects/0.45.0/`.
