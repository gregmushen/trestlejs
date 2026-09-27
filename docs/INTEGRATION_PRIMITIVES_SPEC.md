# TrestleJS Integration Primitives Specification

**Status:** Draft v0.1 — design only

**Scope:** Tenant-owned connections to external systems, typed triggers and
actions, durable execution, reconciliation, and provider conformance.

**Parent specification:** [TrestleJS Specification](TRESTLEJS_SPEC.md)

**Related specifications:** [Administration and Access Control](ADMIN_SPEC.md),
[Proof-Oriented Engineering](PROOF_ORIENTED_ENGINEERING_SPEC.md)

## 1. Purpose

TrestleJS already defines provider adapters, inbound webhook boundaries,
application events, transactional outbox, Queues, Workflows, secrets,
organization tenancy, permissions, entitlements, audit, setup, and Doctor.
Generated applications need a stable way to combine those pieces when a
customer connects an external account.

This specification defines that combination around four application concepts:

```text
Connection   an organization's relationship with an external account
Trigger      a provider occurrence normalized for the application
Action       a typed application intent sent to a provider
Execution    a durable request and result for one action
```

An integration exposes capabilities. Application code expresses an action or
reacts to a normalized trigger. The runtime handles credentials, tenant
resolution, provider APIs, retries, rate limits, and reconciliation.

The scope is deliberately smaller than an automation product. Future code
workflows, visual builders, AI-authored workflows, MCP tools, and marketplaces
may compose these primitives without replacing their identity or ownership
model.

This is a future capability specification. The present repository has
deployment-level email and payments adapters under `packages/integrations/`,
but it does not yet implement the full tenant-owned Connection/Execution
model described here.

## 2. Goals

1. Define application-owned integration capabilities in typed source.
2. Make every customer connection belong to one organization, environment,
   integration, and selected provider.
3. Keep credentials out of domain code and normal read models.
4. Normalize provider occurrences into authenticated, deduplicated trigger
   records and application events or domain commands.
5. Persist an action Execution before external side effects occur.
6. Make retries and ambiguous outcomes obey declared idempotency semantics.
7. Reuse Trestle's outbox, Queue, Workflow, logging, audit, and forced RLS.
8. Make provider capability differences explicit to the application and UI.
9. Provide customer connection management and exception-oriented platform
   operations.
10. Support deterministic local behavior and provider conformance proof.
11. Permit new adapters without inventing new tenant, credential, execution,
    recovery, or release-evidence models.

## 3. Non-goals and scope boundaries

This specification does not build a visual workflow editor, Zapier-style
automation, generic ETL, universal object mapping, a marketplace, remote
executable plugins, arbitrary customer scripting, or dozens of adapters.

Not every external service use requires a tenant Connection. The existing
Resend email and Stripe billing adapters can remain deployment-level services
when the platform owns one account and tenants do not connect their own
provider accounts. Their established contracts and payment projections do not
need to be rewritten as generic Actions merely to fit this model. A tenant-
connected Stripe account, if ever supported, would be a separate design.

Outbound customer webhooks are delivery of application-owned public events to
customer endpoints. They are not integration Actions. Inbound webhooks are one
transport for provider Triggers; a webhook route alone is not a Connection.

## 4. Governing principles

1. Application semantics are stable above provider mechanics.
2. Definitions live in ordinary application-owned TypeScript source.
3. PostgreSQL is canonical for Connection intent, Execution state, and
   normalized projections; providers are authoritative only for facts about
   their own external resources.
4. A client-selected organization or provider-returned value is never tenant
   authority.
5. Tenant-owned integration records use `withTenant()` and forced PostgreSQL
   RLS.
6. Credentials are write-only inputs and are resolved only inside a narrow
   integration runtime capability.
7. A domain mutation, action request, event, and outbox record commit together
   when the action depends on the mutation. The provider call follows commit.
8. Queue payloads carry resource IDs, not credentials or tenant authority.
9. An external provider outage cannot roll back a committed domain mutation.
10. Entitlement allows a tenant capability; permission authorizes a principal;
    provider scope allows an external API operation. All three are checked
    separately.
11. Provider responses do not directly grant application roles, permissions,
    or entitlements.
12. Recovery is bounded, idempotent where possible, and audited.

## 5. Domain vocabulary and ownership

| Object | Owner and authority | Purpose |
| --- | --- | --- |
| `IntegrationDefinition` | Application source | Stable application capability, actions, triggers, documentation, and supported adapters. |
| `ProviderAdapter` | Application integration package | External protocol, API, scopes, errors, and capability translation. |
| `Connection` | One organization and environment | Configured external account relationship and desired state. |
| `AuthenticationStrategy` | Definition/adapter configuration | Method and lifecycle for obtaining provider credentials. |
| `TriggerDefinition` | Application source | Normalization of an external occurrence into application semantics. |
| `ActionDefinition` | Application source | Typed provider-facing intent and result contract. |
| `Execution` | Tenant-owned PostgreSQL record | Durable action request, progress, and final normalized result. |
| `Attempt` | Tenant-owned PostgreSQL record | One provider invocation and its safe operational outcome. |
| `ProviderEvent` | Tenant-owned ingress record | Authenticated provider occurrence before normalization. |
| `ProviderBinding` | Tenant-owned PostgreSQL record | Safe mapping from local objects to provider IDs. |
| `ReconciliationRun` | Tenant-owned or explicit platform operation | Comparison, drift, and controlled repair. |

Provider IDs are references. They are not Trestle Connection, Execution,
resource, or tenant IDs.

## 6. Integration definitions

An `IntegrationDefinition` describes a capability, not a configured customer
account. It has a stable ID, version, display metadata, authentication choices,
typed actions, typed triggers, capability requirements, and supported provider
adapters. It contains no customer credentials or runtime state.

One possible application-owned shape is:

```ts
export const crm = defineIntegration({
  id: "crm",
  version: 1,
  name: "Customer CRM",
  description: "Connect customer records to a CRM account.",
  providers: [hubspotAdapter],
  actions: {
    "contacts.create": defineAction({
      input: createContactInput,
      output: createdContactResult,
      permission: "customers.export",
      requiredCapabilities: ["contacts.write"],
      idempotency: "provider_idempotent",
    }),
  },
  triggers: {
    "contacts.changed": defineTrigger({
      output: changedContactEvent,
      requiredCapabilities: ["contacts.read"],
    }),
  },
});
```

This is a design sketch, not a commitment to exact function names. It follows
Trestle's source-derived, Zod-at-runtime convention. Provider-specific
capabilities and account requirements remain inside adapters. A provider-
neutral Action should be offered only when its meaning and output contract can
actually be honored by every declared adapter. The application may define a
provider-specific integration when equivalence would be misleading.

Build-time discovery validates duplicate IDs, unknown permissions or
entitlements, invalid schemas/examples, unsupported authentication modes,
adapter action coverage, missing local behavior, and version compatibility.
The registry is inspectable through versioned project metadata. An admin or
customer UI can read safe metadata, never executable source or credentials.

## 7. Connection

A `Connection` binds exactly one organization, environment,
`IntegrationDefinition`, and provider choice to one identified external
account. A tenant may have several connections of the same integration if
allowed by the definition and entitlement.

Required fields:

```text
connection ID
organization ID
environment
integration ID and definition version
provider key and adapter version
provider account ID and safe display name
authentication strategy
credential reference and granted scopes/capabilities
desired state and observed health
created/connected/updated/revoked times
creating and last-changing principals
provider binding and last reconciliation
```

No provider token or API key appears in a Connection read model. The safe
account ID may be shown only if the provider permits it and it cannot serve
as a credential.

### 7.1 Connection lifecycle

```text
disconnected → authorizing → connected → degraded
                      │           │          │
                      ▼           ▼          ▼
                disconnected  reauthorization_required
                      │           │          │
                      └──── reconnect ───────┘

connected / degraded / reauthorization_required → revoked
```

`disconnected` means no active provider relationship. `authorizing` is a
short-lived server-issued connection attempt, not usable authority.
An authorization failure returns the Connection to `disconnected` and records
the failed attempt separately.
`connected` means credentials and required capabilities are present; it does
not prove every provider API is healthy. `degraded` means operation continues
with observed failures or reduced capability. `reauthorization_required`
means credentials or scopes no longer meet the definition. `revoked` is
terminal for the current credential generation; reconnect creates a new
generation, even if the UI preserves the logical Connection ID.

Revocation prevents new executions immediately. In-flight work rechecks the
current Connection generation and state before each external attempt. A
provider-side revocation discovered later transitions local state to
`reauthorization_required` or `revoked` according to the evidence.
If provider-side token revocation fails, Trestle still revokes local use and
records the external cleanup as pending reconciliation.

### 7.2 Desired state and observed state

The Connection's locally authorized configuration is desired state. Provider
account identity, granted scopes, subscription status, and external object
state are observations. A provider callback may update observations only
after authentication, binding, validation, and idempotency checks. It cannot
silently edit desired state or an authoritative application record.

## 8. Authentication strategies and credentials

The strategy interface supports at least `oauth2`, `api_key`, `bearer`,
`basic`, `service_account`, and a narrowly declared `custom` strategy.
Strategies declare their required setup secrets, connection-time inputs,
credential refresh behavior, scope representation, and revocation support.
`custom` does not mean arbitrary tenant code executed by the platform.

Provider credentials are held by the selected connection backend (§8.3):
either the existing encrypted, environment-bound secret system, an
integration credential vault built on the same invariants, or an external
backend such as Nango. The Connection stores only a reference and safe
fingerprint/status. Only the
adapter invocation path receives a short-lived credential capability. Domain
services, GraphQL/HTTP handlers, admin views, Queue messages, audit summaries,
and logs cannot read the value.

Credential replacement increments a generation. Workers must re-read the
current generation before attempting external work. Rotation and revocation
are audited, but secret material is never recorded in the audit event.

### 8.1 OAuth 2 lifecycle

OAuth connection establishment must:

1. Verify the initiating principal's current organization authority and the
   integration entitlement.
2. Create a durable, single-use authorization attempt bound to organization,
   environment, integration, provider, initiating principal/session, requested
   scopes, redirect URI, and expiration.
3. Generate unpredictable `state`; use PKCE where applicable; bind nonce and
   code verifier to the attempt.
4. Use an allowlisted exact redirect URI and provider authorization endpoint.
5. On callback, verify `state` once, expiration, session/initiator policy,
   environment, provider, redirect URI, and requested Connection generation.
6. Exchange the code server-side; never expose tokens to the browser.
7. Fetch and validate provider account identity and granted scopes.
8. Persist credential reference, provider binding, Connection state, and audit
   result atomically where local state is concerned.
9. Fail closed on mismatched account, missing required scopes, replayed state,
   unexpected environment, or token-exchange failure.

Provider-returned `state`, organization hints, account IDs, and scopes are
data to verify against the durable Trestle attempt. They do not establish
tenant authority. A changed provider account requires explicit reconnect or
replacement confirmation; it is not silently rebound to an existing
Connection.

Access-token refresh is serialized per Connection generation so concurrent
workers do not overwrite a rotated refresh token. Refresh failure, revoked
grant, or lost scope transitions the Connection to
`reauthorization_required` and stops actions requiring that scope.

### 8.2 Non-OAuth strategies

API-key, bearer, and basic credentials are entered through a write-only
customer flow and verified with a safe provider identity/capability check
where possible. Service-account credentials may involve a signed assertion
or provider-managed key and follow the same environment, rotation, and
write-only rules. If a provider cannot verify account identity without a
side effect, the UI states that limitation and the first safe action or
reconciliation supplies observed evidence.

### 8.3 Connection backends

Credential custody, the provider authorization flow, token refresh, and
authenticated provider requests sit behind a `ConnectionBackend` adapter.
It is selected per environment and follows the job runtime pattern: a
registered adapter, an explicit environment selection, and fail-closed
resolution when the selection is unknown or unconfigured.

```text
TRESTLE_CONNECTION_BACKEND = none | nango    (default: none)
```

`none` disables tenant Connections. A future `native` backend would implement
§8.1 and §8.2 directly against Trestle's own credential vault. **Nango is the
first backend.** It lets the initial releases deliver Connections without
Trestle building OAuth client handling, token storage, or refresh for each
provider.

A backend implements:

```text
describe(environment)            configured state and safe detail for Doctor/admin
createAuthorizationSession(...)  short-lived session for the customer connect UI
completeAuthorization(...)       verify and bind a backend-reported connection
proxy(connectionRef, request)    authenticated provider call; credential never returned
inspect(connectionRef)           provider account identity and granted scopes
revoke(connectionRef)            delete provider-side credentials
verifyInbound(rawBody, headers)  authenticate backend-originated callbacks
```

**Bring your own account.** The application developer supplies their own
Nango account. `NANGO_SECRET_KEY` is the only required secret. `NANGO_HOST`
is optional and needed only for a self-hosted instance. Each Trestle
environment maps to a distinct Nango environment and its own key, and Doctor
rejects reuse of one key across environments. Trestle never provisions,
resells, or operates Nango on the developer's behalf. The key is a
deployment secret managed by `trestle secrets` and never reaches the
browser. The customer connect UI receives only a short-lived connect session
token minted server-side.

With the Nango backend:

1. Nango holds provider tokens. The Connection's credential reference is the
   pair (Nango integration key, Nango connection ID). No provider token is
   stored in Trestle or passed to adapter code.
2. Trestle still owns the Connection, its tenant binding, lifecycle state,
   generation, entitlement and permission checks, and audit. §8.1 steps 1, 2,
   5, 7, 8 and 9 still apply. The durable authorization attempt binds a Nango
   connect session instead of Trestle-generated `state` and PKCE values.
   Nango's hosted flow performs the code exchange (steps 3, 4 and 6).
3. Nango's connection-created callback is authenticated with Nango's webhook
   signature and then resolved against the durable Trestle attempt. End-user
   or organization tags reported by Nango are data to verify. They never
   establish tenant authority.
4. Adapters make provider calls through `proxy`. The narrow credential
   capability from §8 is the connection reference, which is usable only
   through the backend's proxy.
5. Nango serializes token refresh. A refresh failure reported by Nango, or a
   provider 401 through the proxy, moves the Connection to
   `reauthorization_required`.
6. Disconnect revokes the Trestle Connection first, then deletes the Nango
   connection. If the Nango deletion fails, it is recorded as pending
   reconciliation (§7.1).

**Deployment and licensing constraints.** Nango is source-available under
the Elastic License 2.0, not an OSI open-source license. Trestle integrates
with a developer's Nango instance and does not redistribute Nango as a
hosted service, so the license's managed-service restriction does not reach
Trestle. Feature availability depends on how the developer runs Nango:

| Nango deployment | Available to Trestle |
| --- | --- |
| Nango Cloud (free or paid plan) | Auth, proxy, provider webhook forwarding, syncs |
| Free self-hosted | Auth and proxy only |
| Enterprise self-hosted | Auth, proxy, provider webhook forwarding, syncs |

The Nango backend therefore requires only auth and proxy. Provider webhook
forwarding through Nango is an optional trigger transport (§9) that Doctor
reports as available or unavailable. Nango syncs are out of scope for this
specification. These plan facts are external and may change, so Doctor and
the documentation cite the Nango plan in use rather than hard-coding
assumptions.

The backend is experimental until it passes the conformance proof in §23. It
is enabled with `trestle integrations use nango --experimental` (proposed),
which writes an `integrations:` block to `.trestle/project.yaml` and declares
the required secret names.

## 9. Trigger definitions and inbound transport

A `TriggerDefinition` describes the semantic occurrence the application
recognizes: stable trigger ID, versioned input and normalized output schemas,
source binding, deduplication identity, event-time rules, sensitivity, and
documentation. It does not prescribe webhook transport.

Supported transport adapters may later include signed inbound webhook,
polling, scheduled synchronization, change feed, event stream, long polling,
or broker consumer. The initial slice needs one real transport and one
deterministic local transport, not every transport.

When the connection backend forwards provider webhooks (for example, Nango
Cloud; see §8.3), the backend's inbound route authenticates the backend's
signature and then follows the same processing sequence below. Tenant
resolution still comes from the persisted Connection bound to the backend
connection reference, never from forwarded payload fields. A direct,
provider-signed webhook route remains a valid alternative transport when the
backend cannot forward.

Inbound processing is:

```text
raw provider occurrence
→ authenticate transport and preserve raw bytes where signatures require them
→ resolve a known provider binding and active Connection
→ validate tenant and environment from persisted state
→ persist provider-event deduplication record
→ acknowledge according to transport contract
→ normalize and validate trigger output
→ commit application domain change/event/outbox as required
```

An unknown account, unbound event, invalid signature, revoked Connection, or
cross-environment event is quarantined or rejected. It never guesses a tenant
from a payload field. Duplicates use a stable provider event ID or a declared
content/time key, not HTTP arrival identity. Out-of-order occurrences are
handled by trigger-specific version or freshness policy; arrival order is not
assumed to represent source order.

Trigger normalization may emit a typed application event or request a domain
operation. A provider occurrence itself is evidence about the provider; it
is not automatically an authoritative Trestle domain fact. Any resulting
domain mutation and application event use the normal PostgreSQL transaction
and outbox invariant.

## 10. Action definitions

An `ActionDefinition` declares:

- stable action ID and version;
- Zod input and normalized output schemas;
- safe descriptions and examples;
- required Connection and provider capabilities/scopes;
- application permission for a human or service-account caller;
- optional entitlement;
- idempotency class;
- timeout and retry classification bounds;
- sensitivity and retention class;
- whether the action is read-only, externally mutating, or compensatable;
- provider mapping and result normalization.

An Action describes an application intent such as `contacts.create`. It does
not expose a provider URL, HTTP verb, rate-limit header, token, or raw SDK
response to domain code.

Action versions are explicit. Breaking input or output semantics require a
new version or a reviewed migration. Provider adapter versions may change
without changing an Action's public contract when conformance still holds.

## 11. Durable action execution

An `Execution` is the authoritative record of one requested Action. Its
input is validated and stored under the tenant's sensitivity and retention
policy. It records a stable idempotency key, requesting principal, Connection
generation, definition/action versions, correlation and causation IDs,
attempts, normalized result or failure, and timestamps.

Suggested states:

```text
requested → queued → running → succeeded
                      ├────────→ retry_scheduled → running
                      ├────────→ outcome_unknown
                      ├────────→ failed
                      └────────→ cancelled
```

`outcome_unknown` means a provider side effect may have occurred but Trestle
cannot safely determine the result. It is not treated as a routine retryable
failure.

### 11.1 Request API

The application-facing happy path is conceptually:

```ts
const execution = await ctx.integrations.execute({
  connection: connectionId,
  action: "contacts.create",
  input: { customerId },
  idempotencyKey: `customer:${customerId}:crm-contact:v1`,
});
```

`execute` validates authority and persists the Execution request. It returns
an Execution receipt, not a claim that the provider action already succeeded.
The caller can inspect the result later, subscribe to an application event,
or coordinate a dependent step through a Workflow. The runtime does not
secretly switch between durable and direct provider calls depending on the
caller.

When the action follows a domain mutation, the mutation, Execution request,
application event, and outbox record are written in the same transaction.
The provider invocation begins after commit. For a standalone user request,
creation of the Execution and outbox work is itself the local transaction.
Domain code does not call the external provider inside a database transaction.

### 11.2 Async mechanism

The existing outbox dispatcher publishes a stable Execution ID. Queue
consumers resolve the canonical Execution, Connection, tenant, and authority
from PostgreSQL. They never trust an organization ID supplied by a Queue
payload. A short action uses Queue attempts and database leases. A Workflow
is used when the action requires durable multi-step progression, long waits,
or compensation. Workflow IDs remain mechanisms; the Execution ID remains
the queryable semantic identity.

An outbox publish/mark race may enqueue duplicate work. Leases and stable
idempotency keys make duplicate consumption safe within the action's declared
idempotency class.

### 11.3 Attempt

Each external invocation appends an Attempt with attempt number, start/end,
safe HTTP status, provider request ID, duration, rate-limit reset or
retry-after, failure category, retry decision, and sanitized diagnostics.
Attempts do not store unrestricted request/response bodies, tokens, or
Authorization headers. Large safe diagnostics, if retained, use R2 with
explicit access and retention policy.

## 12. Idempotency and ambiguous outcomes

Every Action declares one of:

| Class | Safe behavior |
| --- | --- |
| `provider_idempotent` | Derive a stable provider idempotency key from Execution identity; retry within provider contract. |
| `trestle_deduplicated` | Suppress duplicate local requests; retry only when provider outcome can be resolved safely. |
| `non_idempotent` | Never retry after an ambiguous send without reconciliation or explicit operator decision. |
| `unknown` | Fail closed for automatic post-send retry until semantics are specified. |

A timeout after request transmission is ambiguous. For an idempotent provider,
retry with the same key. For a non-idempotent provider, transition to
`outcome_unknown`, query by stable external reference if possible, and
reconcile. Do not turn a network timeout into a duplicate contact, charge,
or message by blindly replaying it.

The local Execution uniqueness constraint covers organization, Connection,
action, and caller-supplied logical idempotency key. A key collision with a
different input hash is a conflict, not reuse of the prior result.

## 13. Retry, rate limits, and backpressure

Adapters normalize provider errors into at least validation/permanent,
authentication, authorization/scope, rate-limited, transient, unavailable,
and ambiguous categories. They may retain safe provider codes for diagnosis.

Automatic retries use bounded exponential backoff with jitter, provider
`Retry-After` where valid, a maximum elapsed window, and a maximum attempt
count. Authentication failures may trigger one serialized refresh followed
by a retry when the strategy allows it. Validation, missing scope, revoked
Connection, and known permanent errors do not retry automatically.

The scheduler enforces limits at global, provider, tenant, and Connection
levels with bounded concurrency and fair allocation. One noisy tenant or
provider account must not consume the entire worker pool. Rate limiting is
operational state, not an authorization grant. Backpressure keeps durable
Executions pending, reports oldest age and backlog, and never drops a
committed request silently.

If a provider is unavailable, domain commits continue. Executions remain
queued, retrying, or `outcome_unknown` according to the action policy. The
admin view groups a shared provider outage instead of producing thousands of
independent tenant incidents.

## 14. Provider adapter contract

An adapter translates between application definitions and one provider. It
may know provider URLs, account identifiers, scopes, OAuth details,
pagination, signature formats, webhook subscriptions, request IDs, rate
limits, errors, and API versions. Application domain packages do not import
the provider SDK.

An adapter contract includes:

```text
identity and capability discovery
authentication initiation/exchange/refresh/revoke as applicable
account and granted-scope inspection
action execution and normalized result
trigger verification and normalization
provider object binding and lookup
reconciliation observation and proposed repair
safe health check and diagnostics
deterministic local fixture behavior
```

Adapters need implement only capabilities declared for that provider. The
definition validator prevents exposing an Action or Trigger that the selected
adapter cannot honor. Adapter calls receive a narrow credential capability
and scoped execution context; they cannot grant themselves tenant or platform
authority. Network requests use provider-declared hosts and TLS policy. Any
supported customer-supplied destination must require HTTPS outside local
development, reject private/link-local/metadata addresses, revalidate DNS at
use time, and never follow redirects to an unvalidated host.

### 14.1 Provider capabilities

Typed metadata may declare `webhooks`, `polling`, `incremental_sync`,
`oauth`, `refresh_tokens`, `idempotency_keys`, `bulk_api`, `sandbox`,
`reconciliation`, `pagination`, and advanced authentication as applicable.
Account-tier limitations and currently granted scopes are observed per
Connection.

The effective operation requires all of:

```text
application definition
∩ Trestle entitlement
∩ caller permission
∩ provider adapter capability
∩ provider account capability and granted scope
∩ healthy, active Connection
```

The UI reports which check failed. A provider limitation must not appear as
a Trestle permission denial, and a product entitlement must not appear as a
provider outage.

## 15. Reconciliation

Reconciliation is a first-class operation even when the first adapter has a
small read-only implementation. It compares Trestle's normalized projection
and desired configuration with provider observations, then records:

```text
in_sync
drift_detected
repair_proposed
repairing
repaired
manual_review
failed
```

A run records Connection, provider, scope, time window, observed provider
cursor/version, differences, safe proposed changes, applied changes, actor,
reason, and result. Pagination and provider rate limits must be bounded.

Automatic repair is allowed only for an explicitly declared idempotent
operation with known ownership and no expansion of authority. Manual review
is required for unknown external objects, ambiguous account identity,
unexpected scope changes, conflicting application state, irreversible
provider changes, or repair that could duplicate a non-idempotent action.

Reconciliation may update a normalized provider projection, but it cannot
silently overwrite authoritative domain state. Any domain correction runs
through a domain service and emits its normal event, outbox, and audit
records. Reconciliation is also the recovery path for missed provider
webhooks and ambiguous action outcomes.

## 16. Persistence model

Tenant-owned PostgreSQL records use forced RLS and the real application role:

- `integration_connection` — desired state, observed health, identity,
  definition/adapter versions, credential reference, generation, attribution.
- `integration_authorization_attempt` — short-lived OAuth state, PKCE
  reference, tenant/environment binding, single-use status.
- `integration_provider_event` — authenticated ingress identity, safe metadata,
  deduplication and normalization status.
- `integration_execution` — durable Action request, input reference/hash,
  idempotency, state, result, failure, correlation.
- `integration_attempt` — append-only operational attempts.
- `integration_provider_binding` — local-to-provider resource identity.
- `integration_reconciliation_run` and `integration_reconciliation_item` —
  observations, drift, review, repair, and progress.
- `integration_usage` — aggregate volume, quota, and throughput accounting
  where commercial limits are enabled.

With an external connection backend, `integration_connection` stores the
backend name and backend connection reference in place of a Trestle
credential reference, and `integration_authorization_attempt` stores the
backend session reference in place of PKCE material.

Credentials are not columns of ordinary tenant read models. Sensitive Action
input and result data have schema-specific redaction and retention. Large
payloads use R2 references rather than unbounded PostgreSQL JSON. Foreign
keys, unique idempotency constraints, Connection generation checks, and
versioned schemas enforce state transitions where practical.

Platform-wide definition metadata is derived from source. Cross-tenant
operations use explicit platform repositories and permissions; they do not
relax tenant-table RLS.

## 17. Authorization and entitlements

Connection administration belongs to the organization authority plane:

```text
organization.integrations.read
organization.integrations.manage
organization.integrations.credentials.rotate
organization.integrations.disconnect
```

Action invocation uses the declared application permission, scoped to the
Connection's organization. A service account may invoke an Action only
through its application role and an API-key scope that reduces, never
creates, that authority. Trigger transport executes as a narrow system
principal and cannot acquire a human's role from provider payload data.

Platform operations use separate permissions:

```text
platform.integrations.read
platform.integrations.reconcile
platform.integrations.recover
platform.integrations.disable
```

Selecting a tenant gives a platform operator no tenant Connection authority.
Routine configuration changes use an authorized support-context session;
emergency platform actions require their own permission, reason, and audit.

Optional typed entitlements may include integrations enabled, allowed
integration/provider IDs, maximum Connections, allowed Actions, monthly
Executions, throughput, retention, and reconciliation frequency. They limit
tenant capability and do not grant actor permission. An over-limit Action
request fails before Execution creation when it is a new standalone request;
an action already committed with a domain mutation remains durably recorded
and enters a visible blocked state rather than disappearing or rolling back
the domain change.

## 18. Customer application UX

The customer application provides **Settings → Integrations**.

The overview has Available and Connected views. It shows each integration's
purpose, supported Actions and Triggers, provider availability, required
scopes, entitlement status, and setup state. A Connection list shows safe
provider account identity, status, health, connected-by identity, granted
scopes, last success, recent failures, and last reconciliation.

The connection flow explains requested external access before redirect or
credential entry. It verifies the resulting provider account and scopes,
then shows success or an actionable failure. Connection detail supports
reconnect, credential replacement, disconnect, recent Executions, trigger
activity, and permitted reconciliation. Stored credentials are never readable.

Customers see application terms and meaningful outcomes. They do not need
to know Queue IDs, Workflow instances, provider token internals, outbox rows,
or raw provider errors. When a provider lacks an Action, the UI says so
distinctly from plan or permission restrictions.

## 19. Platform admin UX

The generated admin application adds an exception-oriented **Integrations**
area when the capability is declared:

```text
Integrations
├── Connections
├── Executions
├── Failures
└── Reconciliation
```

Overview cards show connected/degraded/reauthorization-required counts,
provider health, oldest pending Execution, rate-limit backlog, ambiguous
outcomes, trigger-ingress failures, and reconciliation drift. Healthy
Connections recede; provider-wide incidents aggregate.

Operators can find a tenant, Connection, Execution, Attempt, provider
request ID, or correlation ID; trace domain action → outbox → Execution →
Attempt → provider response; inspect sanitized metadata; and preview
bounded recovery. The admin UI never shows tokens or unrestricted provider
payloads.

Platform recovery, forced disconnect, or write reconciliation requires
specific permission, recent step-up authentication, scope preview, and an
audit reason. A support-context session is required for routine tenant
Connection management. The admin app does not edit application-owned
IntegrationDefinitions or infrastructure SetupPlans.

## 20. Setup and capability lifecycle

The optional integration runtime follows:

```text
disabled → declared → configured → deployed → verified
```

Disabled omits unused routes, navigation, bindings, secrets, and runtime
requirements. Declared means SetupPlan and manifest name the capability and
approved provider adapters. Configured means source, bindings, redirect
origins, secret names, and required migrations are present. Deployed means
the environment reports expected resources. Verified means Doctor and a
safe environment-appropriate connection/adapter check pass.

SetupPlan records integration and provider intent, environment, required
secret names, redirect origins, paid external-resource intent, and
verification commands. It never contains plaintext platform OAuth client
secrets or tenant tokens. Tenant Connections are created at runtime in the
customer application; setup cannot pre-authorize them merely by naming a
provider.

`trestle doctor` reports definition validity, adapter coverage, migration
and RLS status, redirect URI alignment, required secret presence, Queue and
outbox bindings, callback route configuration, provider environment
separation, local fixture availability, and sanitized provider health. With
an external connection backend, Doctor also reports backend reachability,
that each Trestle environment uses a distinct backend environment and key,
and which optional backend features (such as webhook forwarding) are
available. A
missing capability fails closed and identifies the relevant `trestle setup`
step.

## 21. Local development

Every first-party adapter supplies deterministic local behavior sufficient
to exercise its declared contract without a provider account. The local
runtime captures Connection attempts, token generations, trigger events,
Executions, provider calls, attempts, and reconciliation observations.

Scripted outcomes include success, timeout, 429 with retry-after, 5xx,
expired credential, refresh success/failure, revoked scope, duplicate and
out-of-order trigger, unknown account, and provider drift. Tests use
`ctx.clock` or an injected test clock, not sleeps. The local adapter must
never send to a real provider or use production credentials.

The connection backend also has a deterministic local implementation.
Local development and tests do not require a Nango account; a Nango
development environment is used only for real-provider evidence.

Real provider test accounts remain necessary for claims about actual OAuth,
API behavior, webhook signatures, rate-limit semantics, or reconciliation.
Local proof and provider proof retain distinct evidence labels.

## 22. Audit and observability

Semantic audit events include:

```text
integration.connection.authorizing
integration.connection.connected
integration.connection.reconnected
integration.connection.scope_changed
integration.connection.credential_rotated
integration.connection.reauthorization_required
integration.connection.revoked
integration.execution.requested
integration.execution.ambiguous
integration.execution.recovered
integration.reconciliation.started
integration.reconciliation.repaired
integration.reconciliation.failed
```

Routine successful provider attempts are operational history; sensitive
Connection changes and recovery are semantic audit. Events carry actor or
system principal, organization, environment, Connection/Execution IDs,
support-session and reason where applicable, correlation, and safe before/
after summaries.

Metrics include Connections by state, Action volume and latency, retry and
ambiguous-outcome rates, provider errors and rate limits, trigger ingestion
lag and deduplication, expired credentials, token-refresh failures, oldest
Execution age, reconciliation drift, and cleanup failures. Logs use Trestle's
structured logger and redaction rules. Credentials, raw sensitive input,
provider tokens, and unrestricted response bodies never appear in logs,
audit, admin, or proof artifacts.

## 23. Proof-oriented provider conformance

The [Proof-Oriented Engineering Specification](PROOF_ORIENTED_ENGINEERING_SPEC.md)
supplies claim/evidence rules. Each adapter has a reviewed conformance proof
set for the capabilities it declares:

- Connection authorization, provider account binding, refresh, revocation,
  reconnect, and scope changes.
- Action success, schema validation, timeout, 429, 5xx, duplicate work,
  expired credential, ambiguous outcome, and safe recovery.
- Trigger valid signature, invalid signature, duplicate, out-of-order,
  unknown tenant, revoked Connection, and environment mismatch.
- Reconciliation agreement, drift, bounded repair, and unrecoverable conflict.
- Cross-tenant denial, forced RLS, environment isolation, and secret-free
  evidence.

Conceptual CLI surface:

```bash
trestle prove integration <integration-id> --provider <provider>
```

The command is proposed, not current CLI functionality. Local conformance
uses deterministic fixtures. Claims about a real provider need provider
evidence. A provider adapter with missing required proof is `UNKNOWN`, not
approved because another adapter passed.

## 24. Reference adapters and falsification targets

The initial architecture should be tested with two different shapes rather
than a large catalog:

1. **Collaboration adapter:** one workspace identity, OAuth, a simple
   externally visible Action, and a provider event. It stresses account
   binding, scopes, connection UX, and side effects.
2. **CRM adapter:** OAuth, several scopes, CRUD-like Actions, pagination,
   rate limits, provider webhooks, external object IDs, and reconciliation.
   It stresses ambiguous creation, drift, and bidirectional behavior.

Slack-like and HubSpot-like providers are useful candidates, but selecting
them is an implementation decision, not a requirement that Trestle ship a
catalog. A later Google-style adapter can test more complex scopes and
consent without expanding the initial primitive set.

The reference adapters must try to falsify the abstraction. If either needs
a second tenant model, token store, execution state machine, or audit path,
the primitives need correction before a broader rollout.

## 25. Versioning and upgrades

Definitions, Actions, Triggers, adapters, provider event schemas, and
normalized result schemas carry explicit versions. Existing Connections
record the definition and adapter version they were authorized under;
pending Executions pin the Action input/output contract and provider
behavior required to finish safely.

An upgrade may add compatible Actions or metadata without forcing reconnect.
A new required scope, changed provider account binding, or incompatible
authentication strategy requires explicit reauthorization. A removed Action
cannot strand pending Executions: the deployment must retain a compatible
handler, migrate safely with a reviewed plan, or mark affected work for
manual resolution. Trigger version changes preserve deduplication and
event-schema compatibility for in-flight provider events.

SetupPlan and manifest upgrades preserve application-owned definitions and
tenant Connections. Doctor detects obsolete definition versions, missing
handlers, incompatible provider bindings, and required reconnects. No
upgrade reads or re-emits plaintext credentials through a generated file.

## 26. Future composition constraints

Automation, if later built, consumes normalized application events and
requests Actions through the same durable Execution API. It must not create
its own credential store or invoke adapters directly. A visual builder or
AI-authored workflow adds planning and policy above the primitives, not a
second integration runtime.

Future MCP exposure may wrap a selected Action's typed schema and invoke
the same authorization, entitlement, Connection, and Execution path. MCP
tool exposure cannot grant additional provider or tenant authority.

A future marketplace may distribute reviewed definition/adapter source or
another deliberately designed artifact. This specification does not permit
remote executable plugins or customer-authored code in the integration
worker merely to reserve marketplace optionality.

## 27. Delivery sequence

1. **Definition registry:** typed source conventions, action/trigger schemas,
   versioned inspection, and build-time validation.
2. **Connection foundation:** tenant tables with forced RLS, the
   `ConnectionBackend` contract with the Nango backend first (§8.3) and a
   local backend, backend-mediated OAuth, and safe customer views.
3. **Execution foundation:** durable Action request, outbox/Queue dispatch,
   attempts, idempotency, ambiguous outcome state, and local simulator.
4. **Trigger foundation:** authenticated ingress, binding, deduplication,
   normalization, and application event/domain handoff.
5. **Reconciliation and operations:** bounded drift checks, admin health,
   audited recovery, Doctor, and provider capability visibility.
6. **Reference adapters and proof:** two distinct provider shapes,
   deterministic conformance, real-provider evidence where needed, and
   clean-generated-application canary.

Each phase should deliver a coherent vertical slice. A broad adapter catalog
waits until the foundational contract survives the reference adapters.

## 28. Acceptance criteria

A clean generated application can, without editing Trestle internals:

1. Add a typed application-owned IntegrationDefinition with one Trigger and
   one Action.
2. Build and inspect its safe metadata; fail the build on invalid schema,
   duplicate IDs, or unsupported provider capability.
3. Enable the integration through SetupPlan without storing a plaintext
   client secret there.
4. Connect two organizations to distinct external accounts and prove forced
   RLS and authorization prevent cross-tenant use.
5. Complete an OAuth flow with single-use state, PKCE where applicable,
   verified account identity, and granted scopes.
6. Rotate or revoke credentials and prove queued work rechecks the current
   Connection generation.
7. Commit a domain mutation and Action request together; prove a provider
   outage does not roll back the mutation.
8. Observe one durable Execution despite duplicate outbox or Queue work.
9. Inspect Attempts, rate-limit delay, retries, and a normalized result.
10. Simulate an ambiguous non-idempotent outcome and prove no blind retry.
11. Ingest a valid provider Trigger and reject invalid, duplicate,
    out-of-order, cross-environment, or unbound occurrences safely.
12. Detect provider drift and preview a reconciliation repair without
    overwriting authoritative application state.
13. Manage the Connection from the customer UI without exposing credentials.
14. Find a failing Connection and recover an eligible Execution in admin with
    permission, step-up, reason, and audit.
15. Run the full path locally without a provider account, then distinguish
    that evidence from a real-provider conformance run.
16. Change the selected provider adapter, where the declared semantics allow
    it, without changing domain code, tenant ownership, or Execution APIs.

The architectural acceptance test is that a new provider implements its
authentication, triggers, actions, capabilities, and reconciliation behavior
without inventing a second tenancy, credential, execution, retry, audit,
admin, or proof system.

## 29. Open design decisions

1. *Resolved for initial releases:* credential custody is delegated to a
   bring-your-own Nango backend (§8.3). Still open: whether a later `native`
   backend extends the current encrypted-credentials mechanism or uses a
   dedicated tenant credential vault with the same write-only contract.
2. Which organization role receives connection management by default, and
   should externally mutating Actions require explicit step-up for any class?
3. Which provider and API operation best prove the first non-idempotent,
   ambiguous-outcome recovery path?
4. What are the initial execution-input and attempt-metadata retention
   defaults by sensitivity class?
5. Should customer-triggered reconciliation be available in v1, or only
   scheduled and platform-operated reconciliation?
6. How much provider capability inspection can be verified safely without
   creating external resources or billable actions?
7. How should a Connection with multiple provider workspaces or accounts be
   represented when the provider's own identity model is hierarchical?
8. What is the first release's supported adapter-version overlap for pending
   Executions and delayed provider events?

Until resolved, these questions remain explicit implementation choices. They
do not relax the ownership, security, or durability invariants above.
