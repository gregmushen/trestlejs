# TrestleJS Administration and Access Control Specification

**Status:** Implemented in part; see Implementation status.

**Scope:** Guided project setup, organization and application administration,
platform operations, commercial capabilities, authorization, service accounts,
and API keys.

**Parent specification:** [TrestleJS Specification](TRESTLEJS_SPEC.md)

## Implementation status

For the supported new- and existing-project enablement path, see
[Enable Admin](ENABLE_ADMIN.md). A generated admin-module is a view shell.
`trestle generate resource <Name> --shared` generates the editor for a
global (non-tenant) resource. It registers `platform.<plural>.manage`, adds
admin Worker routes and a view that require that permission and step-up, and
writes an audited, revision-checked editor on the `trestle_platform`
connection (TRESTLEJS_SPEC §11).

Paths below are relative to a generated project (`packages/create/template`
in the TrestleJS repository) unless they name a TrestleJS package.

### Shipped

- **Three authority planes, one registry.** `packages/authz/src/permissions.ts`
  registers every permission with exactly one plane. Organization roles come
  from Better Auth `member.role`, application roles from
  `application_role_assignment`, and platform roles from
  `platform_role_assignment`. All three resolve through the catalogs in
  `packages/authz/src/role-definitions.ts`. No plane implies another.
  `AUTHORITY_MODEL_VERSION` is 3.
- **Central route policies.** Customer Worker routes are declared in
  `packages/authz/src/routes.ts` and enforced by `requireExecutionContext`
  before handlers run. Admin Worker routes are derived from the server view
  registry (`apps/admin/src/api-registry.ts`). Drift tests fail when a route
  and its policy disagree.
- **Persisted audit.** `audit_event` stores redacted summaries, correlation
  IDs, and an optional `support_session_id`. Tenants read their own history
  through `GET /api/tenant/audit`.
- **Optional platform admin.** `capabilities.admin` plus `apps.admin` create a
  separate-origin SPA and admin Worker. Operators sign in with a password,
  TOTP, or a passkey, and every platform change requires fresh step-up
  assurance (§7.6). It connects through its own `trestle_platform` database
  login. It ships 21 views in a Kumo shell with a command palette and
  keyboard shortcuts (§11). Most views are read-only, because
  `trestle_platform` may only observe and recover. Operator roles are managed
  in the Platform Roles view or with
  `trestle --experimental admin grant|revoke|list`.
- **Effective Access Explorer.** The Permissions view explains a user's or
  service account's access in one organization through
  `POST /api/admin/access/explain` (§10).
- **Commercial controls.** Audited entitlement override grant and revoke, with
  tombstones. The customer-facing provenance does not show override reasons or
  authors.
- **Machine access.** Service accounts and scoped, environment-bound API keys
  (mint, rotate with bounded overlap, revoke) managed through application-plane
  permissions. Platform operators can revoke keys.
- **Deployment.** Staging and production deploy the admin only when
  `capabilities.admin` is true, and a smoke check follows each deploy.
- **Project configuration.** `trestle plan init` writes a starter SetupPlan;
  `trestle secrets` handles encrypted credential entry; `trestle plan diff`,
  `trestle apply --yes`, and `trestle doctor` review, apply, and verify it.
- Related work defined elsewhere: support sessions (see the
  [Admin Additions Specification](ADMIN_ADDITIONS_SPEC.md)), and organization
  regional defaults (`GET`/`PUT /api/tenant/regional`).

### Deferred

Steps 2 to 8 of the
[admin roadmap](superpowers/plans/2026-09-23-admin-roadmap.md) plan most of
the admin items below.

- Provider connection tests and the `deployed` and `verified` capability
  states (§4, §5). No setup wizard is planned; guided setup is the agent setup
  skill plus `trestle plan` and `trestle apply`.
- Organization permissions for member invitation, removal, and role
  assignment, and a Billing administrator organization role (§7.2).
- Custom and resource-scoped application roles (§7.3; roadmap step 6).
- An admin UI for recovering another operator's lost factors; recovery is a
  database action today (§7.6).
- Scope profiles, per-key rate limits, network (CIDR) restrictions, last-used
  and usage history, a service-account suspension API, and customer UI for
  machine access (§8).
- Typed privilege values, stored plan versions and lifecycle transitions,
  admin plan editing, scheduled subscription changes and migrations,
  allowances, quotas, usage, reconciliation records, entitlement simulation,
  and Lago or OpenMeter adapters (§9; roadmap step 5).
- Admin write actions on people and access: changing members' organization
  and application roles, and revoking other operators' support sessions (§11;
  roadmap step 2). Runtime settings and provider secrets in the admin
  (roadmap step 3), and read-write support sessions (roadmap step 4).
- Typed extension points for detail panels, resource actions, and table
  extensions (§11.1).
- Customer UI for application roles, service accounts, audit, and regional
  settings. The APIs exist (§3.2, §12). Regional settings' remaining work is
  in the [Regional Settings Specification](REGIONAL_SETTINGS_SPEC.md).
- Session revocation and user suspension (roadmap step 2).
- Domain events and outbox records for administrative mutations. Audit rows
  are written, events are not (§13).
- Most proposed CLI commands (§16).
- Deployed evidence. The admin deploy steps have not yet run against isolated
  staging resources (§17, §19).
- Identity and SSO (SAML/OIDC connections, domain verification, enforced
  sign-in). Only a specification exists (roadmap step 8).

## 1. Purpose

TrestleJS needs an administrative system that can explain and safely operate a
multi-tenant product without becoming a generic database browser or a remote
code generator.

This specification defines four distinct surfaces:

```text
apps/site       public acquisition and documentation
apps/app        customer product, organization, and application administration
apps/admin      runtime platform operations (optional; capabilities.admin)
trestle plan    local project and capability configuration (CLI)
```

The separation is a security boundary, not a navigation preference.

The SetupPlan, reviewed and applied through the CLI, controls what the
application is made of. The generated admin application controls and observes the running application. Tenant
administration remains in the customer application. All three use shared,
typed capability metadata, but they do not share authority.

Optional Webhooks and Support Sessions views are defined in the
[Admin Additions Specification](ADMIN_ADDITIONS_SPEC.md).

## 2. Governing Principles

1. Authentication establishes identity but grants no application authority by
   itself.
2. Organization administration, application authorization, and platform
   operations are three independent authority planes.
3. Authority does not flow between planes unless the application explicitly
   declares, enforces, and tests a relationship. The only shipped relationship
   is in `packages/authz/src/policies.ts`: the user who creates an
   organization receives `app_admin` once. Later members receive no
   application role.
4. Selecting a tenant never grants cross-tenant or platform authority.
5. Administrative actions use application semantics, validation, and audit
   behavior rather than unrestricted database mutation. Domain events for
   these actions are **Deferred** (audit only today).
6. Entitlements describe what an organization has purchased or been granted;
   they are orthogonal to every authority plane.
7. Permissions describe what an authenticated principal may do within one
   named authority plane.
8. Roles bundle permissions for human or service-account principals within one
   authority plane.
9. API-key scopes can reduce authority but can never create authority.
10. PostgreSQL forced RLS remains the final tenant-isolation boundary.
11. Provider state is normalized into local projections before it influences
    application behavior.
12. Access and entitlement decisions must be explainable from safe provenance.
13. Secrets are write-only inputs and never administrative read models.
14. Missing capabilities fail closed and report an actionable setup command.

## 3. Surface and Trust Boundaries

### 3.1 Public site

`apps/site` contains static-first marketing, pricing, documentation, and legal
content. It may carry non-authoritative signup or plan intent to `apps/app`.
It does not read authenticated tenant state or establish billing authority.

### 3.2 Customer application

`apps/app` contains the customer product and tenant-bound administration. What
ships today:

- sign-up, sign-in, email verification, and password reset (Better Auth);
- organization creation, selection, and member invitation (Better Auth
  organization plugin; the UI invites with the `member` role);
- a Plan and usage page showing the plan, status, and enabled entitlements
  with their source;
- outbound webhook endpoints (see the Additions specification); and
- product workflows and tenant-owned resources.

Tenant APIs without customer UI yet:

- `GET /api/tenant/access`: the caller's own assignments and permissions;
- `GET /api/tenant/application-role-assignments` and
  `PUT /api/tenant/users/:userId/application-roles`;
- `GET /api/tenant/audit`;
- `GET` and `PUT /api/tenant/regional`; and
- service accounts and API keys (§8).

**Deferred:** profile, security, and notification settings screens; UI for
the APIs above; allowance, quota, and usage visibility (the billing route
returns an empty `usage` list).

Organization and application administrators remain normal tenant principals.
Their operations use an `ExecutionContext`, plane-specific permissions, a
tenant-bound database (`createTenantDatabase`), and forced RLS.

### 3.3 Platform admin application

`apps/admin` is an optional, separately deployed runtime control plane for
authorized product operators. It exists only when `capabilities.admin` is true.
It has a separate origin (a Pages SPA), its own admin Worker, authorization
policy, session cookies, and deployment configuration. It shares packages with
the customer application but is not bundled into it.

The admin origin exposes only `POST /api/auth/sign-in/email`,
`POST /api/auth/sign-out`, `GET /api/auth/get-session`, and the operator's own
two-factor and passkey endpoints (§7.6). It has no sign-up and no
organization endpoints. Every other admin route requires a signed-in user with
at least one active platform role and the route's platform permission. Tenant
membership or ownership grants nothing there.

Outside local development the admin Worker reads through `DATABASE_ADMIN_URL`,
a distinct login granted only the `trestle_platform` database role. That role
has column-level grants that exclude payloads, envelopes, destinations, lease
tokens, storage keys, and API-key verifiers. RLS allows it only the state
transitions listed below.

The platform admin application may:

- inspect sanitized runtime and capability health (Health view);
- search organizations and users, and read organization members, user
  memberships, plans, subscriptions, and effective entitlements;
- read the audit history across organizations, filtered by organization,
  actor, event name, or correlation ID (Audit view);
- read the role and permission catalogs, who holds each organization and
  application role, service accounts, and API-key metadata, and explain a
  principal's effective access (§10);
- start an audited, read-only support session in one organization (see the
  Additions specification);
- execute narrow, application-backed platform actions: redrive a dead outbox
  event, disable a webhook endpoint, replay a dead or exhausted webhook
  delivery, grant or revoke an entitlement override, revoke an API key, and
  grant or revoke a platform role;
- inspect and recover asynchronous operations (dead outbox events, failed
  webhook deliveries, artifact lifecycle totals, email delivery status); and
- revoke compromised API keys.

**Deferred:** search for jobs; managing plans, organization and application
roles, and other runtime domain configuration in the UI; provider
reconciliation; revoking user sessions, suspending users, or suspending
service accounts (roadmap steps 2, 3, and 5).

It may not:

- browse or mutate arbitrary database tables;
- execute raw SQL;
- reveal secret values, credentials, authentication tokens, or API-key
  material;
- rewrite application source, manifests, migrations, or deployment files;
- install packages or bindings;
- silently bypass domain validation or audit behavior; or
- acquire global authority merely by selecting a tenant.

### 3.4 Project configuration

Project configuration is a local CLI flow, not a browser surface.
`pnpm exec trestle plan init` writes a starter SetupPlan
(`.trestle/setup.json`) describing the current project. Changes to the
SetupPlan, generated source, encrypted credentials, bindings, migrations, or
deployment configuration are proposed only through `trestle plan diff`,
`trestle apply --yes`, and `trestle secrets`; no deployed surface may propose
them.

Generated projects must use their pinned CLI:

```bash
npx create-trestlejs my-product            # add --admin for the platform admin
cd my-product
pnpm exec trestle plan init
pnpm exec trestle dev
```

Using `npx ...@latest` inside an existing project is not the normal path.

## 4. Guided Setup

Setup uses existing deterministic primitives rather than a second
configuration model. The shipped flow is:

```text
trestle plan init                 write a starter SetupPlan
  -> trestle secrets ...          collect encrypted credentials
  -> edit the SetupPlan (JSON); trestle plan validate
  -> trestle plan diff            display the plan diff
  -> trestle apply --yes          apply after explicit approval
  -> trestle doctor --env <env>   verify
```

Apply is safe to rerun, and `trestle plan status` reports recorded progress.
The project's agent setup skill (TRESTLEJS_SPEC §33) conducts the
conversation that produces the SetupPlan; there is no separate setup console
or wizard. **Deferred:** provider connection tests and recording non-secret
evidence.

`trestle plan`, `trestle apply`, and `trestle doctor` are the reviewable
planning, mutation, and verification engines.

The platform admin can be enabled later by applying a SetupPlan with
`capabilities.admin: true` (`pnpm exec trestle apply <plan> --yes`). This
scaffolds `apps/admin` when the project is on the installed CLI's template
version and `.trestle/project.yaml` declares `DATABASE_ADMIN_URL` with
`target: admin`. Apply never disables or removes the admin; that is a manual
change.

### 4.1 Secret handling

Plaintext secret values:

- never enter a SetupPlan or project manifest;
- never appear in URLs, logs, analytics, crash reports, command history, or
  browser storage;
- are encrypted immediately into the appropriate environment credential
  document or projected through an explicit provider secret operation;
- are never returned to the browser after submission; and
- are removed from temporary memory and files when the operation ends.

`trestle secrets list` and `check` display only each declared secret's
presence and whether the selected environment requires it. **Deferred:**
fingerprint or prefix, last-updated time, and per-secret verification state.

The manifest declares where each secret is pushed: `target: worker`, `ci`, or
`admin`. A Worker secret may add `shareWith: [admin]` to also reach the admin
Worker. `trestle secrets push` sends the admin Worker only `admin`-targeted and
shared values. Admin-targeted secrets are required only when
`capabilities.admin` is true.

## 5. Capability Lifecycle

The target lifecycle for every optional capability is:

```text
disabled -> declared -> configured -> deployed -> verified
```

The admin models all five states (`CapabilityState` in
`apps/admin/src/registry.ts`) but reports only the first three.
**Deferred:** reporting `deployed` and `verified`. What ships:

- The manifest declares each capability as a boolean (`r2`, `queues`,
  `workflows`, `durableObjects`, `admin`).
- The customer Worker's `GET /api/health/operational` reports each
  capability's configured flag and mode.
- `GET /api/admin/session` projects them for the admin shell. Email and
  payments are always part of the application, so they are `configured` or
  `declared` (not configured, with a repair command). Queues, R2, and
  Workflows are `configured` when the customer Worker reports them, and
  `disabled` otherwise. The Health view shows this projection with each mode.
  It never shows values.
- `GET /api/admin/health` also reports database, email, billing, queues,
  artifacts, and workflows as `configured`, `not_configured`, or `unknown`.

The admin application assumes configured capabilities are managed through
the SetupPlan and does not collect infrastructure credentials itself.

When configuration is absent or unhealthy, admin degrades safely. An
unconfigured capability carries a repair command:

```text
pnpm exec trestle doctor --env staging
```

A missing `DATABASE_ADMIN_URL` outside local development returns
`503 not_configured` with the same command. A view whose capability is
`declared` stays in the sidebar, disabled, with a "Setup" badge and the repair
command; opening its route shows the same guidance. A view whose capability is
`disabled` is hidden. Commands inherit their view's capability or declare
their own, and the command palette offers only commands whose capability is
configured.

## 6. Principals and Contexts

Trestle separates identity from authority.

```text
IDENTITY
├── Human
│   └── User
└── Machine
    ├── ServiceAccount
    │   └── APIKey credential
    └── SystemPrincipal

AUTHORITY
├── Organization
│   ├── OrganizationRole        (Better Auth member.role)
│   └── OrganizationPermission
├── Application
│   ├── ApplicationRole         (application_role_assignment)
│   └── ApplicationPermission
└── Platform
    ├── PlatformRole            (platform_role_assignment)
    └── PlatformPermission
```

### 6.1 Identities

- **User:** a human identity authenticated by Better Auth. A user possesses no
  organization, application, or platform authority merely by existing.
- **Service account:** a tenant-owned non-human identity (`service_account`)
  holding application roles only.
- **API key:** a revocable credential (`api_key`) that authenticates a service
  account. An API key is not an independent identity or authority grant.
- **System principal:** a scheduled, queue, Workflow, or internal recovery
  identity. Audit records it as actor type `system`, for example CLI
  bootstrap (`system:bootstrap`) and support-session expiry.

`Platform operator` is not an identity type. It is a user with one or more
platform-role assignments. Audit records such a user's platform actions as
actor type `platform_operator`. The same user may independently have
organization or application assignments without those assignments becoming
platform authority.

### 6.2 Independent authority planes

A human user may have unrelated assignments in all three planes:

```text
User
├── OrganizationMembership (Better Auth member)
│   └── member.role (comma-separated organization roles)
├── ApplicationRoleAssignment[]
│   └── scoped to one organization
└── PlatformRoleAssignment[]
    └── platform scope
```

- **Organization authority** governs the SaaS account relationship:
  organization profile, members, billing, webhooks, audit history, and
  organization settings.
- **Application authority** governs product-domain actions, including tenant
  artifacts, application-role assignment, and service accounts with their API
  keys.
- **Platform authority** governs operation of the SaaS across tenants:
  support sessions, async and webhook recovery, entitlement overrides, API-key
  revocation, platform-role management, and cross-tenant reads such as audit.

An organization owner is not automatically an application administrator. An
application administrator is not a platform administrator. Even the term
`Administrator` is meaningful only with an explicit authority plane.

Application-role assignments are stored in a separate
`application_role_assignment` table, always scoped to an organization.
Revocation keeps the row as history. **Deferred:** scoping an assignment to a
specific application resource.

### 6.3 Execution context

Human and machine requests resolve an `ExecutionContext`
(`apps/worker/src/execution-context.ts`). The context records the principal
and its kind, the selected tenant, organization and application authority
resolved fresh for the request, the role assignments considered, effective
entitlements, a correlation ID, and services. Platform authority is never
resolved in the customer Worker. The admin Worker resolves it separately with
`platformAccess()`.

Authentication establishes identity. Authority permits actions. Entitlements
permit tenant capabilities. Tenant context bounds data. These are separate
checks and have separate failure reasons (`AccessReason`):
`unknown_permission`, `credential_inactive`, `principal_type_rejected`,
`tenant_required`, `entitlement_missing`, `permission_missing`,
`scope_missing`, and `constraint_failed`.

## 7. Permissions and Roles

### 7.1 Permission registry

Permission definitions use stable application-owned codes in
`packages/authz/src/permissions.ts`:

```ts
export const permissions = definePermissions({
  "organization.members.read": { plane: "organization", description: "List organization members and their roles" },
  "resource.read": { plane: "application", description: "Read tenant-owned application resources", principals: ["user", "api_key"] },
  "application.service_accounts.manage": { plane: "application", description: "Create service accounts and mint, rotate, and revoke their scoped API keys" },
  "platform.outbox.redrive": { plane: "platform", description: "Return dead-lettered outbox events to delivery" },
});
```

Every permission declares exactly one authority plane. `definePermissions`
validates that:

- codes are lowercase and dotted;
- organization and platform codes use the `organization.` and `platform.`
  prefixes, and application codes use neither;
- `principals` defaults to `["user"]` and must be explicit to admit
  `api_key`; and
- platform permissions cannot admit API keys or depend on an entitlement.

A definition may also declare `entitlement`, `group`, `deprecated`, and
`secret`. Roles skip deprecated permissions when they resolve.

The shipped registry:

| Plane | Permissions |
| --- | --- |
| Organization | `organization.read`, `organization.members.read`, `organization.audit.read`, `organization.billing.read`, `organization.billing.manage`, `organization.webhooks.read`, `organization.webhooks.manage`, `organization.webhooks.deliveries.read`, `organization.webhooks.replay`, `organization.settings.manage` |
| Application | `resource.read`, `resource.write` (both admit API keys), `application.roles.read`, `application.roles.assign`, `application.service_accounts.read`, `application.service_accounts.manage` |
| Platform | `platform.overview.read`, `platform.organizations.read`, `platform.users.read`, `platform.audit.read`, `platform.roles.read`, `platform.roles.manage`, `platform.operations.read`, `platform.outbox.redrive`, `platform.webhooks.manage`, `platform.subscriptions.read`, `platform.entitlements.manage`, `platform.machine_access.read`, `platform.api_keys.revoke`, `platform.support_sessions.use` |

New permission meaning enters the system through reviewed source. Runtime admin
cannot invent a permission that application code does not recognize. The
admin Permissions view (`platform.roles.read`) documents the registry
read-only: each permission's plane, principals, entitlement, deprecation
state, the roles that grant it, and the routes that enforce it. Deprecation stays a source
change (`deprecated`); the roadmap keeps permissions code-defined.

Route policies declare each route's audience (`public`, `session`, `tenant`,
or `platform`), required permission, optional entitlement, and allowed
principal types. `defineRoutePolicies` rejects a policy that names an
unregistered permission, or that mixes a platform permission with a
non-platform audience. Customer routes without an explicit policy default to
`resource.read` for `GET` and `resource.write` otherwise. API keys act only on
routes whose permission admits `api_key`. The Permissions view lists where
each permission is enforced, from the customer route policies and the admin
server registry. **Deferred:** machine-readable inspection of the same;
`trestle routes` does not report permissions.

### 7.2 Organization roles

Organization roles express generic SaaS and account administration authority.
They are Better Auth membership roles. Trestle ships these defaults:

- `owner` (Owner): every organization permission
- `admin` (Administrator): every organization permission
- `member` (Member): `organization.read`, `organization.members.read`,
  `organization.billing.read`

**Deferred:** a Billing administrator role, and the permissions
`organization.members.invite`, `organization.members.remove`, and
`organization.roles.assign`. Invitation and membership changes currently go
through Better Auth's organization plugin and its own role checks.
`organization.api_keys.manage` is not planned: API keys are managed with the
application-plane `application.service_accounts.manage` (§8).

An organization role never implies permission to execute application-domain
actions, including tenant artifacts. Organization owners may manage the
account while remaining unable to read, write, or publish product resources
unless they also hold an application role.

### 7.3 Application roles

Application roles express product-domain authority. Trestle provides the role
and assignment mechanism but does not define an application's business
semantics. The generated defaults are a starting point:

- `app_admin` (Application administrator): every application permission
- `editor` (Editor): `resource.read`, `resource.write`,
  `application.roles.read`
- `reader` (Reader): `resource.read`

An application might replace them with roles such as Agent, Coordinator,
Compliance Reviewer, Author, or Approver.

Assignments are tenant-scoped. `PUT /api/tenant/users/:userId/application-roles`
replaces a member's roles in one transaction and audits the change. It rejects
unknown roles, non-members, and removing the organization's last `app_admin`.

The admin's Organization Roles and Application Roles views show these
catalogs and who holds each role across organizations, read-only.

**Deferred:** custom application roles defined at runtime (roadmap step 6).
The role catalog contains an unused `withCustomRoles` hook, but no storage or
route exists.
Also deferred: constraining assignments to declared resources, and
entitlement-gated custom roles.

### 7.4 Shared role rules

Roles bundle permissions from exactly one authority plane. `defineRoles`
rejects a role that grants a permission from another plane. Direct per-user
permission exceptions are not part of the model. A relationship between an
organization role and an application role must be an explicit application
policy. The only shipped policy is `organizationCreatorApplicationRoles`
(`["app_admin"]`), a one-time grant to the organization's creator.
`memberDefaultApplicationRoles` is empty.

### 7.5 Platform roles

Platform roles are distinct from organization roles, application roles, and
database privileges. They grant no authority inside any tenant. The shipped
defaults:

- `platform_operator` (Platform operator): overview, organizations, users,
  audit, and operations reads; outbox redrive; webhook management; support
  sessions
- `commercial_admin` (Commercial administrator): overview, organizations, and
  subscription reads; entitlement overrides
- `security_admin` (Security administrator): overview, users, and audit
  reads; platform-role reads and management; machine-access reads; API-key
  revocation

Only `security_admin` holds `platform.roles.read`, so only security
administrators see the role and permission views.

Assignments are granted and revoked with the CLI or the Platform Roles view.
Both record each change with a required reason:

```bash
pnpm exec trestle --experimental admin grant ops@example.com security_admin --env local --reason "first operator"
pnpm exec trestle --experimental admin revoke ops@example.com security_admin --env local --reason "left team"
pnpm exec trestle --experimental admin list --env local
```

Platform permissions are narrowly scoped. Cross-tenant reads, each recovery
action, override management, key revocation, and support-session use are
separate permissions. Every platform action requires a reason, must come from
the admin origin, writes `audit_event` in the same transaction, and requires
fresh step-up assurance (§7.6).

The Platform Roles view (`/access/platform-roles`, `platform.roles.read`)
lists assignments and their history with granter, reason, and time, plus
each role's permissions. Granting (`POST /api/admin/platform-roles`) and
revoking (`POST /api/admin/platform-roles/:userId/:role/revoke`) require
`platform.roles.manage`, which needs a passkey step-up when deployed. An
operator cannot revoke their own role; another security administrator must.

### 7.6 Operator authentication and step-up

**Session assurance.** Each admin session records how it was authenticated in
`authentication_assurance` (one row per session: `level`, `method`,
`verified_at`). The level comes from the endpoint that created the session: a
password sign-in is `password`; completing a two-factor challenge (TOTP or a
backup code) is `mfa`; a passkey sign-in is `phishing_resistant`. A session
that replaces an existing one (Better Auth rotates the session when a factor is
enrolled or disabled) carries the prior session's level and `verified_at`, so
enrolling a factor never upgrades or refreshes evidence. When there is nothing
to carry, the new session has no row, and every check reports `missing` until
the operator verifies again. A failed write also leaves the session without a
row (fail closed). Rows cascade with their session.

**Minimum sign-in level.** Every `/api/admin/*` request, including reads and
`GET /api/admin/session`, and every operator-only auth route (the factor
endpoints below, except sign-in challenges without a session), in every
environment, checks how the session was signed in. When the operator has any enrolled factor (TOTP or a passkey), the
session must prove at least `mfa` (a passkey counts); how long ago does not
matter. A session with no assurance row counts as below it. Otherwise the
Worker answers 428 with `scope: "session"` (below) and the shell shows the
sign-in screen: "This account has a second factor. Sign in with it or with a
passkey." This refuses a password-only session for an operator with a
factor, including a customer-app session replayed on the admin: both
surfaces share the Better Auth secret and session table, and the customer app
has no factor challenge. Operators without a factor are not affected, so
they can sign in to enroll one; once the first factor is enrolled, that
password session is refused too and the operator signs in again with it. The factor lookup is skipped when the session
already proves `mfa` or better.

**Requirement.** Every non-GET admin API route with a platform permission
checks the session's evidence before it runs. The environment comes from
`APP_ENV`, and an unset `APP_ENV` is treated as production (fail closed). A
route the view registry marks `stepUp: false` skips this freshness check; the
minimum sign-in level still applies. Two routes use it: `POST
/api/admin/access/explain` (a read over POST) and `POST
/api/admin/support/sessions/:id/end` (it only gives up access).

| Environment | Permission | Required level | Freshness |
| --- | --- | --- | --- |
| `local` | any | `password` | 15 minutes |
| deployed (`preview`, `staging`, `production`, or unset) | any | `mfa` | 15 minutes |
| deployed | `platform.roles.manage` | `phishing_resistant` | 15 minutes |

A higher level satisfies a lower one. `GET /api/admin/session` reports
`assurance` (`{ level, method, verifiedAt }` or `null`),
`factors` (`{ totp, passkeys }`, the operator's enrolled factors), and
`stepUpRequiredAfter` (when the evidence stops being fresh for ordinary
actions, or `null` when none is recorded or the recorded level is below what
actions need in this environment, for example a password session when
deployed).

**The 428 response.** A request whose evidence is missing, stale, or too weak
is refused before it touches data:

```json
{ "error": "step_up_required", "required": "mfa", "maxAgeMinutes": 15,
  "reason": "missing" | "stale" | "insufficient_level",
  "message": "Re-authenticate with a second factor to perform this action" }
```

A session below the minimum sign-in level gets the same error with a scope,
and the UI sends the operator to sign in again rather than to a step-up
dialog:

```json
{ "error": "step_up_required", "required": "mfa", "scope": "session",
  "reason": "missing" | "insufficient_level",
  "message": "Sign in with your second factor or passkey" }
```

The admin UI answers a 428 with a re-authentication dialog that offers only
the paths that reach `required`: a passkey at every level, and a password
(followed by a code when the account has TOTP) for `mfa` and `password`. An
operator with a passkey but no TOTP is not offered a password, because that
sign-in would prove only a password and fall below the minimum sign-in
level. A confirmed action
retries after each successful verification; a factor change (below) retries
once and then reports the second 428. The new session must belong to the
operator who opened the dialog; another account's session is signed out and
nothing is retried. The UI never sends `trustDevice`, so a later step-up
always asks for the second factor again. Known follow-up: stepping up creates
a new session and leaves the previous one alive until it expires.

**Factor management.** The admin origin proxies the operator's own factor
endpoints: two-factor enable, disable, verify-totp, verify-backup-code, and
generate-backup-codes, and passkey list, register, authenticate, and delete.
Sign-in challenges stay open (verify-totp and verify-backup-code without a
session, and passkey authentication); every other factor endpoint, and the
two code endpoints when a session is present, requires a platform operator.
The factor plugins live in the admin (`apps/admin/worker/factors.ts`), so the
customer Worker never bundles them. Enabling, disabling, or regenerating
backup codes, and registering or deleting a passkey, require fresh evidence
(15 minutes) at the strongest factor the account already has: a passkey
requires `phishing_resistant`, TOTP requires `mfa`, and an account with no
factor requires a fresh `password`. A phished TOTP code therefore cannot
remove a passkey, and a stolen password cannot replace an enrolled factor.
Until an operator enrolls a factor, their password alone can enroll one;
enroll factors before granting deployed platform roles.
Refusals:

- 401 `unauthorized`: no session.
- 403 `forbidden` with `reason: "no_platform_roles"`: the account holds no
  platform role.
- 403 `forbidden` with `reason: "local_account"`: the seeded local operator
  (`admin@trestle.local`) outside `APP_ENV=local`.
- 428 `step_up_required`, as above.

Factor changes write organization-less `security.*` audit events
(`security.two_factor.enabled`, `security.passkey.added`, and so on) without
credential material.

**Account security view.** Every operator (`platform.overview.read`) has an
Account security view at `/account/security`: this session's assurance and
freshness, TOTP enrollment (the setup key and backup codes appear once),
backup-code regeneration, and passkey registration and removal. Removing the
last passkey asks for confirmation. The sign-in screen offers a passkey.

**Operator recovery.** There is no self-service recovery and no admin UI for
resetting another operator's factors (**Gap**). An operator who has lost
every passkey, or their authenticator and backup codes, is recovered with a
database action on the migration (owner) connection, after verifying the
person out of band:

```sql
-- Replace the email; run on DATABASE_MIGRATION_URL.
begin;
delete from passkey where user_id = (select id from "user" where email = 'ops@example.com');
delete from two_factor where user_id = (select id from "user" where email = 'ops@example.com');
update "user" set two_factor_enabled = false where email = 'ops@example.com';
delete from session where user_id = (select id from "user" where email = 'ops@example.com');
commit;
```

Deleting the sessions signs the operator out everywhere; the cascade removes
their assurance rows. They then sign in with their password and enroll new
factors, which needs only a fresh password once no factor remains. Record the
recovery in your change log: this path writes no `audit_event`. If the
operator should lose platform access instead, revoke their roles with
`trestle --experimental admin revoke`, which is audited.

## 8. Service Accounts, Scopes, and API Keys

API scopes reuse registered permission codes. Trestle does not maintain a
parallel vocabulary whose meaning can drift from application authorization.

```text
human identity
  -> organization/application/platform role assignment
  -> permission in the same plane

machine identity
  -> service-account application roles
  -> API-key scopes
  -> application permission that admits api_key
```

A service account holds application roles, so managing one is an
application-plane power. Routes:

| Route | Permission |
| --- | --- |
| `GET /api/tenant/service-accounts` | `application.service_accounts.read` |
| `POST /api/tenant/service-accounts` | `application.service_accounts.manage` |
| `POST /api/tenant/service-accounts/:id/api-keys` | `application.service_accounts.manage` |
| `POST /api/tenant/api-keys/:id/rotate` | `application.service_accounts.manage` |
| `POST /api/tenant/api-keys/:id/revoke` | `application.service_accounts.manage` |

Scopes must be registered application permissions that admit `api_key`, and
must already be granted by the service account's roles. Organization and
platform permissions can never be scopes. **Deferred:** reusable scope
profiles, and customer UI for these routes.

### 8.1 Authority calculation

An API key only reduces authority:

```text
tenant entitlement
  intersect service-account application roles
  intersect API-key scopes
  intersect endpoint requirements (the permission must admit api_key)
  intersect environment (the key's environment must match APP_ENV)
  = effective access
```

A request with `Authorization: Bearer tr_…` acts as the key's service account
in the key's own organization. A different `x-trestle-tenant` returns 404.
Every credential failure returns the same generic 401. A scope never bypasses
the service account, tenant entitlement, endpoint policy, or RLS boundary.
Routes without a permission reject API keys. **Deferred:** network (CIDR) and
other request constraints; `CredentialStatus` reserves `network_denied`.

### 8.2 Key lifecycle

Keys belong to tenant service accounts rather than individual employees. A key
has:

- a 16-character public ID and environment prefix
  (`tr_<live|test|dev>_<publicId>_<secret>`; production is `live`, staging and
  preview `test`, local `dev`);
- a 43-character secret displayed exactly once, at mint or rotation;
- only a SHA-256 verifier stored by the application;
- tenant, service-account, environment, and scope bindings;
- an optional expiration; and
- created-by, rotated-from, and revocation (time, actor, reason) metadata.

Keys are resolved before any tenant is known, through the
`trestle_resolve_api_key` SECURITY DEFINER function, which is granted only to
`trestle_app`.

Shipped operations: mint, list metadata, rotate, and revoke. Rotation creates
a replacement with the same scopes. The old key keeps working for an overlap
of 0 to 168 hours (default 24), and rotation never extends its expiry.
Revocation requires a reason. Neither customer nor platform admin can recover
an existing secret. Platform operators with `platform.api_keys.revoke` can
revoke any key from the API Keys view. The revocation is audited on the
owning organization. The Service Accounts view (`platform.machine_access.read`)
lists accounts across organizations with their status, application roles,
resolved permissions, and keys, read-only.

**Deferred:** per-key rate-limit policies, network restrictions, last-used
tracking, safe usage history and metering (the admin's usage panels are always
empty), and suspending a service account (the `status` column exists; no route
changes it; roadmap step 2).

Example presentation:

```text
tr_live_7Ks9Qm2VhX4bLp8N
```

The visible prefix is an identifier, not secret material.

## 9. Plans, Subscriptions, and Entitlements

Trestle owns a provider-neutral commercial projection. Stripe and local
billing are adapters; provider objects do not leak into authorization or
domain contracts. **Deferred:** a Lago adapter.

### 9.1 Feature definitions

A feature is a stable product capability such as `workflows.advanced` or
`members.unlimited`. `packages/billing/src/plans.ts` defines each feature with
a description and a list of named privileges (for example `["run",
"manage"]`).

**Deferred:** typed privilege values (`boolean`, `integer`, `decimal`,
`string`, `select`, `duration`).

Feature definitions describe meaning. They do not contain customer-specific
values.

### 9.2 Versioned plans

Plans are defined in source. Each plan carries a `version` number and a
`lifecycle` type (`draft`, `active`, `grandfathered`, `retired`), and lists its
entitlements. The subscription projection records `plan` and `planVersion`.

The admin Plans view shows this source catalog read-only: each plan's
version, lifecycle, and entitlements, the feature catalog with privileges, and
a feature-by-plan comparison.

**Deferred:** stored plan versions, enforced immutability and lifecycle
transitions, admin plan editing, and explicit or scheduled subscription
migration between versions (roadmap step 5).

### 9.3 Subscription projection

The local subscription projection (`organization_subscription`) records the
tenant, plan, plan version, status, provider, period dates,
`cancel_at_period_end`, and provider reference identifiers. Its entitlements
are stored in `organization_entitlement`. A checkout redirect or client
assertion is never proof of an active subscription.

Verified provider events update subscriptions and entitlements through
idempotent application services. **Deferred:** auditable reconciliation
records. `trestle payments stripe sync` exists for Stripe; there is no admin
reconciliation.

### 9.4 Entitlement overrides

An organization may override a plan entitlement for a negotiated contract.
Overrides are per organization and entitlement, not per subscription
(`organization_entitlement_override`). An override grants or denies one
entitlement defined in `packages/billing/src/plans.ts`. It records a reason,
author, effective time, and optional expiry. It never mutates the plan.

Overrides are authored only in the platform admin
(`platform.entitlements.manage`). Tenant runtimes (`trestle_app`) can read them
but not write them. A new override supersedes the active one for the same
entitlement. Revoking an override tombstones it with its own reason and
restores the plan's decision. Rows are never deleted. When several active
overrides exist, the most recent effective one wins.

### 9.5 Effective entitlements

Application authorization reads a local effective-entitlement projection. A
decision includes safe provenance:

```ts
{
  code: "workflows.advanced",
  enabled: true,
  source: "override",        // or "plan" or "default"
  inheritedFrom: "contract", // "pro@1" for plan grants
  effectiveAt: "2026-09-22T17:00:00Z"
}
```

Override reasons and authors never appear in this provenance.

Application code never calls Stripe while authorizing a request.

```ts
ctx.entitlements.has("workflows.advanced");
ctx.entitlements.resolve("workflows.advanced");
execution.access.require({ entitlement: "workflows.advanced" });
```

### 9.6 Allowances, quotas, and usage

**Deferred.** Included usage, hard or soft quotas, reset periods, overage
behavior, usage ingestion and aggregation, and a Lago or OpenMeter boundary
are not implemented. The billing route returns `usage: []`.

## 10. Explainable Access

Authorization evaluates commercial and actor authority separately:

```ts
execution.access.require({
  entitlement: "workflows.advanced",
  permission: "resource.write",
});
```

`AccessEvaluator` produces an `AccessDecision` that records:

- principal and principal type;
- tenant;
- required entitlement and its provenance;
- required permission, its authority plane, and the roles that granted it;
- organization, application, and platform assignments considered;
- the API-key scope, when present;
- credential status;
- contextual constraints;
- allowed or denied result; and
- a stable reason code.

External responses disclose only information safe for the caller
(`publicDenial`: an error, a reason code, and the missing entitlement code).
`formatAccessExplanation` renders a decision as a table:

```text
Identity                user_123              user
Organization            org_acme              selected tenant
Organization role       owner                 organization authority only
Application role        editor                application authority only
Platform role           none                  no platform authority
Application permission  resource.write        granted by editor
Entitlement             workflows.advanced    enabled by pro@1
--------------------------------------------------------------------------
Decision                ALLOWED
```

The admin Permissions view hosts the Effective Access Explorer. An operator
with `platform.roles.read` chooses an organization, a user or service account
in it, and a registered permission, and
`POST /api/admin/access/explain` returns the `AccessDecision` and its table.
The route also accepts an entitlement. It evaluates the same role catalogs,
plan entitlements, and active overrides the customer Worker uses, resolving
each plane only from its own assignments. A service account that is not
active appears as a failed constraint. It never performs the protected
action, and it explains organization and application authority only.

`GET /api/tenant/access` returns the caller's own assignments and
permissions, not a decision explanation.

## 11. Administrative Information Architecture

The generated platform admin application is a Kumo shell
(`apps/admin/src/main.tsx`, `src/shell/`). It has:

- a left sidebar built from the view registry, grouped and ordered, that
  collapses to icons (`[`, remembered per browser) and becomes a drawer on
  small screens;
- a top bar with breadcrumbs, the command palette trigger, an environment
  badge, and an operator menu (roles, theme, shortcuts, sign-out);
- a persistent warning strip in production and staging, and a support-session
  banner naming the organization, reason, and time left while a support
  session is open, which is the shell's tenant-context indicator;
- a command palette (`Mod+K`, or `/` to search) that runs view commands and
  searches organizations and users by name, email, or slug; and
- keyboard shortcuts: `g` sequences to open views, and view or selection
  commands such as `r` to redrive or revoke. Destructive commands only open a
  confirmation.

Every platform action opens a confirmation that previews its scope and
requires a reason (ending your own support session needs none), then passes
the step-up check (§7.6). Filters, the selected row, and the active tab live
in the URL, so a copied link reopens the same view.

The shipped sidebar:

```text
Overview
  Overview

Customers
  Organizations
  Users
  Support Sessions
  Support Workspace

Commercial
  Plans
  Subscriptions
  Entitlements

Access
  Organization Roles
  Application Roles
  Platform Roles
  Permissions
  Service Accounts
  API Keys

Integrations
  Webhooks

Communications
  Email Delivery

Operations
  Async Operations
  Artifacts
  Audit

System
  Health
  Account Security
```

The shipped views, with their paths, permissions, and capabilities:

- **Overview** (`/`, `platform.overview.read`): what needs attention (dead
  letters, failed webhook deliveries, unconfigured capabilities), each linked
  to its view; organization and user counts; email and payment modes; and
  overview cards contributed by views (Capability health, Dead letters).
- **Organizations** (`/organizations`, `platform.organizations.read`): search
  by name or slug; detail with members, their organization roles, and
  regional settings. Starting a support session from a row requires
  `platform.support_sessions.use`.
- **Users** (`/users`, `platform.users.read`): search by name or email;
  verification, organization memberships, and active platform roles.
  Read-only.
- **Support Sessions** (`/support/sessions`) and **Support Workspace**
  (`/support/workspace`), both `platform.support_sessions.use`: the operator's
  own sessions (start and end) and the read-only organization view inside an
  open session. See the Additions specification.
- **Plans** (`/commercial/plans`, `platform.subscriptions.read`; capability
  `payments`): the source plan and feature catalog (§9.2). It calls no admin
  route.
- **Subscriptions** (`/commercial/subscriptions`,
  `platform.subscriptions.read`; capability `payments`): each organization's
  plan, status, and period end, and in detail its plan entitlements and
  overrides with internal reasons and authors. Granting or revoking an
  override requires `platform.entitlements.manage`. An override needs an
  existing subscription; for an organization without one, a grant is refused
  rather than silently having no effect.
- **Entitlements** (`/commercial/entitlements`, `platform.subscriptions.read`;
  capability `payments`): one organization's effective entitlements and their
  source (plan, override, or not included). Overrides are changed in
  Subscriptions.
- **Organization Roles** and **Application Roles**
  (`/access/organization-roles`, `/access/application-roles`,
  `platform.roles.read`): the role catalogs and who holds each role, including
  service accounts for application roles, and the application-role
  assignments in one organization. Read-only.
- **Platform Roles** (`/access/platform-roles`, `platform.roles.read`):
  assignments and history; grant and revoke require `platform.roles.manage`
  (§7.5).
- **Permissions** (`/access/permissions`, `platform.roles.read`): the
  permission registry and route enforcement (§7.1), and the Effective Access
  Explorer (§10).
- **Service Accounts** (`/access/service-accounts`,
  `platform.machine_access.read`): accounts across organizations with status,
  application roles, resolved permissions, and keys. Read-only.
- **API Keys** (`/access/api-keys`, `platform.machine_access.read`): API-key
  metadata across organizations (prefix, service account, organization,
  scopes, environment, status, lineage). Revoking requires
  `platform.api_keys.revoke`.
- **Webhooks** (`/integrations/webhooks`, `platform.operations.read`):
  endpoints across organizations, and dead or exhausted deliveries. Disabling
  an endpoint or replaying a delivery whose payload is still retained requires
  `platform.webhooks.manage`. Destinations, secrets, and payloads are never
  shown.
- **Email Delivery** (`/communications/email`, `platform.operations.read`;
  capability `email`): provider delivery-status events grouped by provider
  message, filterable by status. Recipients, templates, and bodies are not
  recorded.
- **Async Operations** (`/operations/async`, `platform.operations.read`;
  capability `queues`): outbox counts and dead-lettered events. Redrive
  requires `platform.outbox.redrive`.
- **Artifacts** (`/operations/artifacts`, `platform.operations.read`;
  capability `r2`): counts and bytes per upload state, and stale pending
  uploads.
- **Audit** (`/operations/audit`, `platform.audit.read`): audit history
  across organizations and platform actions, newest first, paginated, and
  filterable by organization, actor ID, event name, or correlation ID. Detail
  shows the redacted summary and links to the event's support session.
- **Health** (`/system/health`, `platform.overview.read`): platform database
  reachability, whether a distinct admin login is configured, customer Worker
  reachability, and the capability projection with setup commands (§5).
- **Account Security** (`/account/security`, `platform.overview.read`): the
  operator's own session assurance, TOTP, backup codes, and passkeys (§7.6).

The views contain UI for further actions: creating webhooks, rotating and
re-scoping API keys, creating and suspending service accounts, editing
roles, permissions, and member role assignments, and revoking another
operator's support session. The admin Worker has no routes for them. The
controls stay hidden, because they check permissions that are not registered
or are switched off in the view. They are **Deferred** to roadmap steps 2, 4,
and 6.

**Deferred:** usage, quotas, and simulation in Entitlements (§9.6), and user
suspension and session revocation in Users (roadmap step 2).

Views appear for every enabled admin and are filtered by permission and
capability state (§5).

### 11.1 Admin views

The default admin application is a starting point, not a closed
Trestle-owned dashboard. Each view is a folder under `apps/admin/src/views/`
with a descriptor, `admin-view.ts`, and a lazily loaded component. The SPA
discovers descriptors with `import.meta.glob("./views/*/admin-view.ts")`
(`src/views.ts`), so the SPA keeps no hand-maintained list of views or
components:

```ts
export default defineAdminView({
  id: "api-keys",
  path: "/access/api-keys",
  navigation: { label: "API Keys", group: "Access", order: 60, icon: KeyIcon },
  permission: "platform.machine_access.read",
  capability: undefined, // optional, e.g. email | payments | queues | r2 | workflows
  entitlement: undefined, // optional feature code
  overviewCard: undefined, // optional { title, order, component }
  component: () => import("./view"),
  commands: [
    { id: "api-keys.open", label: "Go to API Keys", hotkey: "g k" },
    { id: "api-keys.revoke", label: "Revoke the selected API key", hotkey: "r", kind: "action", scope: "selection",
      requires: "an unrevoked API key", destructive: true, permission: "platform.api_keys.revoke" },
  ],
});
```

`buildAdminRegistry` (`src/registry.ts`) reports every problem at once:
invalid or duplicate IDs and paths, unknown navigation groups, non-platform
or unregistered permissions, entitlements that are not defined features,
unknown capabilities, missing icons or components, a view without a navigate
command, invalid command scopes, and hotkey conflicts. Sidebar order comes
from the group order and each view's `order`. Applications add groups in
`src/navigation.ts`.

The admin Worker's authority comes from a separate server registry,
`src/api-registry.ts`. Each entry names the view's ID, path, permission,
capability, and the admin routes it calls:

```ts
{ id: "api-keys", path: "/access/api-keys", label: "API Keys", group: "Access", permission: "platform.machine_access.read", api: [
  { method: "GET", path: "/api/admin/security/api-keys" },
  { method: "POST", path: "/api/admin/security/api-keys/:organizationId/:keyId/revoke", permission: "platform.api_keys.revoke" },
] }
```

`defineAdminViews` fails for duplicate IDs or paths, non-platform or
unregistered permissions, API routes outside `/api/admin/`, non-`GET` routes
without their own platform permission, and one route claimed by views with
different permissions. The admin Worker derives its route policies from this
registry. Tests require both registries to list the same views with the same
paths and permissions, every command permission to be enforced on some admin
route, and every route to have a policy.

`pnpm --filter ./apps/admin check:views` runs during the admin build. It
loads every descriptor and its components, and checks that each view command
has a `useAdminCommands` handler, that destructive commands register only a
confirmation, and that views use Kumo tokens rather than raw colors. With
`--json` it prints the registry (groups, views, commands, hotkeys) for
machine-readable inspection.

To add a view, add `src/views/<id>/admin-view.ts` and its component, an entry
in `src/api-registry.ts`, and the handlers in `worker/index.ts`. Upgrades
treat edited generated files as application-owned and do not overwrite them.

A descriptor's `entitlement` is validated against the feature catalog but
does not yet affect visibility. **Deferred:** typed extension points for
detail panels, resource actions, and table extensions, and admin views in
`trestle` inspection commands.

Registering a view grants no backend authority. Every API operation enforces
its own server-side platform permission. Hiding a navigation item is usability
behavior, not a security boundary.

## 12. Customer Transparency

The customer application's Plan and usage page shows:

- the current plan, plan version, and subscription status;
- whether the subscription renews or cancels at period end; and
- enabled capabilities with their source (`plan: pro@1`, or
  `override: contract` for a contractual override).

**Deferred:** limits, consumption, and reset dates (usage is always empty);
scheduled plan changes; upgrade paths for unavailable features; and
in-context limit explanations such as:

```text
18 of 25 team seats used
Included with Pro
```

A denied request for a missing entitlement returns
`{ error: "entitlement_required", reason: "entitlement_missing", entitlement }`.

The client receives a safe tenant-capability document. It does not receive
provider payloads, internal platform permissions, override reasons or authors,
or sensitive policy details. Client visibility improves usability but is never
the enforcement boundary.

## 13. Domain and Persistence Boundaries

Shipped persistence:

- permission definitions and role catalogs in source (`packages/authz`);
- organization memberships and roles (Better Auth `member`);
- `application_role_assignment` (tenant-scoped, forced RLS, revocation kept
  as history);
- `platform_role_assignment` (readable and writable only by
  `trestle_platform`);
- `service_account` (application roles in `application_roles`) and `api_key`;
- plans and features in source; `organization_subscription` and
  `organization_entitlement`;
- `organization_entitlement_override` (platform-authored, tombstoned);
- `audit_event`;
- `support_session`; and
- `organization_regional_settings`.

**Deferred:** plan and plan-version tables, typed privilege values, scheduled
subscription changes, effective-entitlement tables (effective entitlements
are computed on read), usage aggregates and allowance periods, provider
reconciliation records, scope profiles, a sanitized capability-status
projection table (status is read live), and custom-role tables.

Tenant-owned records use forced RLS for `trestle_app`. Platform reads and
writes use the `trestle_platform` role, whose column grants and RLS policies
allow only listed reads and these transitions:

- dead outbox event to pending;
- webhook endpoint to disabled;
- dead or exhausted webhook delivery to retry;
- insert an entitlement override, or tombstone an active one;
- revoke an active API key;
- start or end a support session; and
- grant or revoke a platform role.

Cross-scope database access is never inferred from a UI route.

Administrative mutations write their `audit_event` in the same PostgreSQL
transaction. **Deferred:** versioned domain events and outbox records for
administrative mutations. Tenant webhook endpoint changes record their audit
event after the change commits, not in the same transaction.

## 14. Audit and Observability

Audit events use semantic names (`<area>.<noun>.<past_verb>`), a schema
version, and a correlation ID. Each records actor type (`user`,
`service_account`, `platform_operator`, or `system`) and ID, organization,
target, optional reason, a redacted summary, outcome, environment, and an
optional support-session ID. Summaries redact keys that look like credentials,
tokens, bodies, payloads, or URLs, truncate long strings, and cap depth and
size.

Tenants read their own history through `GET /api/tenant/audit`
(`organization.audit.read`). Platform actions on an organization appear there
with actor ID `platform` and no reason. Platform-wide events (no organization)
are invisible to tenants.

Shipped audited operations:

- application-role changes (`access.application_roles.changed`);
- platform-role grant and revoke (`platform.role.granted`, `.revoked`);
- service-account creation (`access.service_account.created`);
- API-key mint, rotate, and revoke (`access.api_key.minted`, `.rotated`,
  `.revoked`; `platform.api_key.revoked` from admin);
- entitlement override grant and revoke
  (`platform.entitlement_override.granted`, `.revoked`);
- outbox redrive (`platform.outbox_event.redriven`);
- webhook endpoint disable and delivery replay
  (`platform.webhook_endpoint.disabled`, `platform.webhook_delivery.replayed`);
- tenant webhook endpoint changes (`webhooks.endpoint.created`,
  `.state_changed`, `.subscriptions_changed`);
- support-session start, access, and end; and
- regional settings changes (`organization.regional_settings.changed`).

**Deferred:** organization-role (membership) changes, permission and role
definition changes, plan activation and retirement, subscription migration,
service-account suspension, provider reconciliation, session revocation,
Queue and Workflow recovery outside the outbox, and bulk actions.

Logs recursively redact credentials, API-key material, tokens, sensitive email
content, and provider payload fields. Audit history is not a secret-recovery
mechanism.

## 15. Security Invariants

1. A user identity grants no organization, application, or platform authority
   merely by existing.
2. Organization, application, and platform authority never flow between planes
   unless an explicit application policy declares and tests the relationship.
3. Organization Owner is not Application Administrator and is not Platform
   Administrator.
4. No admin route grants arbitrary SQL or unrestricted Drizzle access.
5. Tenant context always uses the restricted runtime role and forced RLS.
   Admin reads use `trestle_platform`, never a tenant runtime role, and tenant
   runtime logins can never assume `trestle_platform`.
6. Cross-tenant and platform operations require dedicated platform
   permissions.
7. Admin UI visibility never substitutes for server-side authorization.
8. Permission registration is application-owned, code reviewed, and assigned
   to exactly one authority plane.
9. Entitlements never grant actor permissions in any plane.
10. Roles and scopes never grant product entitlements.
11. API-key scopes never exceed service-account authority in the application
    plane.
12. Revoked or expired sessions and keys fail closed. Keys used in the wrong
    environment or held by a suspended service account also fail closed.
13. Provider outages do not silently grant capabilities.
14. Secrets and complete credentials are never readable through admin.
15. SetupPlan files contain secret requirements, not secret values.
16. Destructive and bulk actions preview scope, use idempotency where
    applicable, and report partial failure. **Deferred:** the admin has no
    bulk actions yet.
17. Sensitive platform actions require an explicit reason, come from the
    admin origin, and require fresh step-up assurance: a password locally,
    MFA when deployed, and a passkey to manage platform roles (§7.6). Factor
    changes require the account's strongest enrolled factor. An unset
    `APP_ENV` is treated as production. An operator with a second factor or
    passkey reaches no admin route, reads included, with a session that did
    not sign in with one.
18. All inbound provider webhooks require signature verification and idempotent
    processing before updating authoritative projections.

## 16. CLI, Generators, and Inspection

Shipped commands:

```bash
trestle plan init                # then plan diff and apply --yes
trestle apply <plan> --yes       # capabilities.admin: true scaffolds apps/admin
trestle --experimental admin grant <email> <role> --env <env> --reason <reason>
trestle --experimental admin revoke <email> <role> --env <env> --reason <reason>
trestle --experimental admin list --env <env>
trestle secrets push --env <env> # also pushes admin-targeted and shared secrets
trestle ci validate              # includes the ci.deploy.admin check
trestle upgrade diff             # considers only enabled optional capabilities
```

`create-trestlejs --admin` generates the admin at creation.

**Deferred:** `trestle admin install` (use `--admin` or `trestle apply`),
`trestle generate admin-resource`, `trestle generate admin-view`,
`trestle generate permission`, `trestle permissions`,
`trestle roles --plane …`, `trestle entitlements`, `trestle api-keys doctor`,
and `trestle admin doctor`.

Exact commands ship only when present in installed `trestle --help`.

Machine-readable inspection today covers resources and routes, and
`pnpm --filter ./apps/admin check:views --json` prints the admin view
registry. **Deferred:** permissions with their planes, role definitions and
assignments, route enforcement, feature definitions, and plans.

Generated source remains application-owned. Applying a SetupPlan may restore
missing scaffold registrations but does not overwrite customized domain or UI
code. Enabling the admin refuses to overwrite an existing `apps/admin` file.

## 17. Verification

The subsystem requires unit, integration, PostgreSQL, browser, and deployed
system evidence.

Tests prove:

- organization and application administrators cannot escape their tenant;
- a user with no assignments has no organization, application, or platform
  authority;
- organization Owner authority does not grant application or platform
  permissions, including artifact access;
- application Administrator authority does not grant organization or platform
  permissions;
- platform roles do not imply tenant membership or application authority;
- a role cannot contain a permission from another authority plane;
- platform operators cannot act without the exact platform permission;
- tenant selection does not create platform authority;
- missing, revoked, or stale membership fails closed;
- roles in each authority plane resolve deterministic effective permissions;
- API-key scopes only reduce service-account authority;
- expired, revoked, rotated, or wrong-environment keys fail closed;
- route metadata and enforcement do not drift, for the customer and admin
  Workers, and the admin's UI and server view registries agree;
- a dropped-in admin view is discovered and placed in the sidebar, and
  invalid descriptors, unhandled commands, and destructive commands that skip
  confirmation fail the admin build;
- unsubscribed tenants cannot use entitled features;
- override reasons do not reach customer provenance;
- setup never persists or logs plaintext credentials;
- admin reports missing configuration and points to `trestle doctor --env <environment>`;
- admin actions preserve validation, audit, and RLS; and
- a project generated with and without `--admin` builds, validates its CI, and
  deploys (dry run) as expected.

**Deferred:** plan-version explanation tests, Lago adapter normalization,
cross-environment cache tests, and deployed-system evidence for the admin.

## 18. Delivery Sequence

The subsystem's shipped history is in the
[Admin Integration Plan](ADMIN_INTEGRATION_PLAN.md) and
[Release History](RELEASE_HISTORY.md). `pnpm check:generated` requires the
admin canary scenarios (admin disabled and enabled, apply parity, platform
sign-in, cross-plane denial, support sessions, step-up, and API key
revocation) to pass.

**Pending:** the first deployed run of the admin staging path against an
admin-enabled staging project with isolated resources.

**Deferred:** see the Implementation status list above and the
[admin roadmap](superpowers/plans/2026-09-23-admin-roadmap.md).

## 19. Acceptance Criteria

The administration and access-control system is beta-ready when a clean
generated application can, without manual source repair:

1. run `trestle plan init`, enter environment credentials, review a SetupPlan
   diff (`trestle plan diff`), apply it (`trestle apply --yes`), and pass
   Doctor checks;
2. deploy public, customer, admin, and Worker surfaces with distinct origins
   and policies (implemented for staging and production; not yet verified
   against isolated staging resources);
3. show absent or unhealthy capabilities in admin without accepting secrets or
   failing unsafely (shipped);
4. define registered permissions in all three authority planes, assign their
   respective roles, and prove authority does not flow between planes
   (shipped); explain effective human access through a route or view
   (shipped: the admin Effective Access Explorer);
5. define features and typed privileges, activate a versioned plan, subscribe
   a tenant, apply an audited override, and explain effective entitlements
   (audited overrides and provenance ship; typed privileges and plan
   activation are **Deferred**);
6. present the same safe plan, usage, and entitlement truth in the customer
   application (plan and entitlements ship; usage is **Deferred**);
7. create a service account, mint a one-time API key, authorize a scoped route,
   rotate the key, and prove the old key stops working (shipped through the
   API);
8. prove API scopes cannot exceed the service account, tenant entitlement,
   endpoint policy, environment, or RLS boundary (shipped);
9. reconcile local and provider commercial state without authorizing directly
   from provider responses (**Deferred** beyond Stripe sync);
10. reconstruct every sensitive administrative change through redacted,
    correlated audit evidence (shipped for the operations listed in §14);
11. add an application-owned admin view, see it in the left sidebar, enforce
    its registered permission on the server, and retain it through a later
    SetupPlan apply (shipped: `admin-view.ts` discovery plus a server
    registry entry).
