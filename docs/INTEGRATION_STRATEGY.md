# TrestleJS Integration Strategy

**Status:** Decision draft  
**Reviewed:** 2026-09-22  
**Better Auth baseline:** 1.7.5 (the version currently pinned by Trestle)  
**Scope:** Better Auth and adjacent services that could replace infrastructure
mechanisms without replacing Trestle's application model

## 1. Decision

Trestle should keep the architecture it has and make the provider boundaries
more explicit.

The governing rule is:

> Trestle owns composition, policy, local projections, and invariants. Providers
> may own credentials, protocols, transport, delivery, rating, or payment
> execution.

This means Trestle remains authoritative for:

- tenant selection and PostgreSQL isolation;
- the organization, application, and platform authority planes;
- service accounts, effective permissions, scopes, and endpoint policy;
- local subscription and entitlement projections used on request paths;
- semantic audit events, transactional outbox events, and correlation;
- the generated application's `ExecutionContext`; and
- the customer and platform administration experience.

Provider records are evidence or inputs to those models. They are not an
alternative authorization path.

## 2. Recommended ownership

| Capability | Default owner | Trestle's responsibility | Decision |
| --- | --- | --- | --- |
| Human accounts, passwords, sessions, verification, reset | Better Auth | Configure, wrap, and project the authenticated user into `ExecutionContext` | Use now |
| Organizations, membership, invitations | Better Auth Organization | Treat membership as organization-plane authority only | Use now |
| Passkeys | Better Auth Passkey | UI, recovery policy, audit, and assurance evidence | Add before beta |
| TOTP, OTP, backup codes, trusted devices | Better Auth Two-Factor | Enrollment UI and policy; never log secrets or backup codes | Add before beta |
| Fresh/step-up authentication | Trestle policy over Better Auth verification | Require an assurance level and recent verification for sensitive actions | Build the policy layer |
| Organization teams | Better Auth Organization | Optional projection; no authority unless an application explicitly maps it | Defer |
| Organization, application, and platform permissions | Trestle | Registry, roles, assignments, explanation, and enforcement | Keep |
| User/session administration | Trestle admin | Use Better Auth session primitives where safe, but authorize every operation with platform permissions | Keep Trestle UI and policy |
| Service accounts and API-key semantics | Trestle | Principal lifecycle, role ceiling, scopes, environment, CIDR, rotation, audit, usage | Keep |
| API-key hashing and lookup | Trestle today; Better Auth candidate adapter | Preserve all Trestle invariants behind a credential-provider port | Prototype only |
| Enterprise SSO | Better Auth SSO by default; WorkOS or Stytch optional | Normalize identity and organization binding | Adapter choice |
| SCIM/directory provisioning | Better Auth SCIM when the database supports it; WorkOS or Stytch optional | Map lifecycle and groups into explicit Trestle assignments | Adapter choice |
| Usage metering and rating | OpenMeter or Lago optional | Stable feature codes and local effective-entitlement projection | Integrate, do not reproduce |
| Payments and invoicing | Stripe or Lago | Provider-neutral subscription projection and reconciliation | Existing boundary is correct |
| Email delivery | Resend or another transport | Notification definitions, preferences, in-app state, audit, and safe failure | Existing boundary is correct |
| Outbound webhook delivery | Trestle native default; Svix optional | Event catalog, outbox commit, tenant policy, and safe delivery projection | Add provider port |
| Durable async execution | Cloudflare Queues, Workflows, and Durable Objects | Outbox dispatch, application semantics, and recovery policy | Keep native default |
| Admin framework and design system | Trestle admin using Kumo | Specialized views, extension registry, permissions, and tenant context | Keep |

## 3. Better Auth: adopt more, but at the identity boundary

### 3.1 Use immediately

Trestle already uses Better Auth for accounts, sessions, email/password, email
verification, password reset, and organizations. The Organization plugin is the
right owner for generic organization membership and invitation mechanics.

Its membership role must remain the **organization plane**. Better Auth dynamic
roles and permissions must not replace Trestle application or platform roles.
Collapsing all three into Better Auth would make an organization owner an
implicit product or platform administrator and break the core access model.

### 3.2 Add passkeys and two-factor authentication

Better Auth's current plugins supply the credential mechanisms Trestle is
missing:

- WebAuthn/FIDO2 passkeys, including security keys and platform authenticators;
- TOTP and delivered OTP;
- backup codes; and
- trusted-device handling.

Trestle should not implement those cryptographic protocols. It should add a
Security settings surface in the customer app and an operator security surface
in admin, both backed by Better Auth.

The Trestle layer must still define:

- which actions require a fresh authentication;
- which actions require phishing-resistant authentication rather than a
  password or delivered OTP;
- the maximum age of the evidence;
- recovery and account-lockout policy; and
- the audit event emitted after a protected action.

Better Auth passkey sign-in is not, by itself, a Trestle step-up primitive.
After successful verification, Trestle must record server-verifiable assurance
evidence tied to the operator session, such as:

```ts
type AuthenticationAssurance = {
  level: "password" | "mfa" | "phishing_resistant";
  method: "password" | "totp" | "otp" | "passkey";
  verifiedAt: Date;
  sessionId: string;
};
```

Sensitive platform actions then require the appropriate level and freshness.
The current “session younger than 15 minutes” check is only a temporary
approximation.

The Two-Factor plugin does not automatically challenge every passwordless or
social sign-in flow. Trestle must test every enabled sign-in method and must not
infer MFA merely from `twoFactorEnabled`.

### 3.3 Do not adopt the Better Auth Admin plugin as Trestle admin

The plugin offers useful user, ban, session-revocation, role, and impersonation
operations. Its authorization model is nevertheless a separate global user-role
system. Installing it as the platform control plane would create a competing
fourth authority plane.

Trestle should retain its platform roles and admin UI. It may wrap narrowly
selected Better Auth session or user lifecycle primitives, but the Trestle
platform permission check, reason, audit event, and outbox event must surround
the operation.

Better Auth impersonation also does not replace Trestle support context. A
support session keeps the operator as the principal and carries tenant, reason,
expiry, and effective-access limits. User impersonation remains an exceptional,
separately authorized feature.

### 3.4 Put authentication configuration in Trestle admin

Better Auth is the authentication engine, not the product's configuration
experience. Trestle admin should provide one environment-aware Authentication
destination that composes Better Auth plugin/provider readiness with Trestle's
registration, verification, MFA, step-up, session, recovery, organization, and
enterprise-identity policy.

The boundary is explicit:

- secret-bearing or auth-construction settings such as OAuth credentials,
  callback origins, cookie domains, and plugin installation remain owned by
  `trestle setup` and deployment configuration;
- safe runtime policy is versioned, reviewed, activated, audited, and rolled
  back through Trestle admin; and
- the operator's own factor enrollment remains a separate Account Security
  surface backed by Better Auth.

The admin page shows the complete effective posture and the source of every
value, including setup-owned read-only values. It must prevent activation that
would remove the last viable platform-administrator sign-in/recovery path or
require an unavailable provider, factor, or email flow. This preserves one
coherent place to understand auth without creating a second secret store or a
fourth Better Auth authority plane.

## 4. API keys: do not migrate the domain model

Better Auth's API Key plugin is materially capable. It supports hashed keys,
organization ownership, permissions, expiration, metadata, prefixes,
per-key rate limits, multiple configurations, and secondary storage.

It is not a direct replacement for Trestle's implementation:

- a key references a user or organization, not a Trestle service-account
  principal;
- plugin permissions are not the three-plane Trestle permission registry;
- organization-owned keys cannot use its user-session emulation;
- Trestle keys are environment-bound and may include CIDR restrictions;
- Trestle rotation retains bounded overlap and lineage;
- Trestle must enforce the service account's application-role ceiling and local
  entitlements;
- Trestle mutations commit with audit and outbox records atomically; and
- the plugin's storage contract is not a substitute for tenant RLS or Trestle's
  repository boundary.

The correct experiment is a `CredentialVerifier` port, not a schema migration:

```ts
interface CredentialVerifier {
  issue(input: IssueCredential): Promise<IssuedSecret>;
  verify(presented: string): Promise<VerifiedCredential | null>;
  revoke(credentialId: string): Promise<void>;
}
```

The returned credential ID would still resolve to a Trestle service account.
Trestle would calculate:

```text
service-account role authority
intersect Trestle key scopes
intersect tenant entitlements
intersect endpoint policy
intersect environment and request constraints
= effective access
```

Adopt the Better Auth implementation only if a proof of concept demonstrates
all of the following:

1. credential lifecycle and Trestle audit/outbox changes cannot diverge;
2. no plaintext secret is persisted or returned after creation;
3. revocation and rotation take effect across Worker instances immediately;
4. lookup does not weaken forced tenant isolation;
5. a key can never exceed its service account's authority;
6. environment and CIDR constraints fail closed; and
7. existing Trestle key formats can migrate without a flag day.

Until those gates pass, retain the current Trestle credential verifier. The
most urgent improvement is the known global rate-limit gap; use a Durable Object
or another shared limiter rather than adopting a new credential domain merely
to gain counters.

## 5. Enterprise identity: two supported profiles

Better Auth now has serious SSO and SCIM implementations. Trestle should not
hard-code WorkOS as the only answer.

### 5.1 Self-hosted profile

- Better Auth SSO owns OIDC and SAML protocol handling.
- Better Auth SCIM owns inbound user and group provisioning.
- Trestle maps the resulting identity, lifecycle state, and configured group
  mappings into its own authority planes.
- Trestle admin provides status and mapping views, while secrets remain in
  setup/provider configuration.

This profile preserves generated-application ownership and minimizes external
control planes.

### 5.2 Managed-enterprise profile

- WorkOS is the preferred first managed adapter for SSO, Directory Sync, and a
  customer-facing connection setup portal.
- Stytch is a viable alternative when the consumer wants a broader hosted B2B
  identity product and embeddable organization-administration UI.
- Trestle imports identities and provisioning facts, not either provider's
  application RBAC as a second source of truth.

External groups may map to Trestle roles, but each mapping must name the target
plane and source. Removing an external assignment must remove only the
assignment owned by that source.

```ts
type ExternalRoleMapping = {
  provider: "better_auth_scim" | "workos" | "stytch";
  connectionId: string;
  externalGroupId: string;
  targetPlane: "organization" | "application";
  targetRole: string;
};
```

Platform roles must never be provisioned through tenant-controlled SCIM.

### 5.3 Database compatibility gate

Better Auth SSO user resolution and SCIM require native interactive database
transactions and transaction async-context support. Its documentation states
that Cloudflare D1 cannot satisfy the SCIM requirement. Trestle must also verify
the selected Postgres driver; a simple HTTP batch transaction must not be
assumed equivalent.

`trestle setup` and `trestle doctor` should refuse to mark self-hosted SCIM as
verified until a real create/update/deactivate transaction test passes against
the selected production driver.

## 6. Commercial systems

Trestle should keep feature definitions, plan/version references, overrides,
and the local effective-entitlement projection. No request authorization should
make a synchronous call to Stripe, Lago, or OpenMeter.

- **Stripe** remains the default payment and subscription adapter.
- **Lago** is the stronger option when the application wants subscriptions,
  invoicing, usage charges, credits, and rating in one billing system.
- **OpenMeter** is the focused option when metering, usage balances, and
  entitlement checks are needed without adopting a larger billing platform.

Provider webhooks and reconciliation update the local projection. A provider
feature or meter ID maps to one stable Trestle feature code. The provider may
calculate usage or money; Trestle decides what the application sees now and can
explain the provenance of that decision.

Do not implement a general-purpose rating engine in Trestle.

## 7. Webhooks, notifications, and async work

The native transactional outbox remains mandatory because it connects a domain
commit to every downstream delivery. Provider APIs are dispatch adapters after
that commit.

For outbound webhooks, offer:

- a native Cloudflare delivery adapter as the zero-account default; and
- an optional Svix adapter for teams that want managed signing, retry,
  endpoint management, replay, and a consumer application portal.

Even with Svix, Trestle owns the event catalog, tenant subscription policy,
outbox event, correlation ID, and safe local delivery projection. Svix delivery
IDs are provider references, not Trestle event identities.

For notifications, Resend remains transport only. Trestle owns definitions,
preferences, mandatory-notification rules, deduplication, in-app state, and
audit history.

Inngest and Trigger.dev should not become default dependencies. The current
Cloudflare-native stack is consistent with Trestle's ownership model. A future
durable-execution adapter is reasonable for consumers already standardized on
one of those services, provided domain code still targets Trestle's execution
contract.

## 8. Setup and admin implications

`trestle setup` should expose capability choices, not a flat vendor list:

```text
Authentication
  Password                    Better Auth
  Passkeys                    disabled | Better Auth
  Two-factor                  disabled | Better Auth

Enterprise identity
  SSO                         disabled | Better Auth | WorkOS | Stytch
  Directory provisioning      disabled | Better Auth SCIM | WorkOS | Stytch

Commercial
  Payments                    disabled | local | Stripe | Lago
  Metering                    native | OpenMeter | Lago

Delivery
  Email                       capture | Resend
  Outbound webhooks           native | Svix
```

The setup plan must reject incompatible combinations, declare required secrets,
run provider-specific connection checks, and record non-secret evidence. Admin
must assume configuration is performed by setup and show:

- configured, deployed, and verified state;
- the selected provider;
- the last successful check or synchronization;
- a safe failure reason; and
- the exact `trestle setup --env <env>` or `trestle doctor` repair command.

Admin must never become a second secret-entry system.

## 9. Delivery order

1. Add Better Auth passkeys and two-factor authentication, then replace the
   current age-only admin step-up check with explicit assurance evidence.
2. Define provider ports for enterprise identity, metering, and outbound
   webhook delivery before adding another vendor implementation.
3. Run the Better Auth API-key proof of concept against the seven acceptance
   gates. Do not migrate production semantics during the experiment.
4. Add Better Auth SSO as the self-hosted baseline and WorkOS as the first
   managed-enterprise adapter.
5. Add SCIM only after a real transaction compatibility test exists for every
   supported database driver.
6. Complete Lago or OpenMeter through the existing local entitlement
   projection; do not expose provider checks to application authorization.
7. Add Svix only as an optional dispatcher after native webhook delivery is
   complete and verified.

## 10. Explicit non-goals

Trestle will not:

- replace its three authority planes with Better Auth, WorkOS, or Stytch RBAC;
- equate a Better Auth organization key with a service account;
- use Better Auth Admin impersonation as the normal support-access mechanism;
- call a remote billing or metering provider during request authorization;
- build SAML, SCIM, WebAuthn, TOTP, payment processing, email transport, or a
  general-purpose usage-rating engine; or
- allow a provider webhook to mutate authoritative state without verification,
  idempotency, normalization, audit, and reconciliation.

## 11. Primary references

- [Better Auth Organization](https://better-auth.com/docs/plugins/organization)
- [Better Auth API Key](https://better-auth.com/docs/plugins/api-key)
- [Better Auth Passkey](https://better-auth.com/docs/plugins/passkey)
- [Better Auth Two-Factor](https://better-auth.com/docs/plugins/2fa)
- [Better Auth SSO](https://better-auth.com/docs/plugins/sso)
- [Better Auth SCIM](https://better-auth.com/docs/plugins/scim)
- [Better Auth Admin](https://better-auth.com/docs/plugins/admin)
- [WorkOS organizations and users](https://workos.com/docs/authkit/users-organizations)
- [WorkOS Directory Sync](https://workos.com/docs/directory-sync/overview)
- [Stytch B2B SCIM](https://stytch.com/docs/multi-tenant-auth/enterprise-ready/scim/overview)
- [OpenMeter entitlements](https://openmeter.io/docs/billing/entitlements/overview)
- [Lago plan model](https://docs.getlago.com/guide/plans/plan-model)
- [Svix webhook guidance](https://docs.svix.com/documenting-webhooks)
