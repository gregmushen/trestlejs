# TrestleJS Admin Additions Specification

**Status:** Draft v0.1

**Scope:** Webhooks, notifications, and support sessions in the generated
customer and platform administration interfaces.

## Shared Rules

- Each view appears only when its capability is declared.
- Missing configuration produces sanitized status and directs the operator to
  `pnpm exec trestle setup --env <environment>`.
- Every action enforces its server-side permission and uses the normal domain,
  audit, correlation, tenant-context, and RLS paths.
- Navigation visibility is not an authorization boundary.
- Secret values, authentication tokens, unrestricted message bodies, and raw
  provider payloads never appear in admin read models.
- These views use the standard admin shell and typed admin-view registry.

## 1. Webhooks

The customer application's organization administration adds **Integrations ->
Webhooks** when tenant outbound webhooks are enabled.

Authorized organization administrators can:

- create, edit, pause, disable, and delete an endpoint;
- choose registered event subscriptions;
- verify an endpoint and send a marked test event;
- inspect endpoint health and delivery attempts;
- replay an eligible delivery;
- rotate the endpoint signing secret; and
- copy a newly minted signing secret once.

The endpoint list shows:

- name and sanitized URL;
- state and health;
- subscribed event count;
- last successful delivery; and
- last failed delivery.

The endpoint detail shows registered event names and versions, safe secret
metadata, delivery IDs, attempt counts, timestamps, response codes, failure
categories, and correlation identifiers. It never shows signing secrets,
arbitrary response bodies, internal event payloads, or provider credentials.

Application code emits registered events through `ctx.events`. Committed
transactional-outbox processing owns endpoint selection, signing, retry, and
delivery. The admin view cannot send arbitrary HTTP requests or bypass the
event registry.

Organization permissions distinguish reading configuration, managing
endpoints, rotating secrets, and replaying deliveries.

Platform admin adds **Integrations -> Webhook Delivery** for safe cross-tenant
health and failure inspection. Emergency disable and replay require separate
platform permissions, a reason, and an audit record.

## 2. Notifications

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

Platform admin adds **Support Sessions** and an **Enter tenant context** action
on organization detail pages.

Tenant-context support is the default support mechanism. The operator remains
the authenticated principal throughout the session.

Before activation, admin requires:

- a target tenant;
- a reason or ticket reference;
- a duration;
- an application-owned support access profile; and
- `platform.support.enter_tenant` permission.

The Effective Access Explorer previews the exact organization and application
permissions granted and denied. The platform permission permits creation of
the support session; it does not itself grant tenant authority.

While active, every admin view displays a persistent banner containing the
tenant, operator, reason, expiration countdown, and **Exit support context**
action. Environment and tenant indicators remain visible. Switching tenants
ends the current session or requires a new explicit session.

Every request, event, mutation, log, and audit record produced in support
context retains the operator ID, tenant ID, support-session ID, and reason.
Tenant database work continues through `withTenant()` and forced RLS.

Expiration or revocation immediately removes support authority and clears
tenant-scoped client state. The Support Sessions view lists active and
historical sessions, permission snapshots, reasons, expiration, termination
state, and correlated activity. Authorized security operators can revoke an
active session.

Secret access is never grantable through a support profile.

User impersonation is a separate optional capability, disabled by default. It
does not share the support-session action, permission, or audit vocabulary.

## Acceptance Criteria

The addition is complete when a generated application can:

1. render Webhooks, Notifications, and Support Sessions from declared
   capability state;
2. enforce every view and action permission on the server;
3. redact sensitive fields while preserving audit and correlation links;
4. operate endpoint and notification delivery actions only through their
   registered application services; and
5. enter, display, expire, exit, and revoke a support session while preserving
   the platform operator as the attributed actor.
