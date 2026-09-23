# TrestleJS Administration and Access Control Specification

**Status:** Draft v0.1

**Scope:** Guided project setup, organization and application administration,
platform operations, commercial capabilities, authorization, service accounts,
and API keys.

**Parent specification:** [TrestleJS Specification](TRESTLEJS_SPEC.md)

## 1. Purpose

TrestleJS needs an administrative system that can explain and safely operate a
multi-tenant product without becoming a generic database browser or a remote
code generator.

This specification defines four distinct surfaces:

```text
apps/site       public acquisition and documentation
apps/app        customer product, organization, and application administration
apps/admin      runtime platform operations
trestle setup   local project and capability configuration
```

The separation is a security boundary, not a navigation preference.

The setup console controls what the application is made of. The generated
admin application controls and observes the running application. Tenant
administration remains in the customer application. All three use shared,
typed capability metadata, but they do not share authority.

## 2. Governing Principles

1. Authentication establishes identity but grants no application authority by
   itself.
2. Organization administration, application authorization, and platform
   operations are three independent authority planes.
3. Authority does not flow between planes unless the application explicitly
   declares, enforces, and tests a relationship.
4. Selecting a tenant never grants cross-tenant or platform authority.
5. Administrative actions use application semantics, validation, events, and
   audit behavior rather than unrestricted database mutation.
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

`apps/app` contains the customer product and tenant-bound administration:

- profile, security, and notification settings;
- organization membership and invitations;
- organization and application roles and their independent assignments;
- customer-managed billing and plan visibility;
- entitlement, allowance, quota, and usage visibility;
- service accounts and API-key lifecycle, when enabled; and
- product workflows and tenant-owned resources.

Organization and application administrators remain normal tenant principals.
Their operations use an `ExecutionContext`, plane-specific permissions,
`withTenant()`, and forced RLS.

### 3.3 Platform admin application

`apps/admin` is an optional, separately deployed runtime control plane for
authorized product operators. It has a separate origin, application entry
point, authorization policy, session posture, and deployment configuration.
It shares domain services and contracts with the customer application but is
not bundled into the customer application.

The platform admin application may:

- inspect sanitized runtime and provider health;
- find organizations, users, subscriptions, jobs, and correlation records;
- enter an explicitly authorized tenant context;
- execute narrow, application-backed platform actions;
- manage plans, entitlements, roles, and other runtime domain configuration;
- reconcile normalized provider projections;
- inspect and recover asynchronous operations; and
- revoke compromised sessions, service accounts, or API keys.

It may not:

- browse or mutate arbitrary database tables;
- execute raw SQL;
- reveal secret values, credentials, authentication tokens, or API-key
  material;
- rewrite application source, manifests, migrations, or deployment files;
- install packages or bindings;
- silently bypass domain validation or audit behavior; or
- acquire global authority merely by selecting a tenant.

### 3.4 Trestle setup console

`pnpm exec trestle setup` starts a local, guided configuration console. It is
the only browser surface allowed to propose changes to the SetupPlan, generated
source, encrypted credentials, bindings, migrations, or deployment
configuration.

The setup console is a local development tool, not a deployed application. It
binds only to loopback, chooses an available random port, requires a one-time
session token, applies CSRF protection, and destroys its temporary session when
closed.

Generated projects must use their pinned CLI:

```bash
npx create-trestlejs my-product
cd my-product
pnpm exec trestle setup
pnpm exec trestle dev
```

Using `npx ...@latest` inside an existing project is not the normal path.

## 4. Guided Setup

The setup console orchestrates existing deterministic primitives rather than
introducing a second configuration model:

```text
inspect project
  -> load or create SetupPlan
  -> select capabilities
  -> collect encrypted credentials
  -> test provider connections
  -> display plan diff
  -> request explicit approval
  -> apply
  -> run Doctor verification
  -> record non-secret evidence
```

The wizard covers:

1. application identity, domains, and environments;
2. public site, customer application, and platform admin surfaces;
3. authentication and organization behavior;
4. email disabled, local capture, or Resend;
5. payments disabled, local, Stripe, or Lago;
6. plan and entitlement support;
7. PostgreSQL and remote Neon configuration;
8. outbox, Queues, Workflows, schedules, and DLQ;
9. local or R2 artifact storage and retention;
10. roles, permissions, service accounts, and API keys;
11. GitHub and Cloudflare deployment environments; and
12. review, apply, and verification.

The command is resumable and safe to rerun. Supported interaction modes should
include:

```bash
pnpm exec trestle setup
pnpm exec trestle setup --no-open
pnpm exec trestle setup --resume
pnpm exec trestle setup --plan-only
pnpm exec trestle setup --env staging
```

`trestle setup` is the guided interface. `trestle plan`, `trestle apply`, and
`trestle doctor` remain the reviewable planning, mutation, and verification
engines underneath it.

### 4.1 Secret handling

Plaintext secret values:

- never enter a SetupPlan or project manifest;
- never appear in URLs, logs, analytics, crash reports, command history, or
  browser storage;
- are encrypted immediately into the appropriate environment credential
  document or projected through an explicit provider secret operation;
- are never returned to the browser after submission; and
- are removed from temporary memory and files when the operation ends.

The console may display only secret presence, environment, a non-sensitive
fingerprint or prefix, last-updated time, and verification state. Connection
tests return sanitized provider status.

## 5. Capability Lifecycle

Every optional capability has an explicit lifecycle:

```text
disabled -> declared -> configured -> deployed -> verified
```

- **Disabled:** no product claim is made and unnecessary routes, bindings, and
  requirements are absent.
- **Declared:** the SetupPlan and manifest request the capability.
- **Configured:** required source, bindings, and secret names are present.
- **Deployed:** the target environment reports the required resources.
- **Verified:** an environment-appropriate Doctor or smoke check has passed.

The admin application consumes a sanitized capability-status projection. It
assumes configured capabilities are managed through setup and does not collect
infrastructure credentials itself.

When configuration is absent or unhealthy, admin must degrade safely:

```text
Email delivery is not configured for staging.
Run: pnpm exec trestle setup --env staging
```

Unavailable screens or actions are hidden or disabled with an explanation.
They must not fail later through an avoidable provider exception.

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
│   ├── OrganizationRole
│   └── OrganizationPermission
├── Application
│   ├── ApplicationRole
│   └── ApplicationPermission
└── Platform
    ├── PlatformRole
    └── PlatformPermission
```

### 6.1 Identities

- **User:** a human identity authenticated by the application's configured
  authentication provider. A user possesses no organization, application, or
  platform authority merely by existing.
- **Service account:** a tenant-owned non-human identity used by integrations,
  automations, and external clients.
- **API key:** a revocable credential that authenticates a service account. An
  API key is not an independent identity or authority grant.
- **System principal:** a scheduled, queue, Workflow, or internal recovery
  identity with explicitly declared machine authority.

`Platform operator` is not an identity type. It is a user with one or more
platform-role assignments. The same user may independently have organization
or application assignments without those assignments becoming platform
authority.

### 6.2 Independent authority planes

A human user may have unrelated assignments in all three planes:

```text
User
├── OrganizationMembership
│   └── OrganizationRoleAssignment[]
├── ApplicationRoleAssignment[]
│   └── scoped to an organization and optional application resource
└── PlatformRoleAssignment[]
    └── platform scope
```

- **Organization authority** governs the SaaS account relationship: members,
  invitations, organization settings, billing administration, and API-key
  administration.
- **Application authority** governs product-domain actions: for example,
  reviewing transactions, publishing workflows, or approving compliance.
- **Platform authority** governs operation of the SaaS across tenants: support,
  session revocation, job recovery, reconciliation, and emergency response.

An organization owner is not automatically an application administrator. An
application administrator is not a platform administrator. Even the term
`Administrator` is meaningful only with an explicit authority plane.

Whether application-role assignments are stored through a membership row or a
separate assignment table is an implementation detail. Semantically they
remain distinct from organization roles and are always scoped to the relevant
organization.

### 6.3 Execution context

Human and machine requests resolve an `ExecutionContext`. The context records
the identity and principal type, selected tenant when applicable, freshly
resolved organization, application, and platform authority, effective
entitlements, correlation metadata, environment, and services.

Authentication establishes identity. Authority permits actions. Entitlements
permit tenant capabilities. Tenant context bounds data. These are separate
checks and have separate failure reasons.

## 7. Permissions and Roles

### 7.1 Permission registry

Permission definitions use stable project-wide codes. The effective catalog
merges protected Trestle/source definitions with custom definitions created in
admin:

```ts
export const permissions = definePermissions({
  "organization.members.invite": {
    plane: "organization",
    description: "Invite members to the organization",
    principals: ["user"],
  },
  "workflows.publish": {
    plane: "application",
    description: "Publish workflow definitions",
    principals: ["user", "api_key"],
    entitlement: "workflows.advanced",
  },
  "platform.jobs.redrive": {
    plane: "platform",
    description: "Redrive failed platform jobs",
    principals: ["user"],
  },
  "workflows.read": {
    plane: "application",
    description: "Read workflows and execution status",
    principals: ["user", "api_key"],
  },
});
```

Every permission declares exactly one authority plane. Names should make the
plane apparent, but the explicit `plane` value is authoritative and validated.

Authorized administrators can create a permission directly from the
Permissions view:

```text
New permission -> Name and description -> Plane -> Principals
               -> Optional entitlement -> Create -> Add to roles
```

The form derives a stable code from a resource and action or accepts an edited
code before creation. A permission records:

```ts
type PermissionDefinition = {
  code: string;
  name: string;
  description: string;
  plane: "organization" | "application" | "platform";
  principals: Array<"user" | "api_key" | "system">;
  entitlement?: string;
  origin: "trestle" | "source" | "admin";
  state: "active" | "deprecated";
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
};
```

The code and plane become immutable after creation. Name and description remain
editable. Widening principal types or changing an entitlement gate is a
sensitive change that previews affected roles and enforcement points, requires
a reason, and emits an audit/outbox event.

Trestle and source-defined permissions are protected but may be used in any
same-plane role. Admin-defined permissions are project-wide rather than
tenant-specific: tenants compose them into their own roles, but cannot redefine
their meaning.

Route and action metadata identify required permissions, entitlements, and
allowed principal types. Machine-readable inspection reports where every
permission is enforced.

Creating or assigning a permission does not make application code enforce it.
The permission detail reports discovered routes, actions, workflows, and policy
checks. Until at least one enforcement point is discovered, it displays **No
enforcement discovered** and explains that assignment alone grants no behavior.
It must never substitute the misleading claim “checked in code” when no
evidence exists.

The runtime registry resolves both protected and admin-defined active codes.
Application code may require an admin-defined code through the normal access
API. Generated TypeScript declarations and inspection artifacts can be refreshed
from the catalog for autocomplete, but generated types are not a second source
of truth.

An active permission may be assigned to one or more roles in the same plane.
The permission detail includes a Roles tab with **Add to roles** and **Remove
from role** actions. Direct user permission grants remain unsupported.

Deletion is allowed only for an admin-defined permission with no role,
enforcement, scope-profile, or audit-policy references. Otherwise the operator
deprecates it. Deprecated permissions cannot be newly assigned, remain visible
on existing roles and historical events, and show the work required before
removal.

### 7.2 Organization roles

Organization roles express generic SaaS/account administration authority.
Trestle provides customizable defaults:

- Owner
- Administrator
- Billing administrator
- Member

Representative organization permissions include
`organization.members.invite`, `organization.members.remove`,
`organization.roles.assign`, `organization.billing.manage`, and
`organization.api_keys.manage`.

An organization role never implies permission to execute application-domain
actions. Organization owners may manage who belongs to the organization while
remaining unable to approve, publish, or override product resources.

Organizations may define custom organization roles from registered
organization-plane permissions. A custom role has a stable key, name,
description, permission set, creation/update attribution, and tenant scope.
The primary management flow is:

```text
Choose organization -> New role -> Name and description
                    -> Select permissions -> Create role -> Assign members
```

The UI generates the key from the name and keeps key editing secondary. A role
requires at least one permission. Only organization-plane permissions may be
selected. The permission picker is searchable, grouped by resource, and shows
plain-language descriptions alongside codes.

Owner, Administrator, Billing administrator, and Member are protected built-in
roles. They remain visible and assignable but cannot be deleted or silently
redefined at runtime. An administrator may clone a built-in role into a custom
role and then edit the clone.

Custom organization roles are tenant-scoped. Creating a role in Acme never
changes the role catalog of another organization. Platform operators may manage
them only through an explicitly authorized tenant context or a narrowly scoped
platform permission; ordinary cross-tenant read access is insufficient.

### 7.3 Application roles

Application roles express product-domain authority. Trestle provides the role
and assignment mechanism but does not define an application's business
semantics. A generated application might define roles such as Agent,
Coordinator, Managing Broker, Compliance Reviewer, Author, or Approver.

Application-role assignments are tenant-scoped and may be further constrained
to declared application resources. Representative application permissions
include `transactions.review`, `compliance.approve`, and
`workflows.publish`.

Custom application-role creation may itself require an entitlement.
Entitlements control whether an organization may configure custom roles; they
do not change the authorization semantics of roles once assigned.

Custom application roles use the same role editor but accept only registered
application-plane permissions. They may be assigned to organization members
and service accounts. A role definition page exposes Overview, Permissions,
Assignments, and Audit so operators can understand both what a role grants and
who receives it.

### 7.4 Shared role rules

Roles bundle permissions from exactly one authority plane. Direct per-user
permission exceptions are not part of the default model because they make
effective access difficult to understand and audit. A relationship between an
organization role and an application role must be an explicit application
policy, not an implicit Trestle convention.

Role-definition and assignment operations are separate:

- creating an unassigned role is reversible and records attribution without a
  destructive confirmation;
- changing permissions on an assigned role shows the permission diff and
  affected member/service-account count, then requires confirmation and a
  reason;
- assigning or revoking a role shows the subject, plane, role, and resulting
  role set, then records an audit/outbox event;
- deleting an assigned role is blocked until assignments are replaced or an
  explicit migration/revocation action is chosen; and
- directory-sourced assignments identify their source and cannot be manually
  revoked without changing the owning directory mapping.

Admin users compose registered permissions into roles and may add custom
project-wide definitions. A role assignment alone never creates enforcement;
effective behavior still requires an application route, action, workflow, or
policy check to require that permission.

### 7.5 Platform roles

Platform roles are distinct from organization roles, application roles, and
database privileges. Useful defaults include:

- Support
- Billing operations
- Platform operator
- Security administrator

Platform permissions are narrowly scoped. Cross-tenant reads, global actions,
tenant-context entry, and emergency revocation are separate permissions.
Sensitive actions require an audit reason and may require step-up
authentication.

Managing tenant role definitions from platform admin is also separate from
managing global platform roles. Trestle registers narrow permissions such as
`platform.tenant_roles.manage` and `platform.tenant_roles.assign`; neither is
implied by `platform.roles.read` or `platform.roles.manage`. These actions
require an active tenant context, operate through the tenant-scoped domain
services and RLS boundary, and retain the operator, support session, tenant,
reason, and permission diff in audit.

## 8. Service Accounts, Scopes, and API Keys

API scopes reuse registered permission codes. Trestle does not maintain a
parallel vocabulary whose meaning can drift from application authorization.

```text
human identity
  -> organization/application/platform role assignment
  -> permission in the same plane

machine identity
  -> service-account application role assignment
  -> API-key scopes
  -> application permission
```

Admin users may compose registered permissions into reusable scope profiles.
They may assign a profile or a narrower set of scopes when minting a key.
Machine-capable organization or platform permissions require an explicit
principal declaration and are not enabled by default.

### 8.1 Service-account lifecycle

The Service Accounts destination is a management surface, not a read-only
inventory. After choosing an organization, an authorized administrator can:

- create a service account with a required name, optional description, and one
  or more application roles;
- open an account and inspect its status, roles, effective permissions, API-key
  metadata, recent usage, and audit activity;
- edit its name and description, change application-role assignments, and
  suspend or reactivate it; and
- delete the account through an impact-aware, audited workflow.

The primary creation path stays deliberately short:

```text
New service account -> Name -> Application roles -> Create
```

Description is available without being required. After creation, Trestle opens
the account detail and offers **Create API key** as a separate action so account
creation never exposes or silently creates a credential. A normalized name is
unique among non-deleted service accounts in one organization. A conflict is
reported in the form and does not discard entered values.

Service-account detail uses **Overview**, **Roles & permissions**, **API keys**,
**Usage**, and **Audit** tabs. Effective access shows the complete reduction
from application-role permissions through tenant entitlements and each key's
scope ceiling. API-key views expose only safe identifiers, status, scopes,
creation, expiry, last-used, rotation, and revocation metadata.

**Delete service account** is a user-facing deletion operation backed by a
retained tombstone. Confirmation shows active keys, assigned roles, recent use,
and any known dependencies; requires the account name and a reason; and then
atomically disables authentication, revokes every active key, removes active
role assignments, and records `deleted_at`, `deleted_by`, and the audit event.
Deleted accounts disappear from the default inventory but remain available in
history and audit views. Historical events and provider references are never
rewritten to pretend the principal did not exist. No credential belonging to a
deleted account can authenticate, including during a previous rotation overlap.

Organization administrators use `organization.service_accounts.manage` for
this lifecycle and `organization.api_keys.manage` for credential operations.
A platform operator may manage a tenant's service accounts only in an active
tenant-context session with the narrow
`platform.tenant_machine_access.manage` permission. The emergency
`platform.machine_access.revoke` permission still grants suspension and
revocation only; it does not imply create, edit, reactivate, or delete. Minting
a customer credential from the platform surface requires the separate
`platform.tenant_api_keys.manage` permission, phishing-resistant step-up,
reason, and one-time secret presentation. It is available only while the
operator is in the key's tenant context and is omitted entirely when the
capability or permission is absent.

### 8.2 Authority calculation

An API key only reduces authority:

```text
tenant entitlement
  intersect service-account authority in the required plane
  intersect API-key scopes
  intersect endpoint requirements
  intersect environment and request constraints
  = effective access
```

A scope never bypasses the service account, tenant entitlement, endpoint
policy, or RLS boundary. Routes may explicitly reject API-key principals.

### 8.3 Key lifecycle

Keys belong to tenant service accounts rather than individual employees by
default. A key has:

- an opaque public identifier and recognizable environment prefix;
- a high-entropy secret displayed exactly once;
- only a non-reversible verifier stored by the application;
- tenant, service-account, environment, and scope bindings;
- optional expiration and network restrictions;
- created-by, last-used, rotation, and revocation metadata; and
- a configurable rate-limit policy.

Required operations are mint, list metadata, rotate with a bounded overlap,
revoke, and inspect safe usage history. Neither customer nor platform admin can
recover an existing secret.

The API Keys destination exposes **Create API key** as its primary action. The
creation workflow is:

```text
Choose organization -> Choose service account -> Name -> Environment
  -> Choose scopes -> Optional expiry/restrictions -> Create key
  -> Copy or download the secret once
```

Only active service accounts are selectable. Scope selection starts empty and
is limited to the intersection of the service account's application-role
permissions, tenant entitlements, environment policy, and the acting
administrator's authority. The form shows excluded scopes and why they are
unavailable rather than silently widening access. A human-readable key name is
required so inventories and audit events do not rely on prefixes alone.

After creation, the full secret appears in a single-use result view with copy
and secure-download actions. The administrator must acknowledge that it has
been stored before dismissing the view; dismissal does not make the secret
recoverable. Retrying after an ambiguous response uses an idempotency key and
must never mint an accidental second credential.

Opening a key shows its name, safe prefix, owning organization and service
account, environment, scopes, status, created/expiry/last-used timestamps,
network restrictions, usage summary, rotation lineage, and audit activity.
Authorized administrators can edit non-authority metadata and restrictions,
rotate with an explicit overlap window, or revoke immediately. Scope widening
creates a replacement key rather than mutating an active credential in place;
scope narrowing may be applied immediately and is audited. A revoked key is
never deleted from historical records or reactivated.

Example presentation:

```text
tr_live_7Ks9............
```

The visible prefix is an identifier, not secret material.

## 9. Plans, Subscriptions, and Entitlements

Trestle owns a provider-neutral commercial projection. Stripe, Lago, and local
billing are adapters; provider objects do not leak into authorization or domain
contracts.

### 9.1 Feature definitions

A feature is a stable product capability such as `team.members` or
`workflows.advanced`. Features may define typed privileges:

- `boolean`
- `integer`
- `decimal`
- `string`
- `select`
- `duration`

Feature definitions describe meaning and value shape. They do not contain
customer-specific values.

### 9.2 Versioned plans

Plans are immutable once activated. Editing an active plan creates a new plan
version. Plan versions move through:

```text
draft -> active -> grandfathered -> retired
```

A plan entitlement assigns a feature and typed privilege values to one plan
version. Existing subscriptions retain their recorded version until an
explicit migration or scheduled change occurs.

The admin Plans view supports creating a plan family directly. The primary
flow is intentionally small:

```text
New plan -> Name -> Create plan -> Edit features
```

Trestle derives a stable lowercase key from the name, creates version 1 as an
empty draft, selects the new plan, and opens the structured feature editor.
Creating an inert draft does not ask for pricing-provider data, raw JSON, a
confirmation dialog, or an operator-supplied audit reason. The creation is
still attributed and audited. Activation remains an explicit confirmed action
with a reason because it makes the plan available to subscriptions.

The generated key is shown as secondary text and may be changed before the
draft is created. A key becomes immutable after creation. Name and key
validation errors remain in the creation form, and duplicate keys fail without
discarding the entered name.

### 9.3 Subscription projection

The local subscription projection records the tenant, plan version, status,
commercial provider, provider-neutral lifecycle dates, and provider reference
identifiers. A checkout redirect or client assertion is never proof of an
active subscription.

Verified provider events update subscriptions and entitlements through
idempotent application services. When necessary, reconciliation compares the
provider with the local projection and records an auditable result.

### 9.3.1 Provider catalog and subscription linkage

Provider linkage is explicit, local, environment-specific, and inspectable. It
is never inferred from display names and never stored only in an environment
variable.

For Stripe, the relationship is:

```text
Trestle plan family             -> Stripe Product
Trestle plan version + offer    -> Stripe Price
Trestle organization            -> Stripe Customer
Trestle subscription            -> Stripe Subscription
Trestle subscription line       -> Stripe Subscription Item + Price
```

An offer identifies the commercial variant of one entitlement version, such as
monthly USD, annual USD, or monthly EUR. A plan version may therefore have more
than one Stripe Price while preserving one entitlement definition. V1 may ship
with one recurring offer per plan version, but persistence and APIs must not
assume that the relationship is permanently one-to-one.

Trestle stores a provider-neutral catalog mapping with at least:

```ts
type BillingCatalogMapping = {
  provider: "stripe" | "lago" | "local";
  environment: "local" | "preview" | "staging" | "production";
  plan: string;
  planVersion: string;
  offer: string;
  providerProductId?: string;
  providerPriceId?: string;
  currency?: string;
  interval?: "month" | "year";
  active: boolean;
  verifiedAt?: Date;
};
```

The subscription projection records the provider customer, subscription,
subscription item, and selected provider-price references in addition to the
Trestle plan version. Provider identifiers are safe references, not authority.
Effective entitlements always resolve from the local Trestle plan version.

Catalog mapping is configured on the plan/version, not recreated independently
for every customer subscription. The Subscriptions view displays the resolved
chain and reconciliation state:

```text
Acme Robotics
Trestle       pro@3 · annual-usd
Stripe        prod_… · price_…
Customer      cus_…
Subscription  sub_…
Item          si_…
Mapping       verified
```

Operators may connect an existing provider product and price or ask the
provider adapter to create/synchronize them. Trestle validates that the price
belongs to the selected product, is in the correct Stripe mode, matches the
declared currency and interval, and is not already mapped incompatibly.
Changing a price creates or selects a replacement offer mapping; it never
mutates historical subscription meaning.

Webhook ingestion resolves Stripe Price and Subscription Item identifiers
through this mapping. Unknown, missing, or conflicting mappings fail closed,
retain the provider event for recovery, and produce an operator attention item.
They never guess a plan from a Stripe display name. Reconciliation compares the
complete linkage as well as normalized status and period dates.

### 9.4 Subscription overrides

A subscription may override plan entitlement values for a negotiated contract.
Overrides require a reason, author, effective time, and optional expiration.
They apply only to the identified subscription and never mutate the base plan.

### 9.5 Effective entitlements

Application authorization reads a local effective-entitlement projection. A
decision includes safe provenance:

```ts
{
  code: "team.members",
  enabled: true,
  values: { maximum: 40 },
  source: "subscription_override",
  inheritedFrom: "pro@3",
  effectiveAt: "2026-09-22T17:00:00Z"
}
```

Application code never calls Stripe or Lago while authorizing a request.

```ts
ctx.entitlements.require("workflows.advanced");
const members = ctx.entitlements.get("team.members");
```

### 9.5.1 Admin entitlement explorer

The admin Entitlements view is a customer-access explorer, not a raw projection
viewer. Its primary operator jobs are:

1. find an organization;
2. understand what product capabilities it currently has;
3. understand why each effective value exists;
4. inspect limits and usage; and
5. compare a proposed plan or override with the current state.

After organization selection, the view begins with customer context:

```text
Acme Robotics
Pro @3 · active · Stripe annual-usd · updated 2 minutes ago
6 enabled · 2 unavailable · 1 override · 2 usage limits
```

The main feature table is derived from the complete feature catalog, not only
the rows currently present in the effective projection. It therefore explains
both enabled and unavailable capabilities. Each row contains:

- human feature name and stable code;
- effective access: Included, Not included, or Overridden;
- effective typed value;
- usage, limit, and reset date where applicable;
- source such as `Pro @3` or a named subscription override; and
- effective and expiration dates.

Opening a row shows the calculation in order:

```text
Plan value       team.members.maximum = 25       Pro @3
Override         team.members.maximum = 40       Contract expansion
Usage            18 of 40                         resets Oct 1
Effective value  40                               allowed
```

Plain-language labels lead; internal codes remain visible as secondary text for
debugging and support. The view never suggests that an entitlement grants a
permission.

Simulation is presented as **Compare changes**, a secondary workflow launched
from the selected organization. It defaults to that organization's current plan
and displays Current versus Proposed values, with changed rows first. Operators
may choose another active plan and add hypothetical overrides. Comparing writes
nothing. Applying a plan change or override remains a separate, explicit,
authorized workflow using the existing subscription operations.

When no organization is selected, the page presents a searchable organization
list with plan and subscription status rather than a large empty panel and an
unscoped simulation form. Deep links from Organizations and Subscriptions open
the explorer with the organization already selected.

The server returns one composed, permission-filtered document containing
organization context, subscription and plan references, the complete effective
feature rows, quotas, active overrides, and projection freshness. The browser
does not reconstruct entitlement provenance by joining several unrelated API
responses.

### 9.6 Allowances, quotas, and usage

An entitlement may carry included usage, a hard or soft quota, a reset period,
and overage behavior. Usage ingestion, aggregation, and billing remain separate
concerns from authorization even when they share a feature code.

Trestle provides a small native model and a provider boundary. Lago may own
advanced metering, rating, invoices, and commercial subscriptions while
Trestle synchronizes the normalized subscription and effective-entitlement
projection. Lago is optional and is not embedded into the Trestle runtime.

## 10. Explainable Access

Authorization evaluates commercial and actor authority separately:

```ts
await ctx.access.require({
  entitlement: "workflows.advanced",
  permission: "workflows.publish",
});
```

An internal `AccessDecision` records:

- principal and principal type;
- tenant and resource scope;
- required entitlement and its provenance;
- required permission and its authority plane;
- organization, application, and platform assignments considered;
- the granting role or scope provenance within the required plane;
- contextual constraints;
- allowed or denied result; and
- a stable reason code.

External responses disclose only information safe for the caller. Admin may
offer an Effective Access Explorer to authorized operators:

```text
Identity                Jane Smith            authenticated via Better Auth
Organization            Acme                  active member
Organization role       Owner                 account administration only
Application role        Coordinator           tenant-scoped
Application permission  transactions.review   granted
Entitlement             compliance.advanced   enabled by Pro @ v3
Platform role           none                  no platform authority
Resource tenant         Acme                  matched
RLS tenant context      Acme                  active
--------------------------------------------------------------------------
Decision                ALLOWED
```

The explorer evaluates real policy but does not execute the protected action.

## 11. Administrative Information Architecture

The generated platform admin application uses a conventional SaaS shell with a
persistent, collapsible left sidebar on desktop and an accessible drawer on
smaller screens. The shell provides application identity, environment and
tenant-context indicators, global search, operator identity, breadcrumbs, and
the primary navigation. Dangerous environment or tenant context must remain
visible while an operator acts.

The default sidebar groups capability-aware sections rather than presenting an
unstructured route list:

```text
Overview

Customers
  Organizations
  Users

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
  Notification Streams
  Email Delivery

Operations
  Async Operations
  Artifacts
  Audit

System
  Authentication
  Account Security
  Health
```

The generated application provides these default views:

- **Overview:** system health, environments, deployments, migrations, and
  provider modes.
- **Organizations:** search, status, memberships, and authorized tenant-context
  entry.
- **Users:** verification state, memberships, suspension, and session
  revocation.
- **Plans:** one-step plan-family creation, feature catalog, typed privileges,
  versioned plans, and comparison matrix.
- **Subscriptions:** lifecycle, provider projection, scheduled changes,
  overrides, reconciliation, and history.
- **Entitlements:** organization-centered effective access, unavailable
  features, provenance, overrides, quotas and usage, and side-by-side change
  comparison.
- **Organization roles:** tenant-scoped custom role creation, descriptions,
  organization-permission composition, membership assignments, and protected
  built-in roles.
- **Application roles:** tenant-scoped custom role creation,
  application-permission composition, user and service-account assignments,
  and enforcement discovery.
- **Platform roles:** operator roles, narrow platform permissions, and
  assignment history.
- **Permissions:** the three-plane registry, enforcement discovery, and
  effective-access explanation.
- **Service accounts and API keys:** creation, inspectable account detail,
  descriptions, application-role assignment, effective permissions, safe key
  metadata, usage, suspension, rotation, revocation, and audited deletion.
- **Webhooks:** endpoint creation and configuration, event subscriptions,
  signing-secret rotation, health, delivery attempts, replay, and deletion.
- **Notification streams:** versioned send contracts, input schemas, channel
  routing, templates, preferences, testing, publishing, and secondary delivery
  history.
- **Email:** template identifier, logical recipient, provider-neutral status,
  correlation data, and safe failure category.
- **Async operations:** outbox, Queues, DLQ, Workflows, retries, and redrive.
- **Artifacts:** ownership, metadata, signed-access status, retention, and
  cleanup state.
- **Audit:** a full-width paginated event table with actor, tenant, reason,
  action, correlation ID, and result; event detail opens on demand and never
  consumes permanent table width.
- **Authentication:** one environment-aware view of enabled sign-in methods,
  provider readiness, registration and verification policy, MFA/step-up,
  sessions, recovery, organization access, and enterprise identity.
- **Account Security:** the current operator's own password, TOTP, backup codes,
  passkeys, trusted devices, and session assurance; it does not configure global
  authentication policy.

Sections appear only when their capability is declared. A declared but
unconfigured capability displays sanitized status and the exact `trestle setup`
command needed to repair it.

### 11.1 Application-owned admin views

The default admin application is a starting point, not a closed Trestle-owned
dashboard. Consumers can add product-specific views by placing ordinary React
source in the application-owned admin view directory:

```text
apps/admin/src/views/contracts/
  admin-view.ts
  view.tsx
```

An admin-view descriptor registers stable route and navigation metadata while
the component remains normal application code:

```ts
export default defineAdminView({
  id: "contracts",
  path: "/contracts",
  navigation: {
    label: "Contracts",
    group: "Customers",
    order: 40,
  },
  permission: "contracts.read",
  component: () => import("./view"),
});
```

The admin application discovers descriptors at build time through a documented
file convention and composes routes and sidebar navigation from the resulting
typed registry. Adding a view must not require editing Trestle package source
or replacing the generated shell. Core Trestle views use the same registry as
application views so ordering, grouping, and rendering behavior remain
consistent.

Registry validation fails the build for duplicate identifiers or paths,
unknown permission or entitlement codes, invalid navigation groups, or missing
components. Route discovery is also exposed through machine-readable project
inspection.

Registering a view grants no backend authority. Each view declares its display
permission and optional entitlement or capability, while every API operation
continues to enforce its own server-side authorization, tenant context, and
RLS. Hiding a navigation item is usability behavior, not a security boundary.

The initial extension contract supports full views, navigation groups and
items, and overview cards. Additional detail panels, resource actions, and
table extensions should be added only through typed extension points rather
than arbitrary DOM injection or remote executable plugins.

The registry and shell are application-owned generated source. Consumers may
restyle, reorder, replace, or remove default presentation while preserving the
security and route-enforcement contracts. Trestle upgrades must not overwrite
custom views.

## 12. Customer Transparency

The customer application exposes a safe Plan and Usage view containing:

- current plan and subscription status;
- enabled product capabilities;
- limits, consumption, and reset dates;
- customer-specific contractual overrides;
- scheduled plan changes; and
- upgrade paths for unavailable features.

Product screens should explain limitations in context:

```text
18 of 25 team seats used
Included with Pro
```

The client receives a safe tenant-capability document. It does not receive
provider payloads, internal platform permissions, or sensitive policy details.
Client visibility improves usability but is never the enforcement boundary.

## 13. Domain and Persistence Boundaries

The conceptual model includes:

- protected and admin-defined permission definitions with an immutable
  organization, application, or platform plane, lifecycle, principal types,
  optional entitlement, origin, and attribution;
- discovered permission-enforcement references to routes, actions, workflows,
  and policy checks;
- organization, application, and platform role definitions;
- plane-matched role-permission relationships;
- organization memberships and organization-role assignments;
- tenant-scoped application-role assignments;
- platform-role assignments;
- service-account application-role assignments;
- service accounts with normalized per-tenant active-name uniqueness and
  deletion attribution/tombstones, plus API keys, scopes, and scope profiles;
- tenant webhook endpoints, event subscriptions, signing-secret rotation
  lineage, delivery records, attempts, replay lineage, and deletion tombstones;
- versioned notification-stream definitions, input schemas, channel routes,
  templates, preference policies, grouping/deduplication rules, and deliveries;
- versioned authentication policies and safe effective-configuration
  projections over setup-owned Better Auth/provider bindings;
- feature and privilege definitions;
- plan and plan-version definitions;
- plan entitlements;
- subscriptions and scheduled subscription changes;
- subscription entitlement overrides;
- effective-entitlement projections;
- usage aggregates and allowance periods;
- provider reconciliation records;
- access and administrative audit events; and
- sanitized capability-status projections.

Tenant-owned records use forced RLS. Platform-wide registries and operations
use explicit platform repositories and capabilities. Cross-scope database
access is never inferred from a UI route.

### 13.1 Outbound webhook lifecycle

Outbound webhooks are tenant-owned integration resources backed by the
transactional outbox. The Webhooks destination is an endpoint-management
surface as well as a delivery monitor. An authorized administrator can create,
inspect, edit, test, pause, resume, disable, rotate, and delete an endpoint, and
can replay eligible historical deliveries.

The primary creation flow is intentionally direct:

```text
New webhook -> Organization -> Name -> HTTPS endpoint URL
  -> Subscribed events -> Create webhook -> Store signing secret once
```

An optional description and custom timeout may be configured without obscuring
the required fields. Event selection is searchable and grouped by namespace;
it starts empty and supports an explicit **Select all current events** choice
that does not silently subscribe the endpoint to event types introduced later.
Endpoint names are unique among non-deleted endpoints in an organization.
Production and preview environments require HTTPS. Loopback HTTP is accepted
only in an explicitly local environment. URL validation and every delivery
block credentials in URLs, non-HTTP schemes, link-local/private/metadata
targets outside explicitly configured development allowances, unsafe redirects,
and DNS rebinding; validation at creation is not treated as permanent network
safety proof.

Creation generates a signing secret and displays it exactly once in a dedicated
result view with copy and secure-download actions. Trestle stores only encrypted
delivery material required to sign outgoing requests and never exposes the
secret again. An ambiguous retry is idempotent and cannot create a duplicate
endpoint or secret. The endpoint is not used for application deliveries until
creation commits successfully through the tenant-scoped service.

Endpoint detail uses **Overview**, **Event subscriptions**, **Deliveries**,
**Signing secret**, and **Audit** tabs. Overview supports name, description,
URL, timeout, and state changes. The delivery view shows delivery ID, event
type, attempt count, status, safe response classification, timing, correlation
ID, and next retry without exposing payloads, authorization headers, response
bodies, or secret values. **Send test** produces a clearly marked test delivery
that never masquerades as a real domain event.

Changing the URL or subscribed events shows the effect on future deliveries.
It does not rewrite historical attempts. Secret rotation returns the new secret
once and supports a bounded overlap so receivers can deploy safely; after the
overlap, the previous secret cannot verify new deliveries. Replays receive a
new delivery ID, retain `replay_of`, use the current endpoint configuration,
and are auditable.

**Delete webhook** requires the endpoint name and a reason, then atomically
disables and tombstones the endpoint. New outbox events no longer fan out to it,
and queued workers must re-check the tombstone before making a network request.
Unstarted deliveries are cancelled with an explicit terminal reason. Endpoint
metadata, prior delivery/attempt history, correlations, and audit events remain
available through **Show deleted**; signing material is destroyed after any
required retention window and is never recoverable.

Tenant administrators require `organization.webhooks.manage`; rotation and
replay retain their narrower `organization.webhooks.rotate_secret` and
`organization.webhooks.replay` permissions. In platform admin, create, edit,
rotate, and delete require an active tenant-context session that includes those
organization permissions. Cross-tenant `platform.webhooks.read`,
`platform.webhooks.disable`, and `platform.webhooks.replay` remain inspection
and emergency operations and do not imply tenant configuration authority.

### 13.2 Notification streams

The Notifications destination primarily defines notification streams; it is
not primarily a feed of messages that have already been sent. A stream is the
stable, versioned routing contract resolved by application code:

```ts
await ctx.notifications.send({
  type: "invoice.payment_failed",
  recipient: userId,
  data: { invoiceId },
});
```

The type key selects an active stream version. That version defines the input
schema and allowed recipient kinds, supported channels, channel templates,
parallel or fallback routing, default preferences, whether the message is
mandatory/transactional, and optional grouping, deduplication, delay, or digest
behavior. Provider credentials and environment bindings remain setup-owned;
stream authors choose configured channel adapters but never paste Resend or
other provider secrets into this screen.

The primary creation flow is:

```text
New stream -> Name -> Type key -> Create draft
  -> Inputs -> Channels and templates -> Preferences and policy -> Publish
```

Creating the draft requires only a name and unique immutable type key. The
editor then makes the deeper policy explicit instead of forcing it into the
first dialog. Type keys use a namespaced form such as
`invoice.payment_failed`. A published version is immutable; editing creates a
new draft, and queued notifications retain the version recorded when they were
accepted.

Each channel specifies a template and route. In-app templates define title,
body, action label/link contract, icon/category, and read behavior. Email routes
reference provider-neutral email templates with subject, HTML, and accessible
plain-text output. Future SMS, push, or other channels implement the same port
without changing the application call. Template variables must be declared by
the input schema, and publishing fails on missing variables, unavailable
providers, unsupported recipient kinds, invalid links, or an empty route.

Preference policy distinguishes:

- **user configurable**, with per-channel defaults and tenant/user overrides;
- **organization controlled**, with tenant defaults where authorized; and
- **mandatory/transactional**, which may bypass opt-out only for a documented
  product or legal reason and must not be used for marketing.

Grouping and deduplication identify keys and windows from declared input fields.
Fallback routing defines when the next channel runs, such as unavailable address
or permanent provider rejection; it does not treat an asynchronous provider
acceptance as proof a human read the message. Scheduling records the stream
version and policy snapshot so later edits cannot change queued meaning.

Before publishing, the admin can preview every channel with schema-valid sample
data and send a marked test to an explicit test recipient. Tests do not update
production preference, grouping, deduplication, unread, or analytics state.
Publishing shows a diff from the active version and warns about removed channels,
new mandatory behavior, variable/schema changes, and affected queued work.

Stream detail exposes **Overview**, **Inputs**, **Channels & routing**,
**Templates**, **Preferences**, **Test**, **Deliveries**, and **Audit**. The
global Deliveries view is retained as a secondary operational tab with redacted
recipient identity, channel states, attempts, safe failure category, scheduling,
grouping, and correlation. Rendered content, template data, provider payloads,
and private links remain hidden unless a separate content-access policy exists.

An unreferenced draft may be deleted. A stream that has ever been published is
archived rather than erased, preserving queued-delivery and audit meaning. New
sends to a missing or archived type fail with an actionable configuration error;
Trestle never silently drops them or guesses another stream. Delivery retry and
cancel remain separately authorized operational actions.

Project-wide stream definition access uses
`platform.notification_streams.read` and
`platform.notification_streams.manage`. Existing organization notification
permissions manage tenant defaults/preferences and tenant-visible history; they
do not authorize mutation of the project-wide stream contract.

### 13.3 Authentication configuration

Trestle provides one **System -> Authentication** destination for understanding
and configuring authentication. Better Auth remains the underlying owner of
identity records, credentials, protocol implementations, sessions,
organizations, and enabled plugins. Trestle owns the coherent configuration
experience, environment-specific policy, validation, lockout prevention,
authorization, audit, and setup integration. The Better Auth Admin plugin is not
a second control plane and does not replace this view.

**Account Security** remains a separate self-service page for the signed-in
operator's own password, TOTP, backup codes, passkeys, trusted devices, and
current-session assurance. It must never be presented as global authentication
configuration.

Authentication settings have two explicit ownership classes:

1. **Setup/deployment configuration** enables Better Auth plugins and providers,
   stores OAuth/SSO/SCIM credentials, configures trusted origins, callback URLs,
   cookie/domain settings, and other values required while constructing the auth
   service. The admin UI shows safe status, source, and effective value where it
   is non-secret, but directs changes through the exact `trestle setup` plan. It
   never reads an existing secret or creates a hidden second secret store.
2. **Runtime authentication policy** is versioned Trestle configuration that can
   be drafted, validated, reviewed, activated, and rolled back through admin.
   Better Auth hooks and Trestle middleware enforce the active policy; the UI is
   not itself the enforcement boundary.

The destination contains:

- **Overview:** effective posture, environment, policy version, unresolved setup
  requirements, recent changes, and lockout/recovery warnings;
- **Sign-in methods:** email/password, magic link or OTP when installed,
  passkeys, configured social/OAuth providers, and enterprise SSO connections;
- **Registration & verification:** open, invite-only, or disabled registration,
  email-verification requirements, allowed/blocked domains, account linking, and
  invitation behavior;
- **MFA & step-up:** allowed factors, user/admin requirements, enrollment grace,
  trusted-device policy, recovery policy, and assurance/freshness requirements
  for sensitive Trestle actions;
- **Sessions:** absolute and idle lifetime, rotation/revocation behavior,
  concurrent-session limits, and the effect of a policy change on existing
  sessions;
- **Organizations:** organization creation, invitation, membership, verified
  domain, and tenant-selection policy without collapsing Trestle's three
  authority planes;
- **Enterprise identity:** safe SSO/SCIM connection status and normalized
  organization binding when those capabilities are installed; and
- **Email flows:** readiness and notification-stream/template links for
  verification, reset, invitation, OTP, recovery, and security alerts.

Every effective setting shows its value, owner/source, environment, enforcement
status, and whether changing it is runtime-safe or requires a SetupPlan and
deployment. Uninstalled methods are labeled **Not configured** with the exact
setup action; they are not rendered as broken interactive controls.

Runtime edits create a draft. Review shows a semantic diff and impact including
affected users, unenrolled administrators, sessions to revoke, providers that
will disappear, required email flows, and any deployment dependency. Activation
requires `platform.authentication.manage`, a reason, recent phishing-resistant
step-up for high-risk changes, and an atomic audit/outbox event. Read access uses
`platform.authentication.read`.

The system must prevent self-lockout. It rejects activation that would remove
the last working platform-admin sign-in path, require a factor no active
break-glass administrator can satisfy, enable verification/recovery without a
healthy delivery route, or reference an unconfigured provider. High-risk
changes require another qualified administrator's approval when the deployment
declares dual control. Emergency rollback uses a previously valid policy
version, never a browser-supplied arbitrary configuration.

Policy state is environment-specific. Copying policy between environments
produces a reviewed draft and revalidates every provider and origin; production
never inherits local credentials, callback URLs, or permissive registration
settings by implication.

The permission catalog is project-wide platform state. Tenants may read the
active definitions needed to build their same-plane roles but cannot mutate the
catalog. Admin-defined permission rows cannot shadow protected codes; startup,
deployment, and Doctor fail on conflicting plane or semantic definitions.

Mutations emit versioned domain events and append required outbox records in
the same PostgreSQL transaction. Cache invalidation and asynchronous provider
work derive from committed events.

## 14. Audit and Observability

Administrative and access events use semantic, versioned names and carry a
correlation identifier. Sensitive operations record actor, principal type,
tenant, target, reason, before/after safe summaries, outcome, and environment.

Required audited operations include:

- organization-, application-, and platform-role assignment;
- permission and role-definition changes;
- tenant-context entry;
- plan activation, retirement, and subscription migration;
- entitlement override creation and removal;
- service-account creation or suspension;
- API-key minting, rotation, and revocation;
- webhook creation, configuration, testing, secret rotation, replay, disable,
  and deletion;
- notification-stream creation, version publication, testing, archival, and
  policy/template changes;
- authentication-policy draft, activation, rollback, provider/method changes,
  assurance changes, and session-impact decisions;
- provider reconciliation;
- session revocation;
- queue, DLQ, and Workflow recovery; and
- destructive or bulk administrative actions.

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
6. Cross-tenant and platform operations require dedicated platform
   capabilities.
7. Admin UI visibility never substitutes for server-side authorization.
8. Every permission is assigned to exactly one immutable authority plane;
   protected source definitions and audited admin-defined definitions resolve
   through one catalog, and assignments never substitute for enforcement.
9. Entitlements never grant actor permissions in any plane.
10. Roles and scopes never grant product entitlements.
11. API-key scopes never exceed service-account authority in the required
    plane.
12. Revoked or expired sessions and keys fail closed.
13. Provider outages do not silently grant capabilities.
14. Secrets and complete credentials are never readable through admin.
15. SetupPlan files contain secret requirements, not secret values.
16. Destructive and bulk actions preview scope, use idempotency where
    applicable, and report partial failure.
17. Sensitive platform actions require an explicit reason and support step-up
    authentication.
18. All provider webhooks require signature verification and idempotent
    processing before updating authoritative projections.
19. Authentication policy cannot be activated when it would remove every viable
    platform-admin sign-in or recovery path.

## 16. CLI, Generators, and Inspection

The intended command surface includes:

```bash
trestle setup
trestle admin install
trestle generate admin-resource Article
trestle generate admin-view Contracts
trestle generate permission workflows.publish --plane application
trestle permissions
trestle roles --plane organization
trestle roles --plane application
trestle roles --plane platform
trestle entitlements
trestle api-keys doctor
trestle admin doctor
```

Exact commands ship only when present in installed `trestle --help`.

Machine-readable project inspection includes applications, capabilities,
permissions with their authority planes, role definitions and assignments,
route enforcement, feature definitions, plans, admin views and navigation,
events, bindings, and environment verification without disclosing secrets or
customer-sensitive values.

Generated source remains application-owned. Applying a SetupPlan may restore
missing scaffold registrations but does not overwrite customized domain or UI
code.

## 17. Verification

The subsystem requires unit, integration, PostgreSQL, browser, and deployed
system evidence.

At minimum, tests prove:

- organization and application administrators cannot escape their tenant;
- a user with no assignments has no organization, application, or platform
  authority;
- organization Owner authority does not grant application or platform
  permissions;
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
- route metadata and enforcement do not drift;
- unsubscribed tenants cannot use entitled features;
- plan-version and subscription overrides produce explainable results;
- stale or invalid provider events do not grant entitlements;
- local, Stripe, and Lago adapters normalize equivalent commercial state;
- setup never persists or logs plaintext credentials;
- admin reports missing configuration and points to `trestle setup`;
- authentication configuration reports one effective environment-specific
  posture with explicit value ownership, rejects unsafe or unconfigured policy,
  prevents administrator lockout, and proves Better Auth enforcement matches the
  active Trestle policy version;
- notification sends resolve an active immutable stream version, reject invalid
  inputs and missing/archived stream keys, honor preference and mandatory policy,
  validate template variables, and preserve the recorded version through queued
  delivery;
- a dropped-in application admin view is discovered, routed, placed in the
  sidebar, permission-filtered, and preserved by later generation or apply;
- duplicate or invalid admin-view descriptors fail at build time;
- admin actions preserve validation, audit, events, and RLS; and
- cross-tenant and cross-environment cache state is not reused.

## 18. Delivery Sequence

This subsystem should ship in evidence-driven slices:

1. **Setup console foundation:** capability wizard, encrypted credential input,
   plan diff, apply, and Doctor integration.
2. **Admin foundation:** separate application, platform authentication,
   unified authentication configuration, operator Account Security, capability
   health, tenant-context entry, audit, and safe search.
3. **Authorization:** the permission registry, independent organization,
   application, and platform roles, enforcement discovery, and effective-access
   explanation.
4. **Commercial control plane:** feature catalog, versioned plans,
   subscriptions, effective entitlements, overrides, customer transparency,
   and Stripe/local reconciliation.
5. **Machine access:** service accounts, scope profiles, API-key minting,
   rotation, revocation, and usage history.
6. **Operational depth:** email, async, artifact, recovery, and Lago adapter
   views and actions.
7. **Beta hardening:** adversarial browser and deployed-system tests, upgrade
   compatibility, recovery rehearsal, and production evidence.

## 19. Acceptance Criteria

The administration and access-control system is beta-ready when a clean
generated application can, without manual source repair:

1. run `trestle setup`, select capabilities, enter environment credentials,
   review a SetupPlan diff, apply it, and pass Doctor checks;
2. deploy public, customer, admin, and Worker surfaces with distinct origins
   and policies;
3. show absent or unhealthy capabilities in admin without accepting secrets or
   failing unsafely;
4. inspect one effective authentication configuration, distinguish setup-owned
   provider settings from runtime policy, configure and activate a safe sign-in,
   verification, MFA/step-up, session, and recovery policy, prove Better Auth
   enforces it, reject a change that would lock out platform administrators, and
   roll back to the prior valid version without exposing provider credentials;
5. add a custom permission through admin, show its initially unenforced state,
   discover a real enforcement point, create a tenant-scoped role with a
   description and same-plane permission selection, assign it to the valid
   human or machine principals, prove authority does not flow between planes,
   and explain effective access;
6. create a new plan from the admin UI by entering only its name, edit its
   typed features, activate it, map its offer to the correct Stripe Product and
   Price, subscribe a tenant, verify the Customer/Subscription/Item linkage,
   inspect both included and unavailable features with their provenance and
   usage, compare a proposed change without mutation, apply an audited override,
   and explain effective entitlements;
7. present the same safe plan, usage, and entitlement truth in the customer
   application;
8. create and inspect a service account, edit its description and application
   roles, verify its effective permissions, use the API Keys destination to
   select that account and mint a named one-time key with constrained scopes,
   authorize a scoped route, inspect safe usage, rotate and revoke the key,
   prove the old key stops working, then delete the account and prove every
   credential stops working while its audit history remains available;
9. prove API scopes cannot exceed the service account, tenant entitlement,
   endpoint policy, environment, or RLS boundary;
10. create a named webhook endpoint with selected events, capture its signing
   secret once, emit and inspect a transactionally queued delivery, test it,
   rotate the secret, replay an eligible delivery, edit and disable the
   endpoint, then delete it and prove no queued worker sends again while safe
   delivery and audit history remain available;
11. create and publish a notification stream with a typed input contract,
    in-app and email routes, templates, preference policy, and deduplication;
    send it through `ctx.notifications.send`, verify the recorded stream version
    and channel outcomes, test a draft safely, publish an edited version, archive
    the stream, and prove new sends fail visibly while historical deliveries
    remain inspectable;
12. reconcile local and provider commercial state without authorizing directly
   from provider responses;
13. reconstruct every sensitive administrative change through redacted,
    correlated audit evidence; and
14. add an application-owned admin view through the documented file convention,
    see it in the default left sidebar, enforce its registered permission on
    the server, and retain it unchanged through a subsequent SetupPlan apply.
