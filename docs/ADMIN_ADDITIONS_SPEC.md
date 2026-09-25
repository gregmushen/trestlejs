# TrestleJS Admin Additions Specification

**Status:** Implemented in part; see Implementation status.

**Scope:** Webhooks, notifications, and support sessions in the generated
customer and platform administration interfaces.

## Implementation status

Paths are relative to a generated project.

### Shipped

- **Customer webhooks** (`apps/app/src/webhook-inspection.tsx`,
  `/api/developer/webhooks/*`): register an endpoint, see its signing secret
  once, activate or disable it, replace its event subscriptions, and inspect
  endpoints, deliveries, and attempts. Permissions:
  `organization.webhooks.read`, `organization.webhooks.manage`, and
  `organization.webhooks.deliveries.read`.
- **Platform webhook operations** (admin **Operations -> Webhooks**): endpoints
  and dead or exhausted deliveries across organizations. Operators can disable
  an endpoint and replay a delivery whose payload is still retained
  (`platform.operations.read` to read, `platform.webhooks.manage` to act). Both
  actions need a reason and are audited.
- **Support sessions** (admin **Support -> Support sessions**): time-boxed
  (5 to 240 minutes), reasoned, read-only access to one organization's
  profile, members, plan, regional settings, and recent audit history.
  Entry, each view, and exit are audited on that organization. Each operator
  can hold one open session at a time. Requires
  `platform.support_sessions.use`.

### Deferred

- Customer webhooks: editing an endpoint's name or URL, pausing, deleting,
  verification and test events, customer replay, signing-secret rotation, last
  successful and failed delivery on the endpoint list, and separate
  permissions for rotation and replay.
- Notifications: all of §2, including the platform Notifications and Email
  Delivery views.
- Support sessions: support access profiles, a preview of granted
  permissions, tenant-application authority in a session, a banner that
  persists across all admin views, revocation by security operators, listing
  other operators' sessions, permission snapshots, and correlated activity
  listing.
- Capability gating of these views on declared capability state.
- User impersonation. It is out of scope and not planned.

## Shared Rules

- Each view is meant to appear only when its capability is declared.
  **Deferred:** the customer webhook screen is present in every project;
  activating an endpoint returns `409` until a delivery mode is configured.
  Admin views are filtered by permission and marked "(not configured)" when
  their capability is not configured.
- Missing admin configuration produces sanitized status and directs the
  operator to `pnpm exec trestle doctor --env <environment>`.
- Every action enforces its server-side permission and uses the normal domain,
  audit, and correlation paths. Customer actions also use the tenant context
  and forced RLS. Platform actions use the `trestle_platform` role, whose
  column grants and RLS policies limit what it can read and change.
- Navigation visibility is not an authorization boundary.
- Secret values, authentication tokens, unrestricted message bodies, and raw
  provider payloads never appear in admin read models.
- Admin views use the standard admin shell and the view registry in
  `apps/admin/src/registry.ts`.

## 1. Webhooks

The customer application includes a webhook screen for tenant outbound
webhooks. Authorized organization administrators (roles `owner` and `admin`)
can:

- create an endpoint with a name, an HTTPS destination, and at least one
  event subscription. New endpoints start disabled;
- copy the newly minted signing secret once;
- activate or disable an endpoint. Activation requires a current secret, a
  subscription, and a configured delivery mode;
- replace an endpoint's registered event subscriptions; and
- inspect endpoint health, deliveries (up to 50), and delivery attempts.

**Deferred:** editing the name or URL, pausing, deleting, verifying an
endpoint and sending a marked test event, replaying a delivery from the
customer application, and rotating the signing secret. Encrypted secret
versions with rotation overlap exist in the database layer, but no route or UI
exposes rotation.

The endpoint list shows:

- name and destination host (never the path or query);
- state and health; and
- subscribed event count.

**Deferred:** last successful delivery and last failed delivery on the list.

The endpoint detail shows registered event types and versions, delivery IDs,
states, attempt counts, timestamps, terminal reasons, payload availability,
correlation identifiers, and attempt outcomes. It never shows signing secrets,
headers, request or response bodies, internal event payloads, or provider
credentials. **Deferred:** safe secret metadata on the detail.

Application code emits registered events through `execution.events`, in the
same transaction as the mutation. Committed transactional-outbox processing
owns endpoint selection, signing, retry, and delivery. The customer screen
cannot send arbitrary HTTP requests or bypass the event registry.

Organization permissions distinguish reading configuration
(`organization.webhooks.read`), managing endpoints and subscriptions
(`organization.webhooks.manage`), and reading deliveries and attempts
(`organization.webhooks.deliveries.read`). **Deferred:** separate permissions
for rotating secrets and replaying deliveries.

Endpoint creation, state changes, and subscription changes are recorded in
`audit_event` (`webhooks.endpoint.created`, `webhooks.endpoint.state_changed`,
`webhooks.endpoint.subscriptions_changed`) after the change commits.

The platform admin's **Operations -> Webhooks** view shows endpoints across
organizations (name, organization, environment, state, health; never
destinations or secrets), and dead or exhausted deliveries (event, organization,
state, attempts, terminal reason, and whether the payload is still retained).
It requires `platform.operations.read`. With `platform.webhooks.manage`, an
operator can:

- **disable an endpoint.** This records `platform.webhook_endpoint.disabled`;
  and
- **replay a delivery.** A dead or exhausted delivery whose payload is still
  retained returns to `retry`, due immediately, and keeps its attempt history.
  This records `platform.webhook_delivery.replayed`.

Both actions require a reason and the admin origin, and write `audit_event` in
the same transaction. The affected organization sees the event in its audit
log without the operator's identity or reason.

## 2. Notifications

**Deferred.** None of this section is implemented. Email remains available
through the existing email boundary (local capture or Resend), and
`trestle email` inspects locally captured mail. There is no admin email view.

Target design:

Generated customer applications add a notification bell, unread count,
notification inbox, mark-read actions, and notification-preferences screen when
notifications are enabled.

Notification definitions remain application-owned and declare:

- supported channels;
- default preferences;
- mandatory or configurable behavior;
- grouping and deduplication behavior; and
- channel templates.

Email is a notification channel through the existing email boundary.

Platform admin adds **Communications -> Notifications** and **Email Delivery**.
The notification list shows:

- notification type;
- logical recipient and tenant;
- channel states;
- created and scheduled times;
- failure category; and
- correlation identifier.

The detail view shows grouping, deduplication, preference resolution, and safe
attempt history.

Authorized operators may retry an eligible failed delivery or cancel a pending
optional delivery when the application exposes those actions. Admin never
shows reset or verification URLs, authentication tokens, unrestricted message
bodies, provider payloads, or credentials.

Users may read their own notifications and manage their configurable
preferences. Organization-wide defaults and delivery history require explicit
organization permissions. Cross-tenant visibility requires a platform
permission.

## 3. Support Sessions

Platform admin adds a **Support sessions** view in the **Support** group. The
operator starts a session by choosing an organization from a list in that
view. **Deferred:** an **Enter tenant context** action on organization detail
pages, which do not exist yet.

The operator remains the authenticated principal throughout the session. A
session never signs the operator in as a customer.

Before starting a session, admin requires:

- a target organization;
- a reason of at most 500 characters. The form notes that the customer sees
  that support accessed their organization;
- a duration of 5 to 240 minutes (default 30); and
- the `platform.support_sessions.use` permission (held by
  `platform_operator`).

**Deferred:** an application-owned support access profile, and an Effective
Access Explorer preview of granted and denied permissions.

A session grants no organization or application permissions. It unlocks one
fixed, read-only view of the organization through
`GET /api/admin/support/sessions/:id/organization`:

- profile (name, slug, created date);
- members (name, email, organization role, joined date; up to 200);
- subscription (plan, plan version, status, period end);
- regional settings; and
- the 50 most recent audit events (name, time, actor type, outcome,
  correlation ID).

That route answers only for the operator's own open, unexpired session.
Anything else returns `403 support_session_required`. The reads run on the
`trestle_platform` connection, not through the tenant role and RLS. The
session check in the admin Worker is the boundary. **Deferred:** tenant
actions and any tenant-application authority within a session.

While a session is active, the Support sessions view shows the organization,
the expiry time, a note that every view is recorded, and an **End session**
action. **Deferred:** a banner that persists across every admin view with the
operator, reason, and a live countdown, and environment and tenant indicators
in the shell.

An operator holds at most one open session, which the database enforces with a
unique index. Starting another requires ending the current one. An expired
session that was never ended is closed, and that close is audited as a system
action, when the operator starts the next session. Ending a session does not
require a reason.

Every support-session audit record carries the operator (as
`platform_operator`), the organization, and the support-session ID:

- `platform.support_session.started` (with the reason);
- `platform.support_session.accessed`, recorded on every view of the
  organization; and
- `platform.support_session.ended`.

In the organization's own audit log these appear with actor ID `platform` and
no reason.

Expiry is checked on every request, so an expired session immediately stops
granting access. The database limits a session to four hours. The Support
sessions view lists the operator's own sessions, with organization, reason,
start time, and state (open, expired, or ended).

**Deferred:** listing all operators' sessions, permission snapshots,
correlated activity per session, and revocation of another operator's active
session by a security operator.

Secret access is never available in a support session because the support
view is fixed and returns no credentials. The permission flag `secret` and
the route-policy flag `revealsSecret` exist in `packages/authz`.
**Deferred:** enforcing them. Nothing reads either flag yet.

User impersonation is not implemented. It is out of scope. If it is ever
added, it must be a separate optional capability, disabled by default, and
must not share the support-session action, permission, or audit vocabulary.

## Acceptance Criteria

The addition is complete when a generated application can:

1. render Webhooks, Notifications, and Support Sessions from declared
   capability state. Webhooks and Support sessions render; Notifications and
   capability gating are **Deferred**;
2. enforce every view and action permission on the server (shipped for the
   implemented views);
3. redact sensitive fields while preserving audit and correlation links
   (shipped);
4. operate endpoint and notification delivery actions only through their
   registered application services. Endpoint actions ship; notification
   delivery is **Deferred**; and
5. enter, display, expire, exit, and revoke a support session while preserving
   the platform operator as the attributed actor. Enter, display, expire, and
   exit ship; revocation by another operator is **Deferred**.
