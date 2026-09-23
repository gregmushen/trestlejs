# Better Auth API keys: proof of concept

**Status:** Complete. Decision: keep Trestle's credential verifier.
**Date:** 2026-09-22
**Versions:** better-auth 1.7.5, @better-auth/api-key 1.7.5, PostgreSQL 17, `postgres-js` driver
**Scope:** `docs/INTEGRATION_STRATEGY.md` §4 and delivery step 3

## What was built

- **`CredentialVerifier` port.** Lives in `packages/authz/src/credential-verifier.ts`, with `issue`, `verify`, and `revoke`. `credentialAccess()` computes:

  ```text
  service-account authority
    ∩ key scopes
    ∩ tenant entitlements
    ∩ endpoint policy
    ∩ environment and request constraints
  ```

  If a verifier cannot supply an environment, access fails closed.
- **`BetterAuthCredentialVerifier`.** Lives in `packages/auth/src/poc/better-auth-api-key.ts`. It is the Better Auth plugin behind that port, configured with `references: "organization"`. Trestle's service account, environment, CIDRs, and scopes travel in plugin metadata.
- **Isolation from the runtime.** No runtime path imports the proof of concept. Its table (`poc_better_auth_apikey`) is created and dropped by the test, and is never part of a Trestle migration.
- **Gate tests.** Live in `packages/auth/src/poc/better-auth-api-key.integration.test.ts`. Each test asserts what the plugin actually does, so a later release that changes the behavior fails the suite and forces another review. Run it with `TRESTLE_RLS_TEST_DATABASE_URL` set.

## Results

| # | Gate | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Credential lifecycle and Trestle audit/outbox cannot diverge | **Fail** | `createApiKey` commits in its own write and accepts no outer transaction. When the Trestle audit write fails afterwards, the key is still live. |
| 2 | No plaintext secret persisted or returned after creation | Pass | Only `base64url(SHA-256(token))` is stored. Verification responses never include the token. |
| 3 | Revocation and rotation take effect across Worker instances immediately | Pass (database storage) | A key revoked through one runtime is refused by a second runtime on its next request. Rotation is issue-then-revoke; there is no bounded overlap or lineage. |
| 4 | Lookup does not weaken forced tenant isolation | **Fail** | The key lookup runs before any tenant is known. With the credential table under forced RLS, as Trestle's `api_key` is, the plugin finds nothing. It needs a table the auth runtime can read across tenants. |
| 5 | A key can never exceed its service account's authority | Pass (at the port) | Plugin scopes are data. `credentialAccess()` clamps them to the service account's authority, so the plugin itself enforces nothing here. |
| 6 | Environment and CIDR constraints fail closed | **Fail (default)** | The constraints are metadata, and the plugin's update endpoint lets a key owner rewrite them with no Trestle policy check, audit, or outbox event. Missing constraints do fail closed at the port. Disabling `/api-key/update` closes that route, but the credential store still does not enforce the constraints. |
| 7 | Existing Trestle key formats migrate without a flag day | Pass | Trestle stores `hex(SHA-256(token))`; the plugin stores the same digest as base64url. Re-encoding the stored value lets an existing `tr_live_…` key verify unchanged. |

## Decision

Gates 1, 4, and 6 fail, so **Trestle keeps its own verifier**. The port stays in place. A future adapter can be judged against the same tests, and none of the passing results needs work on the Trestle side.

Adopting the plugin would require:

- **Gate 1:** an issue path that runs inside a caller-supplied transaction. The plugin's adapter supports transactions, but its endpoint does not accept one from the caller.
- **Gate 4:** a lookup that does not need a cross-tenant readable table. Trestle's `trestle_resolve_api_key` solves this with a `SECURITY DEFINER` function that resolves by public ID and never reveals verifiers to the application role.
- **Gate 6:** constraints enforced in the credential store, or a way to disable owner-side metadata updates for each configuration.

The known global rate-limit gap (§4) is unaffected by this decision. It still needs a shared limiter such as a Durable Object.
