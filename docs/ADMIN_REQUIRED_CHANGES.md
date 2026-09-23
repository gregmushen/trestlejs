# Trestle Admin Required Changes

**Status:** Implementation change specification  
**Scope:** Changes discovered during the September 22, 2026 admin review  
**Authority:** This is the single implementation checklist for this review.

## 1. Purpose

The current admin application has a strong visual shell but too many screens
behave as read-only demonstrations. This document lists only the changes needed
to turn those screens into usable administration workflows.

The broader platform, Kumo, integration, and administration specifications are
background references. Implementers should not have to combine those documents
to determine the work requested by this review.

## 2. Rules that apply to every changed screen

1. A resource-management screen must expose its primary creation action.
2. Rows must open inspectable detail without depending on an unlabeled ellipsis.
3. Authorized users must be able to edit, disable/archive, and delete where the
   resource lifecycle permits it.
4. Destructive actions show impact, require confirmation and a reason, and
   preserve audit history.
5. Existing secrets are never recoverable. Newly generated secrets are shown
   once through a dedicated copy/download step.
6. Tables must retain readable column widths. Do not permanently sacrifice half
   the page to an empty detail or instruction panel.
7. Human names are primary labels. Stable IDs remain visible and copyable as
   secondary metadata.
8. Provider credentials and other setup-owned secrets remain in
   `trestle setup`. Admin shows readiness and the repair command.
9. Every action remains permission-checked on the server, attributed, audited,
   environment-aware, and safe under retries.

## 3. Shell and overview

### 3.1 Header geometry

Fix the sidebar/top-bar boundary so the logo row, breadcrumb row, borders, and
content origin align. The collapsed-sidebar control must not create a second
misaligned gutter.

### 3.2 Overview

Replace the informational overview with an exception-oriented dashboard:

- unhealthy or incomplete setup;
- failed jobs and dead letters;
- webhook and notification failures;
- billing/provider reconciliation problems;
- expiring support sessions or credentials; and
- direct links to the affected resource.

Healthy systems should be summarized compactly instead of consuming the page.

## 4. Commercial

### 4.1 Plans

Add a deliberately simple primary flow:

```text
New plan -> Name -> Create plan -> Edit features
```

Trestle derives the key, creates version 1 as a draft, selects it, and opens the
feature editor. The key may be edited before creation and is immutable afterward.
Activation remains a separate confirmed action.

### 4.2 Subscriptions and Stripe mapping

Make provider linkage explicit and inspectable:

```text
Plan family                  -> Stripe Product
Plan version + offer         -> Stripe Price
Organization                 -> Stripe Customer
Trestle subscription         -> Stripe Subscription
Subscription line            -> Stripe Subscription Item + Price
```

The plan/version editor must connect or create product/price mappings. The
subscription detail must display the resolved chain, environment, verification
state, and reconciliation result. Never infer mappings from display names.

### 4.3 Entitlements

Replace the current organization picker plus detached simulation form with an
organization-centered entitlement explorer.

After choosing an organization, show:

- current plan and subscription state;
- included, unavailable, and overridden features;
- effective typed values;
- provenance for every value;
- usage, limits, and reset dates;
- active and scheduled overrides; and
- **Compare changes** for a proposed plan/override without mutation.

The feature list must come from the complete catalog so unavailable features
are visible rather than silently absent.

## 5. Roles and permissions

### 5.1 Organization roles

Add create, inspect, edit, clone, and safe delete/archive. A role has a name,
stable key, description, organization-plane permissions, and member assignments.
Built-in roles are protected but cloneable. Assignment and permission changes
show impact before confirmation.

### 5.2 Application roles

Provide the same lifecycle for application-plane roles. Assignments support
users and service accounts within an organization. Only application permissions
may be selected.

### 5.3 Permissions

Add **New permission** with:

- stable code;
- human name and description;
- authority plane;
- allowed principal types; and
- optional entitlement relationship.

The code and plane become immutable after creation. Permission detail shows
assigned roles, discovered enforcement points, origin, state, and audit. A
permission with no discovered enforcement must say so clearly. Protected
permissions cannot be deleted; custom permissions may be deprecated and deleted
only when unreferenced.

## 6. Machine access

### 6.1 Service accounts

Add **New service account** with organization, name, optional description, and
application roles. Creation does not mint a key implicitly.

Detail contains:

- overview and editable metadata;
- roles and effective permissions;
- API keys;
- safe usage; and
- audit history.

Support suspend/reactivate and delete. Deletion immediately prevents
authentication and revokes every key while retaining a tombstone and audit
history. Active names are unique within an organization.

### 6.2 API keys

Add **Create API key** with organization, active service account, human-readable
name, environment, scopes, optional expiration, and optional network
restrictions.

Scopes start empty and cannot exceed the service account, tenant entitlement,
environment, endpoint policy, or acting administrator. Show the new secret once.
An idempotent retry must not mint a duplicate.

Key detail supports safe inspection, usage, rotation with bounded overlap, and
immediate revocation. Scope widening creates a replacement key rather than
silently mutating active authority. Revoked keys remain historical records.

## 7. Integrations

### 7.1 Webhooks

Rename **Webhook Delivery** to **Webhooks**. Endpoints are the primary resource;
deliveries are their history.

Add **New webhook** with organization, name, HTTPS URL, and event subscriptions.
Optional description and timeout stay secondary. Creation shows the signing
secret once.

Endpoint detail supports:

- edit URL, metadata, timeout, and event subscriptions;
- send a marked test;
- pause/resume and emergency disable;
- rotate the signing secret with bounded overlap;
- inspect safe delivery attempts;
- replay eligible deliveries; and
- delete the endpoint.

Deletion disables and tombstones the endpoint, prevents queued workers from
sending, and retains delivery and audit history. Delivery URLs require SSRF,
redirect, private-network, metadata-target, and DNS-rebinding defenses.

## 8. Communications

### 8.1 Notification streams

The Notifications screen is primarily a stream-definition surface, not a list
of sends. Open it on **Streams** and keep **Deliveries** as a secondary tab.

A stream is the stable contract used by:

```ts
await ctx.notifications.send({ type, recipient, data });
```

Add **New stream** with a name and immutable type key, then open a draft editor
for:

- typed inputs and allowed recipient kinds;
- in-app, email, and future channel routes;
- templates and variable validation;
- parallel or fallback delivery;
- user-configurable, organization-controlled, or mandatory policy;
- grouping, deduplication, scheduling, and digests; and
- preview and marked test delivery.

Publishing creates an immutable active version. Editing creates a new draft;
queued notifications retain their recorded version. Published streams are
archived rather than erased. Missing or archived types fail visibly.

### 8.2 Email delivery

Keep email delivery as operational history. It must show provider-neutral safe
status, template identifier, masked recipient, correlation, attempts, and safe
failure category without exposing message bodies, tokens, or private links.

## 9. Operations

### 9.1 Audit

Make Audit a full-width, server-paginated table. Remove the permanent empty
right-hand instruction/detail pane.

Default columns:

- When;
- Event;
- Actor;
- Organization;
- Result; and
- Correlation.

Protect readable minimum widths. Timestamps and identifiers must not wrap one
word per line. Filters wrap above the table. If the viewport is too narrow, use
horizontal scrolling or hide lower-priority columns.

Open event detail on demand in a drawer/dialog or dedicated route and restore
focus to the originating row when it closes.

## 10. System authentication

Add **System -> Authentication** as the one place to understand and configure
authentication. Better Auth remains the engine; Trestle owns the unified admin
experience, policy, safeguards, authorization, and audit.

Keep **Account Security** separate. It manages only the current operator's own
password, TOTP, backup codes, passkeys, trusted devices, and sessions.

Authentication contains:

- effective posture and configuration health;
- sign-in methods and provider readiness;
- registration and email-verification policy;
- MFA, trusted-device, recovery, and step-up policy;
- session lifetime, concurrency, rotation, and revocation behavior;
- organization creation and invitation policy;
- enterprise SSO/SCIM status when installed;
- authentication email-flow readiness; and
- version history and rollback.

Every setting identifies its source:

- runtime policy;
- `trestle setup`;
- environment/deployment configuration; or
- Better Auth default.

Secret-bearing provider settings, origins, callbacks, cookies, and plugin
installation remain setup-owned and read-only in admin. Safe runtime policy is
edited as a draft, validated, reviewed with impact, activated with reason and
step-up, and rolled back through a previous valid version.

Reject any policy that would remove the last viable platform-admin sign-in or
recovery path, require unavailable factors/providers, or depend on an unhealthy
verification/recovery delivery route.

## 11. Extensibility

The default SaaS sidebar and built-in views remain application-owned and
extensible. Consumers can add ordinary admin views through the documented view
convention. Generated/apply operations preserve those views, their navigation,
and their server-enforced permissions.

## 12. Required verification

The change is complete only when browser and integration tests prove:

- every listed create action exists and succeeds for an authorized operator;
- inspect, edit, lifecycle, and destructive actions enforce the exact server
  permission and emit audit evidence;
- one-time secrets cannot be recovered later;
- delete/archive behavior preserves history while stopping future authority or
  delivery;
- tables remain readable at desktop, tablet, 200% zoom, and long-content cases;
- authentication policy cannot lock out platform administrators;
- notification sends resolve immutable stream versions;
- webhook workers do not send after endpoint deletion;
- Stripe mappings reconcile without name guessing; and
- generated consumer admin views survive subsequent setup/apply operations.

## 13. Suggested implementation order

1. Shared page actions, detail overlays, table sizing, and confirmation patterns.
2. Plans, roles, permissions, service accounts, and API keys.
3. Webhook endpoint management and notification streams.
4. Entitlements and Stripe mapping.
5. Authentication configuration and lockout safeguards.
6. Audit layout, overview exceptions, visual/accessibility regression coverage.

