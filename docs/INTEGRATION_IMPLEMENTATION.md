# Integration strategy: implementation record

**Implements:** [INTEGRATION_STRATEGY.md](INTEGRATION_STRATEGY.md), all seven delivery steps (§9) plus the setup and admin implications (§8)
**Date:** 2026-09-22
**Baseline:** Better Auth 1.7.5 (passkey, sso, scim, and api-key plugins at 1.7.5)

Every provider below supplies credentials, protocols, provisioning facts, usage figures, or delivery. Trestle keeps authority: tenant isolation, the three authority planes, audit and outbox, and the local projections.

## 1. Passkeys, two-factor, and assurance evidence

- **Better Auth plugins.** `passkey` and `twoFactor` (TOTP, OTP, backup codes) are installed according to `authentication` in `.trestle/project.yaml`. The admin always has both, because platform role changes and tenant entry require phishing-resistant evidence.
- **Assurance evidence.** Every new session records `authentication_assurance` (level, method, time), captured by a Better Auth `after` hook. Methods are `password`, `totp`, `otp`, `backup_code`, `passkey`, and `sso`. SSO sessions count as single-factor, because the identity provider's own factors cannot be verified.
- **Step-up.** Admin step-up reads that evidence (`packages/authz/src/assurance.ts`) rather than session age:
  - Local requires a password.
  - Every other environment requires MFA.
  - `platform.roles.manage` and `platform.support.enter_tenant` require phishing-resistant evidence.
  - Evidence must be at most 15 minutes old.

  The admin dialog walks through password, then code, then passkey. The server returns `428` with `{ required, maxAgeMinutes, reason }`.
- **Audit.** Factor changes (`security.two_factor.*`, `security.passkey.*`) are audited through a `SECURITY DEFINER` function that accepts only `security.*` names. Secrets, codes, and credential material are never recorded.
- **Surfaces.** The customer app has Settings → Security and a `/two-factor` challenge. The admin has Account Security (`g i`) and sign-in with a second factor or a passkey.

## 2. Provider ports

| Port | Location | Implementations |
| --- | --- | --- |
| `SsoProvider`, `DirectoryEventSource`, `ExternalRoleMapping` | `packages/integrations/src/identity` | Better Auth (in `packages/auth`) and WorkOS |
| `MeteringProvider` | `packages/integrations/src/metering` | Native (`packages/billing`), OpenMeter, and Lago |
| `WebhookTransport` | `packages/domain/src/webhooks/transport.ts` | Native and Svix |
| `CredentialVerifier` | `packages/authz/src/credential-verifier.ts` | Trestle (authoritative) and a Better Auth proof of concept |

`reconcileExternalAssignments()` revokes only assignments owned by the given provider connection. `validateMapping()` refuses the platform plane and organization ownership. A database check constraint refuses both again.

## 3. API-key proof of concept

Results are in [API_KEY_POC.md](API_KEY_POC.md). Gates 1, 4, and 6 fail, so Trestle's own verifier stays authoritative. The gate tests run against PostgreSQL and fail if a later Better Auth release changes the behavior they rely on.

## 4. Enterprise SSO

**Better Auth SSO (OIDC and SAML), self-hosted.**
- **Domain proof.** Domain verification is on in every environment except local. A provider cannot sign anyone in, or link an existing account by email, until its DNS TXT record verifies.
- **Wrapped routes.** Provider registration, updates, deletion, and domain verification are closed over HTTP (`disabledPaths`). Tenants reach them through `/api/tenant/identity/*`, which requires `organization.identity.manage` and writes audit and outbox records.
- **Private issuers.** A self-hosted issuer that resolves to a private address must be named in `SSO_TRUSTED_ISSUERS`. Better Auth's SSRF protection stays on for everything else.

**WorkOS, managed (a Better Auth plugin, `packages/auth/src/workos.ts`).**
- **Binding.** A tenant binds a WorkOS organization. Only the domains WorkOS reports as verified are stored, one `identity_connection` row each. A connection already bound to another tenant is refused with `409`.
- **Sign-in.** Sign-in is routed by email domain and protected by a signed state cookie. The returned profile must belong to the WorkOS organization the sign-in started with, and its email domain must be bound. The session is created by Better Auth, so cookies and assurance follow the normal path.

## 5. SCIM (Better Auth SCIM plugin)

- **Loading.** SCIM loads only with `DATABASE_DRIVER=postgres-js`, because the plugin refuses adapters without native transactions. The drizzle adapter now enables transactions on that driver.
- **Tenant boundary.** Connections and credentials are managed through server-only calls. Each is wrapped by `organization.identity.manage`, with the token shown once. The provisioning domain is the Trestle organization.
- **Projection.** `packages/auth/src/directory.ts` writes inside the SCIM transaction:
  - membership and its `role_source`;
  - source-owned application roles on `application_role_assignment`;
  - `directory.*` audit events and an outbox event.

  Deactivation removes only what the connection granted. Linking an existing account requires a verified SSO domain for the organization.
- **Transaction gate.** `trestle identity verify-scim --env <env>` runs a real create, update, and deactivate cycle (`packages/auth/src/scim-transactions.ts`) against the environment's own database and driver, then records non-secret evidence. `trestle doctor` fails SCIM until a pass is recorded on that environment's current driver. It also fails Better Auth SSO on `neon-http`.
- **WorkOS Directory Sync.** `POST /webhooks/workos` checks `WorkOS-Signature` (HMAC-SHA256 with a replay window) and reads the user's current groups back from WorkOS. It reconciles membership and application roles, with audit and outbox in one tenant transaction. Each event ID applies once.

## 6. Metering (OpenMeter or Lago)

- **Local projection.** Request paths increment `usage_aggregate` as before, and authorization reads only that figure.
- **Reporting.** The outbox runner reports each period's unreported increase to the provider. Event IDs are derived from the reported range, so a retry deduplicates. `reported_quantity` advances only after the provider accepts. Reconciliation then stores the provider's quantity, balance, and access verdict separately.
- **Admin.** The Entitlements view shows metering provenance: local, reported, provider, observed time, balance, and drift.
- **Meter mappings.** Mappings live in `packages/billing/src/catalog.ts` as `meterMappings`, with one meter per stable feature code.

## 7. Svix (optional dispatcher)

- **Mirroring.** Each Trestle endpoint is mirrored as a Svix endpoint, with the same URL and signing secret on its own channel, in one Svix application per organization. Secret rotations are carried across.
- **Deliveries.** Each delivery becomes one Svix message whose `eventId` is the delivery ID. The Svix message ID is stored as `webhook_attempt.provider_reference`, never as the Trestle event identity. The event catalog, subscriptions, outbox, and delivery history stay in Trestle.
- **Failing closed.** If Svix is declared but `SVIX_API_KEY` is missing, deliveries fail and retry instead of silently falling back to native delivery.

## 8. Setup, doctor, and admin

- **Manifest and setup plan.** They accept `authentication`, `identity`, `integrations.metering`, and `integrations.webhooks`, and reject:
  - directory provisioning without matching SSO (Better Auth SCIM needs Better Auth SSO; WorkOS Directory Sync needs WorkOS SSO);
  - Lago metering without Lago payments;
  - provider metering without `commercial.usage`;
  - Svix without `communications.webhooks`;
  - an admin with neither passkeys nor two-factor;
  - Stytch, which is not built.
- **Setup console.** It offers these choices, runs connection tests for WorkOS, OpenMeter, and Svix, and records their results as non-secret `providerChecks` evidence. For self-hosted or regional providers, only HTTPS base URLs are accepted, or HTTP on loopback.
- **Capabilities.** There are new capabilities: `passkeys`, `twoFactor`, `sso`, `directory`, and `metering`. Webhooks report native or Svix mode.
- **Admin.** A new Enterprise Identity view (`g y`, `platform.identity.read`) lists, read-only and across tenants:
  - bindings, with last event and safe failure;
  - SSO providers and their domain proof;
  - SCIM connections, active users, and credential status;
  - directory events.

  Admin never collects provider secrets.

## Verification

- **Unit and contract tests.** Covered:
  - manifest combination rules;
  - doctor gates and evidence;
  - WorkOS HTTP and webhook contracts;
  - OpenMeter and Lago contracts;
  - mapping reconciliation;
  - native transport signing;
  - the credential-access intersection.

  Root `pnpm check` passes 80 tests. The generated project's `pnpm check` passes 219 tests with a fresh database, and `pnpm check:generated` passes.
- **Against real services.**
  - PostgreSQL covers RLS, SCIM transactions, the API-key gates, and usage reporting.
  - A self-hosted Svix server (`svix/svix-server`) receives a hand-off, delivers a signed body, deduplicates a retry, and carries a rotation.
  - A real OIDC provider (`oidc-provider`) completes Better Auth SSO sign-in in the browser.
- **Browser flows in a generated project.**
  - TOTP and passkey enrollment, two-factor sign-in, passkey sign-in, and admin step-up.
  - Better Auth SSO registration and sign-in; SCIM provisioning with a mapped role, then deactivation that keeps a manual role.
  - WorkOS binding, the cross-tenant conflict, forged-signature rejection, idempotent redelivery, and provisioning and deprovisioning.
  - OpenMeter reporting and reconciliation, including the admin provenance view.
  - Svix dispatch end to end.
- **Local stand-ins.** WorkOS and OpenMeter were exercised against local stubs implementing their documented HTTP APIs, not the hosted services. Lago was verified by contract tests only.

## Known gaps

- **Not tested against real accounts.** No WorkOS, OpenMeter, or Lago account was used.
- **SAML.** It is configured through Better Auth but untested. It depends on `node:crypto` X509 support in Workers.
- **Mapping changes apply lazily.** A new or removed group mapping takes effect on the directory's next update for each member. There is no reconcile-now action.
- **SCIM role mapping.** Only built-in application roles are supported; custom roles are not.
- **SCIM audit on the owner role.** The directory audit policy for a non-superuser owner is created by migration, but it was exercised only with a superuser owner locally.
- **Svix.** Delivery outcomes after hand-off (Svix's own retries and exhaustion) are not fed back into the Trestle projection. That would need Svix operational webhooks.
- **Stytch.** Declared in the strategy, but not built; setup rejects it.
- **Worker bundle size.** The Worker bundle grew to about 1.7 MB gzipped, from about 1.06 MB at the morning baseline. Much of the growth is the SSO and SAML libraries, which load even when SSO is disabled.
- **Lago payments.** The Lago payments adapter (subscriptions) is still unbuilt. See ADMIN_IMPLEMENTATION.md.
