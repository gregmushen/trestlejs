# TrestleJS Platform Admin Overview Specification

**Status:** Draft v1  
**Date:** 2026-09-22  
**Applies to:** `apps/admin` platform-operator Overview  
**Related:** [Administration and Access Control Specification](ADMIN_SPEC.md),
[Kumo Admin UI Specification](ADMIN_KUMO_SPEC.md)

## 1. Purpose

The platform-admin Overview is the operational home page for the generated
SaaS. It must answer four questions within approximately five seconds:

1. Is anything broken?
2. What needs the operator's attention?
3. What changed recently?
4. How is the SaaS operating?

The governing principle is:

> **Overview is exception-oriented, not configuration-oriented. Healthy
> infrastructure recedes; conditions requiring operator judgment or action
> receive priority.**

The sidebar describes what the platform contains. Overview describes what is
happening now.

## 2. Scope

This specification defines:

- the health and attention summary;
- actionable attention items;
- recent significant activity;
- customer, commercial, operations, delivery, and environment summaries;
- capability-health compression;
- application-owned overview cards;
- API and registry contracts;
- authorization, privacy, freshness, and failure behavior; and
- acceptance criteria.

This specification does not define the detailed resource screens, replace
System → Health, create a general analytics product, or authorize mutations
from dashboard cards.

## 3. Required hierarchy

Overview renders these regions in this order:

1. page title and environment;
2. operational status strip;
3. Needs attention and Recent activity;
4. Customers and Commercial;
5. Operations and Delivery;
6. application-owned business cards;
7. compact Environment and Capabilities summaries.

The first viewport must prioritize current exceptions. It must not be consumed
by a grid of healthy capabilities or equal-weight zero-value statistics.

## 4. Operational status strip

### 4.1 Healthy state

When no critical or warning attention items exist, render one compact success
summary:

```text
All systems operational · 12 capabilities healthy · 0 failed operations ·
0 dead letters · Last checked 12s ago
```

Individual healthy services do not receive separate cards in this state.

### 4.2 Attention state

When attention items exist, the strip changes emphasis:

```text
2 items need attention · 1 critical · 1 warning · Last checked 12s ago
```

Critical status uses the destructive visual treatment. Warning-only status
uses the warning treatment. Color is never the only indication of severity.

The count represents deduplicated operator work items, not raw failed attempts.
A webhook endpoint with seven failed attempts is one item with an occurrence
count of seven.

### 4.3 Freshness

The response includes `generatedAt`. The UI updates relative time without
pretending the underlying data was refreshed. Automatic refresh defaults to 30
seconds while the page is visible and pauses while hidden.

If the last successful response is older than two refresh intervals, the strip
shows **Data may be stale**. A failed refresh retains the last successful data,
marks it stale, and exposes Retry. It must not replace known incidents with an
empty or healthy state.

## 5. Needs attention

Needs attention is an operations inbox derived from authoritative platform
state. Every item must state the condition, affected resource, safe evidence,
and the next place the operator should go.

```ts
export type AdminAttentionItem = Readonly<{
  id: string;
  kind: string;
  severity: "critical" | "warning";
  title: string;
  description: string;
  occurrenceCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  organization?: Readonly<{ id: string; name: string }>;
  resource: Readonly<{ type: string; id: string; label?: string }>;
  action: Readonly<{
    label: string;
    path: string;
    search?: Readonly<Record<string, string>>;
  }>;
  permission: string;
  correlationId?: string;
}>;
```

### 5.1 Rules

- IDs are deterministic for the unresolved condition so polling does not
  reorder or duplicate an item.
- Similar failures are grouped by resource and condition.
- Critical items sort before warnings; within a severity, the oldest unresolved
  condition sorts first.
- The server filters items by the operator's platform permission before counts
  are calculated.
- Titles and descriptions use safe projections. They never expose payloads,
  secrets, webhook URLs, notification content, session tokens, or credentials.
- An item links to the relevant filtered resource view. Overview does not
  perform destructive or sensitive mutations directly.
- An item disappears only when the underlying condition resolves. V1 has no
  cosmetic dismiss button that can hide unresolved work.
- Empty state text is `Nothing requires attention`.

### 5.2 Core detection catalog

| Condition | Severity | Action destination |
| --- | --- | --- |
| Critical capability is unhealthy or has never reported | Critical | System → Health |
| Declared capability is not configured or deployed | Warning, critical in production when required | System → Health |
| Capability status is stale | Warning | System → Health |
| Database unreachable, migration pending, or schema incompatible | Critical | System → Health |
| Production deployment differs from expected release | Warning | System → Health |
| Dead-lettered outbox or queue message | Critical | Operations → Async |
| Workflow or operation exhausted retries | Critical | Operations → Async execution |
| Repeated webhook failures or disabled unhealthy endpoint | Warning; critical at configured threshold | Integrations → Webhooks |
| Email or notification delivery exhausted retries | Warning | Communications → Email or Notifications |
| Subscription projection requires reconciliation | Warning | Commercial → Subscriptions |
| Payment-provider projection is stale | Warning | Commercial → Subscriptions |
| Subscription is past due | Warning | Commercial → Subscriptions |
| API key expires within the configured window | Warning | Access → API Keys |
| Active service account is unused beyond the configured threshold | Warning | Access → Service Accounts |
| Invitation expires within the configured window | Warning | Customers → Organization |
| Artifact cleanup or retention operation failed | Warning | Operations → Artifacts |

A detector is enabled only when its capability exists and its underlying data
is reliable. Absence of instrumentation is not a healthy result; it is either
omitted or represented by a capability/configuration item.

Thresholds have documented defaults and may be configured in source. They are
not arbitrary values edited through the admin UI.

### 5.3 Resolution and acknowledgement

Attention state is derived rather than manually closed. Future acknowledgement
or snooze support, if added, must preserve the unresolved condition, actor,
reason, and expiry. Acknowledgement must never change health calculations.

## 6. Recent activity

Overview shows the most recent eight significant semantic events that the
operator is authorized to read.

Examples include:

- organization created;
- subscription activated, changed, or reconciled;
- API key minted, rotated, or revoked;
- user suspended or restored;
- platform role assigned or revoked;
- support context entered or ended;
- deployment completed or failed; and
- plan version activated.

Every event contains:

```ts
export type AdminActivityItem = Readonly<{
  id: string;
  event: string;
  occurredAt: string;
  actor: Readonly<{ type: "user" | "service_account" | "system"; label: string }>;
  summary: string;
  organization?: Readonly<{ id: string; name: string }>;
  target?: Readonly<{ type: string; id: string; label?: string }>;
  destination?: Readonly<{ path: string; search?: Readonly<Record<string, string>> }>;
  correlationId: string;
}>;
```

The activity feed is projected from semantic audit events through an explicit
overview-safe event catalog. It must not display raw audit summaries or derive
sentences from arbitrary payload fields. Repetitive infrastructure events and
polling noise are excluded.

The section links to the complete Audit view. If the operator lacks the audit
permission, the server omits the feed and the UI does not describe it as empty.

## 7. Operating summaries

### 7.1 Customers

Show current totals and meaningful seven-day deltas where reliable:

- organizations and newly created organizations;
- users and newly created users;
- unique active users today, only if a defined activity signal exists; and
- pending invitations.

Do not infer an active user from account existence. The activity definition
must be documented and stable, such as a valid session or meaningful audited
application action during the UTC day.

### 7.2 Commercial

Show:

- active, trialing, past-due, and canceling subscriptions;
- reconciliation work requiring attention; and
- normalized MRR only when the selected billing adapter supplies enough
  trustworthy data.

MRR is nullable. The UI renders `Not available for this provider`, not `$0`,
when it cannot be calculated faithfully. Currency totals must never combine
different currencies.

### 7.3 Operations

Use a rolling 24-hour window for completed and failed counts, plus current
state for running work:

- completed and failed async operations;
- running or queued work;
- dead letters;
- active workflows; and
- stored artifacts and failed cleanup operations.

### 7.4 Delivery

Show a 24-hour summary for enabled delivery capabilities:

- webhook delivered, failed, and success rate;
- email delivered, failed, and success rate; and
- notifications sent, scheduled, and failed.

Success rate is `successful terminal deliveries / all terminal deliveries`.
Pending or scheduled deliveries are not failures and do not enter the
denominator. When the denominator is zero, show `No deliveries` rather than a
misleading 100%.

### 7.5 Truthful trends

Deltas and sparklines appear only when backed by retained time-series or event
data. The UI must not manufacture a trend from two current counts. Every metric
labels its time window.

## 8. Environment and capabilities

### 8.1 Environment

The Environment section is compact when healthy:

```text
Worker ✓ · Database ✓ · R2 ✓ · Queues ✓ · Workflows ✓ · Email LOCAL
12 migrations · schema current · deployment 72ac… · 18m ago
```

Unavailable services are omitted when intentionally disabled and expanded when
declared but unhealthy. Production and support-context banners remain persistent
shell concerns and are not replaced by this section.

### 8.2 Capabilities

The complete capability matrix moves to System → Health. Overview shows only:

```text
12 verified · 0 unhealthy · 0 configuration problems · View system health →
```

When capabilities are unhealthy, Overview expands only those capabilities and
their safe repair commands. Healthy capability cards never dominate the page.

## 9. Application-owned overview cards

Overview is extensible independently of full navigation views. Consumers may
drop an `admin-card.ts` descriptor and ordinary React component into a view or
feature directory:

```ts
export default defineAdminCard({
  id: "claims-processing",
  title: "Claims",
  group: "business",
  order: 20,
  size: "half",
  permission: "platform.claims.read",
  component: () => import("./ClaimsOverviewCard"),
});
```

```ts
export type AdminCardDescriptor = Readonly<{
  id: string;
  title: string;
  group: "business" | "operations";
  order: number;
  size?: "half" | "full";
  permission: string;
  entitlement?: string;
  capability?: CapabilityId;
  component: AdminComponentLoader;
}>;
```

### 9.1 Registry behavior

- `defineAdminCard` is a first-class registry API; a card does not require a
  corresponding sidebar view.
- Build-time discovery finds `admin-card.ts` files using the same application-
  owned convention as `admin-view.ts`.
- IDs are globally unique and kebab-case.
- The permission belongs to the platform plane; tenant application permissions
  do not authorize cross-tenant platform cards.
- Unknown permissions, entitlements, capabilities, groups, sizes, or missing
  component loaders fail the build.
- Permission, entitlement, and capability filtering occurs before the card is
  loaded.
- Core and consumer cards use the same rendering path.
- Consumer cards render after the core operating summaries and before the
  compact infrastructure footer.
- Cards may link to registered views but receive no implicit backend authority.
- Cards must use Trestle/Kumo adapters and satisfy the same responsive,
  keyboard, dark-mode, loading, empty, and error-state checks as core views.

The existing `overviewCard` child on `AdminViewDescriptor` becomes a backwards-
compatible shorthand that normalizes into `AdminCardDescriptor`. New code uses
`defineAdminCard`.

### 9.2 Data boundary

An extension card fetches through an application-owned, server-authorized API.
The descriptor's permission controls display only. Every backing route performs
its own permission, tenant-context, entitlement, and RLS checks.

Extension cards cannot inject attention items from browser code. A future
application attention source must be a typed server-side registry whose output
passes the same permission, safe-projection, stable-ID, and destination
validation as core attention items.

## 10. Overview API

The Overview uses one server-composed response for core data so counts and
attention state describe a coherent observation. Extension cards may load
independently and must not block the core response.

```ts
export type AdminOverview = Readonly<{
  generatedAt: string;
  environment: Environment;
  status: Readonly<{
    level: "healthy" | "warning" | "critical";
    attentionCount: number;
    criticalCount: number;
    warningCount: number;
    healthyCapabilityCount: number;
  }>;
  attention: readonly AdminAttentionItem[];
  activity?: readonly AdminActivityItem[];
  customers?: Readonly<{
    organizations: number;
    organizationsSevenDayDelta: number;
    users: number;
    usersSevenDayDelta: number;
    activeToday?: number;
    pendingInvitations: number;
  }>;
  commercial?: Readonly<{
    active: number;
    trialing: number;
    pastDue: number;
    canceling: number;
    reconciliationRequired: number;
    mrr?: Readonly<{ amountMinor: number; currency: string }>;
  }>;
  operations?: Readonly<{
    window: "24h";
    completed: number;
    failed: number;
    running: number;
    deadLetters: number;
    activeWorkflows: number;
    artifacts: number;
    artifactCleanupFailures: number;
  }>;
  delivery?: Readonly<{
    window: "24h";
    webhooks?: DeliverySummary;
    email?: DeliverySummary;
    notifications?: Readonly<{ sent: number; scheduled: number; failed: number }>;
  }>;
  infrastructure: Readonly<{
    services: readonly Readonly<{ id: string; label: string; state: "healthy" | "degraded" | "failed"; mode?: string }>[];
    migrations: Readonly<{ applied: number; pending: number; current: boolean }>;
    deployment?: Readonly<{ revision: string; deployedAt: string; expected: boolean }>;
    capabilities: Readonly<{ verified: number; unhealthy: number; configurationProblems: number }>;
  }>;
}>;

type DeliverySummary = Readonly<{
  succeeded: number;
  failed: number;
  pending: number;
  successRate?: number;
}>;
```

Optional sections are absent when the operator lacks permission or the
capability is disabled. The UI must distinguish `absent` from a returned zero.

### 10.1 Query behavior

- Aggregation uses bounded indexed queries and does not scan arbitrary audit or
  delivery history on every refresh.
- All time windows are computed by the server in UTC.
- The endpoint avoids N+1 resource lookups.
- Provider outages return the last known projection with degraded freshness;
  the endpoint does not synchronously call providers.
- The response target is under 250 ms at the 95th percentile for the expected
  beta dataset and under 200 KB uncompressed.
- A failure in one optional section produces a section-level unavailable state
  and an attention item when actionable; it does not erase the entire Overview.

## 11. Authorization and privacy

- `platform.overview.read` is required for the route.
- Each attention item and optional section additionally declares the platform
  permission needed to reveal it.
- Filtering occurs on the server before counts, status, and serialization.
- Organization and application roles never grant platform Overview access.
- Entering support context does not broaden Overview. Tenant-scoped support
  data remains confined to the Support Workspace.
- Safe resource names may be shown. Secrets, content, payloads, complete URLs,
  tokens, hashes, and credentials may not.
- Overview reads do not create audit noise. Navigation and subsequent
  mutations retain their existing authorization and audit requirements.

## 12. Interaction and responsive behavior

- `r` refreshes Overview.
- `c` focuses the first attention item; if none exists, it focuses the compact
  system-health link.
- The expanded desktop sidebar header and the main top bar share one shell-header
  height token. Their bottom borders meet on the same physical pixel, and the
  sidebar rail begins at the top edge without a gap. A route change, breadcrumb
  length, environment strip, collapsed sidebar, or browser zoom must not create
  the stepped divider visible when the two headers have independent heights.
- The brand mark, sidebar trigger, breadcrumbs, and right-side controls are
  vertically centered within that shared header geometry. The collapsed and
  mobile variants preserve alignment without reserving an empty brand row.
- Attention actions and activity rows are reachable by keyboard and expose
  descriptive accessible names.
- On desktop, paired sections use a two-column layout.
- On narrow screens, status and Needs attention appear first, followed by
  Recent activity and the remaining sections in specification order.
- Loading preserves the major layout without reporting zero values.
- Section errors are local, concise, and retryable.
- No carousel, auto-rotating content, decorative chart, or color-only state is
  permitted.

## 13. Current implementation delta

The existing Overview currently provides environment, organization, user, and
dead-letter counts; provider and migration values; the full capability matrix;
and view-owned extension cards. Implementing this specification requires:

1. replacing the current `Overview` response with the server-composed contract;
2. adding bounded repository aggregations and attention detectors;
3. adding the safe audit-event activity projection;
4. moving the complete capability matrix out of Overview;
5. replacing equal-weight statistics with the adaptive status strip and
   exception-first layout;
6. introducing independently discovered `admin-card.ts` descriptors; and
7. preserving the existing card form as compatibility shorthand; and
8. replacing the sidebar-header and top-bar independent heights with one shared
   shell-header token so the horizontal and vertical dividers join cleanly.

No new provider call belongs in the Overview request path.

## 14. Verification

Automated tests must prove:

1. all-healthy state collapses infrastructure into a single compact summary;
2. a critical condition replaces the healthy state and appears first;
3. repeated failures collapse into one stable item with the correct count;
4. resolving the source condition removes the item on refresh;
5. unauthorized items and sections do not affect visible totals;
6. stale and failed refreshes never display a false healthy state;
7. zero delivery volume renders `No deliveries`, not 100%;
8. unavailable MRR is not rendered as zero;
9. recent activity uses only allowlisted safe projections and deep-links to the
   correct resource;
10. capability details remain available in System → Health while only unhealthy
    capability details appear on Overview;
11. a standalone consumer `admin-card.ts` is discovered, ordered, filtered,
    lazy-loaded, and rendered without a full view;
12. invalid or duplicate card descriptors fail the build;
13. extension-card API routes enforce authority independently of display
    filtering;
14. desktop and narrow layouts preserve the required information order;
15. `r` refreshes and `c` focuses the correct target without firing inside an
    input or overlay; and
16. the expanded, collapsed, and mobile shell headers align at 100%, 125%, and
    200% browser zoom with no stepped border, top gap, overlap, or one-pixel
    seam; and
17. the core response meets its query-count, size, and latency budgets.

## 15. Delivery slices

1. **Core response:** aggregation contract, status strip, compact environment,
   and compact capability summary.
2. **Operations inbox:** detector registry, stable grouping, permission
   filtering, destinations, and stale-data behavior.
3. **Activity and operating summaries:** safe event projection and customer,
   commercial, operations, and delivery sections.
4. **Extension contract:** first-class `defineAdminCard`, discovery,
   validation, compatibility normalization, and tests.
5. **Shell geometry:** unify sidebar and top-bar height, divider placement, and
   responsive variants behind one layout token; add visual-regression coverage.
6. **Hardening:** indexed-query verification, partial failures, responsive and
   accessibility checks, browser coverage, and performance budgets.

The Overview is complete only when a healthy system becomes visually quiet and
an unhealthy system immediately presents specific operator work.
