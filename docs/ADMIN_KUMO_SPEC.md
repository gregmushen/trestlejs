# TrestleJS Admin Kumo Migration Specification

**Status:** Draft 1

**Scope:** `packages/create/template/apps/admin`

**Target:** Kumo-based, Cloudflare-console-style platform administration with complete keyboard operation

**Reference baseline:** `@cloudflare/kumo` 2.14.0 at Cloudflare Kumo commit [`462516f`](https://github.com/cloudflare/kumo/tree/462516f9b75489c45a68aff26d3cd6ce66de5c49), reviewed 2026-09-22

## 1. Purpose

This specification defines the changes required to move the generated TrestleJS
platform admin from its current hand-built Tailwind interface to a Kumo-based
interface that follows the visual and interaction conventions of the Cloudflare
dashboard.

The result must be recognizably Cloudflare-like in information density, surface
hierarchy, navigation, status treatment, and interaction quality while remaining
a Trestle-branded product. It must not copy Cloudflare trademarks, product names,
or the Cloudflare logo.

This is not a cosmetic reskin. The migration includes:

- replacing local UI primitives with Kumo components;
- restructuring the shell and resource pages around Kumo patterns;
- making every workflow operable from the keyboard;
- making every meaningful action discoverable through a permission-aware command
  registry;
- preserving Trestle's authorization, capability, audit, tenant-context, and
  extension boundaries;
- adding automated gates so consumer-added admin views cannot regress the design
  system or keyboard contract.

## 2. Normative language

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 3. Preconditions

The current worktree contains a functional admin foundation, but the Kumo work
MUST begin from a buildable authorization model. The redesign MUST NOT hide or
work around these existing integration breaks:

1. Replace every `platform.tenant_context.enter` reference with the finalized
   support-session permissions, beginning with `platform.support.enter_tenant`.
2. Replace the deleted `platform_tenant_context` repository operations with the
   `support_session` model introduced by migration `0008_admin_additions.sql`.
3. Carry `support_session_id`, the operator identity, and the support reason into
   every audit event and outbox event emitted during a support session.
4. Implement the admin API and views for outbound webhooks, notifications, and
   support-session history before claiming those navigation destinations are
   complete.
5. Make the generated-project check the authoritative test environment. Tests
   executed against the template source without generated workspace dependencies
   are not sufficient evidence.

The visual migration may proceed in parallel with these corrections, but release
acceptance requires both sets of work.

## 4. Product and design principles

### 4.1 Visual target

The admin MUST use the following Cloudflare-console characteristics:

- a persistent, collapsible left navigation with icons and grouped resources;
- a restrained neutral canvas with flat and subtly elevated surfaces;
- compact, information-dense tables and forms;
- clear page title, breadcrumb, status, and primary-action hierarchy;
- inline operational state rather than decorative dashboard chrome;
- progressive disclosure for secondary detail and advanced actions;
- explicit environment and support-context warnings that cannot be mistaken for
  ordinary content;
- consistent empty, loading, degraded, permission-denied, and failure states.

The design MUST remain Trestle-branded. `CloudflareLogo` MUST NOT be used.
Application name, application icon, documentation links, and custom views remain
consumer-owned.

### 4.2 Kumo owns presentation and widget accessibility

Kumo MUST be the default source for buttons, fields, selection controls, dialogs,
menus, popovers, tooltips, banners, badges, cards, tables, pagination, tabs,
empty states, loaders, toast notifications, breadcrumbs, sidebars, and command
palette presentation.

Base UI behavior supplied by Kumo MUST remain intact. Trestle MUST NOT recreate
focus traps, roving focus, menu arrow navigation, dialog escape handling, or ARIA
relationships already provided by Kumo.

### 4.3 TanStack Hotkeys owns application shortcuts

`@tanstack/react-hotkeys` MUST remain the single authority for application-level
shortcuts, shortcut sequences, conflict detection, and platform-specific display.

Kumo's native component keyboard behavior and TanStack Hotkeys have separate
responsibilities:

- Kumo/Base UI handles interaction *inside* a widget: Tab, arrow navigation,
  Enter/Space activation, Escape dismissal, focus trapping, and ARIA state.
- TanStack Hotkeys handles application commands: opening the command palette,
  navigation sequences, focusing filters, selecting resource rows, and invoking
  page actions.

Trestle MUST NOT add a TanStack binding for a key already consumed by the focused
Kumo widget. In particular, command-palette, menu, select, combobox, dialog, and
table-selection behavior MUST not be double-bound.

### 4.4 Security semantics do not change with appearance

- Hidden navigation is never an authorization boundary.
- Every API route continues to enforce its own platform permission.
- Capability state continues to control whether a view is hidden, shown as
  unconfigured, or enabled.
- A keyboard shortcut MUST run the exact same command handler as its visible
  control.
- A destructive shortcut MUST open the confirmation dialog; it MUST never execute
  the mutation directly.
- Secret material MUST never enter Kumo components, tooltip content, command
  labels, toast messages, URL state, client logs, or analytics.
- Support context MUST remain visually persistent and auditable.

### 4.5 Non-goals

This specification does not:

- redesign `apps/site`, `apps/app`, or the `trestle setup` console;
- make Kumo a runtime dependency of consumer-facing Trestle applications;
- change the meaning of permissions, roles, entitlements, or capabilities;
- grant platform operators new tenant authority merely to make a control visible;
- require a Cloudflare account or hosted Cloudflare dashboard code;
- replace TanStack Router, Query, Form, or Hotkeys;
- require consumers to use Kumo outside the generated admin surface.

## 5. Dependency and CSS changes

### 5.1 Package dependencies

`apps/admin/package.json` MUST add exact, tested versions of:

```json
{
  "@cloudflare/kumo": "2.14.0",
  "@phosphor-icons/react": "2.1.10"
}
```

Kumo supports React 18 and 19 and therefore fits the current React 19 template.
Kumo and its version MUST be updated deliberately through the Trestle release
process; a floating range is not acceptable in the generated template.

`@tanstack/react-hotkeys` remains a direct dependency. Kumo's command palette is
not a substitute for it.

### 5.2 Global CSS

The admin stylesheet MUST follow Kumo's required Tailwind v4 order:

```css
@source "../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
@import "@cloudflare/kumo/styles";
@import "tailwindcss";
```

The actual `@source` path MUST be verified in a freshly generated pnpm workspace;
the example above is illustrative.

The following current patterns MUST be removed from admin code:

- raw palette classes such as `slate-*`, `red-*`, `amber-*`, `blue-*`, and
  `emerald-*`;
- `.panel`, `.button`, `.button-secondary`, `.button-danger`, `.input`, and
  `.label` as competing component implementations;
- manual dark-mode variants;
- arbitrary shadows, rings, and border colors when a Kumo semantic token exists.

Consumer layout code MAY use Tailwind utilities, but colors MUST use Kumo semantic
tokens. The expected surface hierarchy is:

```text
bg-kumo-canvas
  └── bg-kumo-base
        ├── bg-kumo-elevated
        ├── bg-kumo-recessed
        └── bg-kumo-tint
```

The application root MUST create an isolated stacking context because Kumo
floating components portal to `document.body`:

```tsx
<div className="isolate min-h-screen bg-kumo-canvas text-kumo-default">
```

The shell MUST use `data-mode="light" | "dark"` for theme selection. Kumo tokens
handle both modes; admin code MUST NOT introduce `dark:` classes.

## 6. Application providers

The root provider order MUST be:

```text
QueryClientProvider
  LinkProvider (TanStack Router bridge)
    KumoPortalProvider
      Toasty
        AdminProvider
          Sidebar.Provider
            Router content
```

Requirements:

- `LinkProvider` MUST adapt Kumo links and sidebar links to TanStack Router so
  navigation never causes a full document reload.
- `KumoPortalProvider` MUST place overlays in the intended application stacking
  context when necessary.
- `Toasty` MUST be the only global transient-notification system.
- Mutation success and failure MUST be announced through toast and appropriate
  live regions; a toast MUST not be the only durable record of a partial failure.
- Providers MUST not create a second source of operator session, capability, or
  tenant-context state.

## 7. Shell specification

### 7.1 Sidebar

Replace the custom desktop sidebar and mobile drawer with Kumo `Sidebar`:

- `Sidebar.Provider` owns expanded, collapsed, and mobile state.
- `Sidebar.Group`, `Sidebar.GroupLabel`, `Sidebar.Menu`, and
  `Sidebar.MenuButton` render registry groups and views.
- Every default view MUST have a Phosphor icon in its descriptor.
- The active item MUST be derived from TanStack Router state.
- Unconfigured capabilities MUST render a disabled item with a Kumo `Badge` and
  `Tooltip` containing the repair command.
- Permission-hidden destinations MUST not render.
- Collapsed mode MUST retain accessible names and tooltips.
- The consumer extension registry MUST use the exact same rendering path as core
  views; no separate "custom" section styling is permitted unless the consumer
  explicitly creates such a group.
- Sidebar state MAY persist locally, but persistence failure MUST not affect use.

The sidebar header contains the Trestle consumer's application mark and name. The
footer contains keyboard help and optional consumer-provided support/documentation
links.

### 7.2 Header

The compact top bar MUST contain:

- the Kumo `Sidebar.Trigger` on mobile and when appropriate on desktop;
- breadcrumbs using Kumo `Breadcrumbs`;
- a search/command trigger showing the `Mod+K` binding;
- the environment badge;
- the operator menu using Kumo `DropdownMenu`;
- no duplicate page title when the page header immediately follows.

The current plain anchor breadcrumbs MUST be removed. All breadcrumb navigation
MUST use the router bridge.

### 7.3 Environment treatment

- Production MUST show a persistent danger treatment in the shell, not merely a
  red badge.
- Staging uses warning treatment.
- Preview and local use neutral treatment.
- Destructive confirmations in production MUST restate the environment.
- Environment appearance MUST use Kumo semantic variants and tokens.

### 7.4 Support-context banner

An active support session MUST render a persistent Kumo `Banner` below the top
bar and above route content. It MUST show:

- tenant name;
- support profile;
- operator identity;
- ticket/reference when present;
- live remaining duration, updated at least once per minute;
- an explicit Exit action;
- a statement that the operator remains the actor;
- a link to the support-session detail/audit view.

The banner MUST remain visible while scrolling, MUST use warning treatment, and
MUST automatically clear when the server says the session is expired or revoked.
Client session storage may optimize presentation but MUST never be authoritative.

### 7.5 Page frame

Use the Kumo page-header block as an application-owned installed block, not an
unversioned copy pasted from documentation. Trestle MAY adapt it to accept an
`actions` region and TanStack breadcrumbs.

Every page follows this order:

```text
Breadcrumbs
Title + concise operational description
Optional tabs
Primary action(s)
Filters / scope controls
Primary resource surface
Secondary detail or supporting surfaces
```

Resource pages SHOULD use the Kumo resource-list block where its layout matches.
Blocks are installed application source, not package exports, so Trestle owns and
tests the resulting files.

## 8. Trestle admin UI adapter layer

`src/shell/ui.tsx` MUST cease being an independent visual system. It SHOULD become
a small semantic adapter layer so generated views stay terse and consumer views
receive consistent behavior.

Required adapters:

| Trestle adapter | Kumo implementation | Additional Trestle responsibility |
| --- | --- | --- |
| `AdminPageHeader` | installed `PageHeader`, `Breadcrumbs`, `Button` | route metadata and commands |
| `AdminSection` | `LayerCard` or `Surface` | consistent heading/action slots |
| `AdminDataTable` | `Table`, `LayerCard`, `Pagination` | keyboard row model, URL state |
| `AdminQueryState` | `Loader`, `Empty`, `Banner`, skeletons | retry and permission messaging |
| `AdminStatus` | `Badge` | domain-to-variant mapping |
| `AdminField` | `Field`, `Input`, `Select`, `Combobox`, `Switch` | schema errors and descriptions |
| `AdminConfirmAction` | `Dialog`, `Button`, `SensitiveInput` | reason, step-up, partial failure |
| `AdminCommandPalette` | `CommandPalette` | registry filtering and dispatch |
| `AdminToast` | `Toast` / `Toasty` | correlation ID and retry affordance |
| `AdminUsageMeter` | `Meter` | quota semantics and accessible label |

Adapters MUST expose semantic variants such as `success`, `warning`,
`destructive`, and `neutral`. They MUST NOT expose raw color-class props.

### 8.1 Required file-level changes

| Current file or area | Required change |
| --- | --- |
| `apps/admin/package.json` | Add pinned Kumo and Phosphor dependencies; retain TanStack Hotkeys. |
| `apps/admin/src/styles.css` | Install Kumo CSS/source directives, establish canvas/root rules, and remove the competing local component classes and raw color palette. |
| `apps/admin/src/main.tsx` | Install Kumo providers, router link bridge, root isolation, Kumo shell frame, and route-level permission handling. |
| `apps/admin/src/registry.ts` | Add icons, scoped commands, action metadata, scope-aware conflict validation, and the Webhooks/Notifications/Support capabilities where applicable. |
| `apps/admin/src/views.ts` | Keep convention-based discovery; validate the expanded Kumo/keyboard descriptor contract. |
| `apps/admin/src/navigation.ts` | Preserve consumer-defined groups and add optional group icon/label metadata without creating a second renderer. |
| `apps/admin/src/shell/Sidebar.tsx` | Replace custom sidebar and mobile drawer with a Kumo Sidebar adapter; preserve registry filtering and persisted preference. |
| `apps/admin/src/shell/TopBar.tsx` | Replace custom search/menu controls with Kumo components; make search selection URL-aware and router-native. |
| `apps/admin/src/shell/ui.tsx` | Remove visual reimplementations and retain only Trestle semantic adapters, formatting helpers, and query-state policy. |
| `apps/admin/src/shell/ConfirmAction.tsx` | Rebuild on Kumo Dialog/Field/Button/SensitiveInput while preserving reason, step-up, partial failure, and focus restoration. |
| `apps/admin/src/shell/commands.tsx` | Render with Kumo CommandPalette; add route/selection/dialog scopes and runtime action registration while retaining TanStack Hotkeys. |
| `apps/admin/src/shell/context.tsx` | Expose server-authoritative support session and command scope; remove client storage as authority. |
| `apps/admin/src/shell/roles.tsx` | Convert role presentation to the shared Kumo role catalog and plane badges. |
| `apps/admin/src/views/*/admin-view.ts` | Add Phosphor icon metadata and a complete navigation/primary-action command declaration. |
| `apps/admin/src/views/*/view.tsx` | Replace raw controls/classes with adapters, add URL selection/filter state, and register mounted action handlers. |
| `apps/admin/src/views/webhooks/*` | Add endpoint and delivery administration views. |
| `apps/admin/src/views/notifications/*` | Add notification-stream definition, publishing, test, and secondary delivery-history views. |
| `apps/admin/src/views/authentication/*` | Add unified effective authentication configuration, versioned runtime policy, impact review, and rollback views. |
| `apps/admin/src/views/account-security/*` | Keep this strictly self-service for the current operator's factors and assurance; do not mix in system policy. |
| `apps/admin/src/views/support-sessions/*` | Add active/history support-session view and session workflows. |
| `apps/admin/scripts/check-admin-views.ts` | Validate icons, scoped bindings, action handlers, Kumo usage rules, and policy evidence. |
| `apps/admin/**/*.test.ts(x)` | Add component, keyboard, route-state, and accessibility coverage described in Section 15. |
| `packages/cli/src/generate-access.ts` | Make `trestle generate admin-view` emit Kumo imports, icon metadata, and command declarations. |
| `apps/admin/README.md` | Replace legacy examples with Kumo extension and keyboard-command guidance. |
| generated-project validation | Install the generated workspace and exercise the real admin build, tests, Kumo CSS output, and Worker dry run. |

## 9. Keyboard and command architecture

### 9.1 Definition of complete keyboard control

A workflow satisfies this specification only when:

1. every interactive control is reachable and operable with standard keyboard
   semantics;
2. every page and every primary or destructive workflow is represented in the
   command registry;
3. high-frequency workflows have a direct TanStack Hotkeys binding;
4. table/list workflows can select and act on a resource without pointer input;
5. all enabled bindings are visible in the command palette, tooltips, action
   menus, and the `?` shortcut reference;
6. permission-denied or capability-disabled commands are absent, not merely
   disabled after invocation;
7. no shortcut executes against an implicit or stale target.

Native Tab/Enter behavior alone is not enough for primary and destructive
workflows. Conversely, a hotkey is not a substitute for correct native semantics.

### 9.2 Command model

Extend the registry command type to include scope and execution metadata:

```ts
type AdminCommandScope = "global" | "view" | "selection" | "dialog";

type AdminCommandDefinition = {
  id: string;
  label: string;
  group: string;
  scope: AdminCommandScope;
  hotkey?: string;
  permission?: string;
  capability?: CapabilityId;
  keywords?: readonly string[];
  kind: "navigate" | "focus" | "action";
  destructive?: boolean;
};
```

Static descriptors declare identity, authorization requirements, discovery text,
and default bindings. Mounted views register runtime handlers and current target
state through a hook such as:

```ts
useAdminCommands({
  "api-keys.revoke": {
    enabled: selectedKey?.status === "active",
    target: selectedKey?.id,
    run: () => openRevokeDialog(selectedKey!),
  },
});
```

The dispatcher MUST resolve one handler for the current route and selection.
Commands with no valid target remain visible in the palette only when they can
explain what selection is required; their hotkey MUST not fire.

### 9.3 Scope and precedence

Shortcut resolution order is:

```text
open modal/dialog > focused widget > current selection > current view > shell > global
```

- Dialog shortcuts are active only for the topmost dialog.
- View and selection shortcuts are inactive while an overlay is open.
- Printable shortcuts MUST ignore text inputs, textareas, editable elements,
  combobox inputs, and command-palette inputs.
- Global `Mod+K` and Escape behavior may opt out of input ignoring only where
  explicitly tested.
- Sequence timeout and key normalization MUST come from TanStack Hotkeys.
- Display strings MUST use `formatForDisplay()` so macOS and other platforms see
  appropriate modifiers.

### 9.4 Collision validation

Build-time registry validation MUST reject:

- duplicate global bindings;
- a sequence that is the prefix of another active sequence;
- collisions between commands whose scopes can be active simultaneously;
- consumer commands that claim reserved shell bindings;
- action commands without a runtime handler contract;
- destructive commands that bypass confirmation;
- navigation commands whose route does not exist.

The same single-key binding MAY be reused on different views because those scopes
cannot overlap. The existing global-only collision algorithm MUST therefore be
made scope-aware.

### 9.5 Canonical shell bindings

| Binding | Command |
| --- | --- |
| `Mod+K` | Open/close command palette |
| `/` | Focus global search when focus is not in an editable control |
| `?` | Open keyboard reference |
| `Escape` | Close the topmost dismissible overlay; otherwise clear row selection |
| `[` | Toggle/collapse sidebar |
| `g d` | Overview |
| `g o` | Organizations |
| `g u` | Users |
| `g p` | Plans |
| `g s` | Subscriptions |
| `g e` | Entitlements |
| `g r` | Permission registry / access explorer |
| `g m` | Service accounts |
| `g k` | API keys |
| `g w` | Webhooks |
| `g n` | Notifications |
| `g l` | Email delivery |
| `g j` | Async operations |
| `g f` | Artifacts |
| `g a` | Audit |
| `g x` | Support sessions |
| `g y` | Authentication configuration |
| `g i` | Account security |
| `g h` | Health |

Role catalog destinations without dedicated global keys remain available through
`Mod+K`. Consumer views MAY declare unused `g <key>` sequences; validation MUST
prevent collisions.

### 9.6 Canonical resource-view bindings

These bindings are route-scoped and reusable:

| Binding | Behavior |
| --- | --- |
| `f` | Focus the current page's primary filter/search |
| `j` / `k` | Move active row down/up without changing selection |
| `Enter` | Open/select the active row |
| `Space` | Toggle selection where multi-selection is supported |
| `Shift+A` | Open the active row's action menu |
| `n` | Start the page's create/draft workflow when available |
| `e` | Edit the active resource when available |
| `r` | Primary page-specific recovery action, such as retry/reconcile/replay |
| `Mod+Enter` | Submit the active non-destructive form |
| `Mod+Shift+Enter` | Advance to confirmation for a destructive form |

`j`, `k`, printable action keys, and sequences MUST not run while focus is inside
an editable control. The active row MUST have a visible Kumo selection treatment,
must be scrolled into view, and must be exposed through `aria-activedescendant` or
an equivalent accessible pattern.

### 9.7 Confirmation and step-up bindings

The Kumo confirmation dialog MUST support:

- Escape: cancel;
- `Mod+Enter`: confirm a non-destructive action once validation passes;
- `Mod+Shift+Enter`: confirm a destructive action once validation passes;
- automatic focus on the reason field;
- automatic focus on the password field during step-up;
- focus restoration to the originating action after close.

The shortcut opens or advances the same visible confirmation flow. No key chord
may bypass the reason, permission, freshness, or step-up requirements.

## 10. URL and selection state

Search, filters, selected resource, pagination, and tabs MUST be modeled in typed
TanStack Router search state where they need to survive navigation or command
dispatch.

At minimum:

- global search selection MUST open the selected organization or user, not merely
  navigate to its unfiltered list;
- command-palette target commands MUST identify the target workflow in typed
  search state;
- back/forward navigation MUST restore filter and selected-resource state;
- copying a URL MUST reproduce the same safe administrative view;
- sensitive values and secrets MUST never enter URL state.

## 11. Screen-by-screen migration

### 11.1 Operator sign-in

- Use `Surface`, `Text`, `Input`, `SensitiveInput`, `Button`, and `Banner`.
- Keep the local-only `admin/admin` hint visibly separate from production UX.
- Enter submits through native form semantics.
- `Mod+Enter` MAY submit but MUST not replace Enter.
- Loading and authentication errors use Kumo feedback components.

### 11.2 Overview

- Use `Grid`, `LayerCard`, `Badge`, `Meter`, and optional sparklines for health
  trends when real time-series data exists.
- Do not add decorative charts backed only by current counts.
- Capability cards include state, mode, last report time, and repair command.
- `r` refreshes overview data; `c` focuses the first unhealthy capability.

### 11.3 Organizations

- Use a resource-list/table master-detail layout.
- Search and selected organization live in URL state.
- Detail uses `LayerCard` and tabs for Summary, Members, Access, Subscription, and
  Support where data exists.
- Enter-support-context is the primary sensitive action.
- Bindings: `f`, `j/k`, Enter, `e` for enter support context, `x` for exit current
  context.

### 11.4 Users

- Use Kumo `Table`, compact header, status `Badge`, pagination, and row action
  `DropdownMenu`.
- Membership and role details use a drawer/layer rather than an over-wide cell.
- Bindings: `f`, `j/k`, Enter, `s` suspend/restore, `r` revoke sessions.

### 11.5 Plans

- Use tabs or collapsibles for plan families and a Kumo table for comparison.
- A visible primary **New plan** button is present on every Plans tab, including
  Comparison. It is not hidden in a row menu, command palette, or empty state.
- **New plan** opens a small dialog with one required field: Name. A stable key
  is derived as the operator types and shown as secondary text; changing it is
  an optional advanced action before creation.
- **Create plan** creates version 1 as an empty draft, closes the dialog, selects
  the new plan tab, and opens its structured feature editor. Focus moves to the
  first feature control or the editor heading.
- The creation dialog does not ask for a provider, product ID, price, currency,
  billing interval, raw JSON, confirmation, or audit reason. Those concepts do
  not belong to creation of an inert entitlement draft.
- Creation failures stay in the dialog beside the relevant field and preserve
  input. Duplicate keys explain that the key is already used.
- If no plan exists, the empty state repeats the same **New plan** action. There
  is one creation flow, not a separate onboarding wizard.
- An existing plan-family tab retains a secondary **Draft next version** action
  when no draft already exists. That action copies the latest version and is
  distinct from creating a new plan family.
- Draft editing uses structured `Switch`, `Input`, `Select`, and `Field`
  components; raw JSON is not the default editing experience.
- Bindings: `j/k` plan-version selection, `n` new plan, `Shift+N` draft next
  version, `e` edit draft, `a` activate, `Shift+G` grandfather, `Shift+R`
  retire.

### 11.6 Subscriptions

- Use a searchable master-detail resource page.
- Detail sections become tabs: Summary, Overrides, Scheduled changes,
  Provider mapping, Reconciliation, and History.
- Summary shows the Trestle plan version and offer. Provider mapping shows the
  complete resolved chain: plan/version/offer, provider product and price,
  customer, subscription, and subscription item.
- Provider identifiers use safe copy buttons and environment-correct dashboard
  links. They are never editable as unlabeled free-form fields in the Summary.
- Missing, unknown, stale, test/live-mismatched, or conflicting links receive a
  clear status and one primary **Configure mapping** or **Reconcile** action.
- **Configure mapping** belongs to the plan/version catalog. From a subscription
  it opens the relevant plan mapping with context; it does not create a private
  per-customer mapping.
- The plan mapping flow supports two simple choices: **Use existing Stripe
  product and price** or **Create/sync in Stripe**. IDs are selected from
  validated provider results or pasted with immediate server-side validation.
- Reconciliation compares provider Customer, Subscription, Subscription Item,
  Product, Price, status, period dates, and the expected Trestle
  plan/version/offer. Differences are shown field by field before repair.
- Feature overrides use typed controls generated from the feature catalog; JSON is
  an optional advanced mode.
- Bindings: `f`, `j/k`, Enter, `o` add override, `c` schedule change, `r`
  reconcile.

### 11.7 Entitlements

- Replace the current stacked Organization entitlements and Simulation forms
  with an organization-centered explorer.
- The initial state uses a searchable organization list showing name, current
  plan, subscription status, and provider. Selecting a row opens the explorer;
  it does not render a large empty result card.
- When an organization is selected, the header shows organization, plan version,
  subscription/provider state, projection freshness, enabled/unavailable
  counts, override count, and quota count.
- The primary surface is a searchable feature table sourced from the complete
  feature catalog. Tabs or filters are **All**, **Enabled**, **Unavailable**,
  **Overrides**, and **Usage limits**.
- Feature rows use the human name first and code second. Columns are Effective
  access, Value, Usage, Source, and Effective dates. Use Kumo `Meter` for bounded
  usage and plain values for unlimited or non-metered features.
- Selecting a feature opens a detail layer showing Plan value → Override → Usage
  → Effective result. Source labels link to the plan version or override.
- The primary contextual action is **Add override** when permitted. It reuses
  the same typed override workflow as Subscriptions and refreshes both screens.
- **Compare changes** is a secondary action. It opens a drawer or dedicated
  comparison state prefilled with the organization's current plan. The operator
  can select a proposed active plan and add hypothetical typed overrides.
- Comparison results render Current and Proposed side by side with changed rows
  first, then unchanged rows. Results explicitly say **Nothing has been
  changed**.
- Comparison never contains an ambiguous Apply button. **Schedule plan change**
  and **Add override** are separate named actions with their existing
  confirmation, reason, authorization, audit, and outbox behavior.
- Raw JSON is optional advanced diagnostics only. Internal phrases such as
  “local effective-entitlement projection” do not lead the page copy.
- Organization, filter, selected feature, and comparison plan live in safe URL
  state so links from Organizations and Subscriptions open the same context.
- Bindings: `f` search/filter, `j/k` move feature rows, Enter opens feature
  detail, `o` adds an override, and `c` opens Compare changes. `Mod+Enter` runs
  comparison only while its form is focused.

### 11.8 Organization, application, and platform roles

- Organization and application role screens start with a searchable
  organization picker or the active tenant context. They do not present a
  misleading global read-only catalog as the complete management surface.
- The Application Roles page must remove the current “platform operators can
  only inspect them” dead-end. An operator with the narrow tenant-role
  management permission and an active tenant context receives the same New,
  Edit, Permissions, and Assignments workflows as an authorized tenant
  application administrator. Everyone else receives an explicitly read-only
  view without disabled or misleading creation controls.
- Share one master-detail role manager implemented with `Table`, `LayerCard`,
  `Tabs`, `Badge`, and typed form controls. Plane identity remains visually
  explicit everywhere.
- A visible primary **New role** action opens one straightforward editor: Name,
  Description, generated Key, and Permissions. Key editing is an optional
  advanced action before creation.
- The permission picker uses checkboxes grouped by resource, includes search,
  and shows human descriptions before stable codes. It lists permissions only
  from the current plane and requires at least one selection.
- Creating the role opens its detail view. Detail tabs are **Overview**,
  **Permissions**, **Assignments**, and **Audit**.
- Built-in roles carry a **Built in** badge. Their definitions cannot be edited
  or deleted at runtime; **Duplicate as custom role** opens the same editor with
  their description and permissions prefilled.
- Custom role Overview shows name, description, key, plane, organization,
  assignment count, creator, and update time.
- **Edit role** allows name, description, and permissions to change while the
  key remains immutable. If the role is assigned, confirmation shows added and
  removed permissions plus the number and kinds of affected principals.
- Organization-role Assignments lists organization members and provides
  **Assign members**. Application-role Assignments lists members and service
  accounts and provides **Assign users** and **Assign service accounts**.
- Application roles accept only application-plane permissions. The permission
  selector includes `application.roles.read`, `application.roles.manage`, and
  `application.roles.assign` when the current actor is allowed to delegate
  them, as well as the product-domain permissions registered by the consumer.
- Assignment dialogs use searchable principal pickers and display the
  principal's resulting role set before confirmation. They never accept a raw
  user ID as the primary interface.
- Assignment rows show whether authority is direct, directory-sourced, or
  application policy. Directory-owned assignments link to their mapping and
  cannot be manually removed from the role screen.
- Deleting an unassigned custom role is confirmed. Deleting an assigned role
  first requires choosing a replacement role or explicitly revoking all of its
  assignments, with an impact count and reason.
- Platform role definitions remain global and protected by default. Platform
  assignments use a searchable user combobox, require
  `platform.roles.manage`, step-up authentication, a reason, and last-security-
  administrator lockout protection.
- The same organization/application editor is reusable in the customer admin
  UI for authorized tenant administrators; the platform UI does not create a
  parallel role model.
- Bindings: `f` search, `j/k` move roles or assignments, Enter opens detail,
  `n` creates a custom role, `e` edits it, `a` assigns principals, `r` revokes
  an assignment, and `Shift+D` begins deletion.

### 11.9 Permissions and Effective Access Explorer

- A visible primary **New permission** action opens one editor with Name,
  Description, Plane, Resource, Action, generated Code, Principal types, and an
  optional Entitlement gate. Advanced fields remain collapsed by default.
- Plane, resource, and action produce a live code preview. The operator may edit
  the code before creation; code and plane become read-only afterward.
- The registry is a searchable master-detail table with plane, origin, state,
  principals, role count, and enforcement status. Plane filters remain visible.
- Permission detail tabs are **Overview**, **Roles**, **Enforcement**, and
  **Audit**. Overview uses human labels first and the stable code second.
- Roles provides **Add to roles** with searchable same-plane role selection and
  an impact preview. Removing the permission from a role uses the same role
  mutation path and reason rules as the role editor.
- Enforcement lists discovered routes, actions, workflows, and policy checks
  with source locations where available. Zero results render **No enforcement
  discovered — assigning this permission does not yet protect an action**, not
  “checked in code.”
- Protected Trestle/source permissions show a **Protected** badge and cannot be
  deleted. Admin-defined permissions can be edited, deprecated, and—only when
  completely unreferenced—deleted.
- Principal widening, entitlement changes, deprecation, and deletion show role
  and enforcement impact before confirmation. Creating an unreferenced
  permission is reversible and does not require a destructive confirmation.
- The Effective Access Explorer moves behind a clearly labeled **Explain
  access** tab or secondary action so it does not obscure permission creation
  and catalog management. It retains searchable organization, principal, and
  permission comboboxes and copyable structured explanation.
- Bindings: `f` filters, `j/k` moves permissions, Enter opens detail, `n` creates
  a permission, `e` edits, `a` adds it to roles, `x` opens Explain access, and
  `Mod+Enter` explains only while that form is focused.

### 11.10 Service accounts and API keys

- Make **New service account** the primary page action. Its compact dialog asks
  for organization, name, optional description, and searchable application-role
  selection. It does not mint a key as a side effect. Success opens the new
  account detail and offers **Create API key** separately.
- Use a server-paginated master-detail table with organization, name and safe ID,
  application roles, status, last used, and created time. Names are unique among
  non-deleted accounts in an organization; duplicate conflicts stay in the form.
  Row click and Enter open detail rather than depending on an unlabeled ellipsis.
- Detail tabs are **Overview**, **Roles & permissions**, **API keys**, **Usage**,
  and **Audit**. Overview supports name/description editing and
  suspend/reactivate. Roles & permissions supports application-role assignment
  and explains the effective role -> permission -> entitlement -> key-scope
  reduction. Usage shows last authentication and safe route/rate-limit data.
- API keys show only safe identifiers, scopes, status, expiry, last use, and
  rotation/revocation metadata. Never render secret material or imply that an
  existing secret can be recovered. A newly minted secret uses a one-time dialog
  with copy/download acknowledgement before dismissal.
- The standalone API Keys destination has **Create API key** as its primary
  action. Its focused workflow selects organization, active service account,
  human-readable key name, environment, searchable scopes, optional expiration,
  and optional network restrictions. Scope choices display only effective
  authority and explain unavailable choices. The form starts with no scopes
  selected and never defaults to broad access.
- Successful creation replaces the form with a dedicated one-time secret view,
  not a transient toast. It provides copy and secure-download actions, clearly
  identifies the key and environment, requires a stored-secret acknowledgement,
  and warns that closing it is irreversible. An idempotent retry cannot create a
  duplicate key.
- API-key row selection opens detail with **Overview**, **Scopes**, **Usage**,
  **Rotation**, and **Audit** tabs. Organization and service-account display
  names are primary; stable IDs remain copyable secondary values. Authorized
  actions are edit safe metadata/restrictions, rotate with a selected overlap,
  and revoke immediately. Scope widening uses replacement/rotation rather than
  in-place authority escalation, and revoked keys remain historical records.
- **Delete service account** is available from detail and the row action menu.
  Its danger dialog previews active keys, roles, recent use, and known
  dependencies, then requires the service-account name and a reason. Completion
  revokes every credential immediately and tombstones the account; audit and
  usage history remain inspectable through a **Show deleted** filter.
- Role changes preview permission loss and key-scope effects before submission.
  Partial key-revocation failure leaves the account non-authenticating, reports
  the failed cleanup safely, and schedules/requires reconciliation rather than
  restoring access.
- Platform management actions require tenant context and the narrow permissions
  in the administration specification. Emergency revoke remains distinct from
  create/edit/delete. Platform key minting requires the separate
  `platform.tenant_api_keys.manage` permission, phishing-resistant step-up,
  reason, and one-time presentation; otherwise its command and button are absent.
- Bindings: `f` filters, `j/k` moves rows, Enter opens detail, `n` creates, `e`
  edits metadata/roles, `s` suspends or reactivates after confirmation, `m`
  mints a key only when authorized and detail has focus, `r` revokes a selected
  key, and `Delete` opens the typed deletion confirmation.

### 11.11 Webhooks

- Name the destination **Webhooks**, not **Webhook delivery**: endpoints are the
  primary resources and deliveries are their operational history.
- Make **New webhook** the primary action. Its compact workflow asks for
  organization, name, HTTPS endpoint URL, and searchable event subscriptions,
  with description and timeout under optional settings. It starts with no event
  types selected and explains that selecting all current events does not include
  future event types automatically.
- Creation ends in a dedicated one-time signing-secret view with copy and
  secure-download actions plus irreversible-dismissal acknowledgement. An
  idempotent retry cannot create a duplicate endpoint. Secret values never
  appear in tables, subsequent detail views, logs, or toasts.
- Use a server-paginated master-detail endpoint table with tenant display name,
  endpoint name and sanitized URL, state, health, subscribed-event count, failed
  deliveries in 24 hours, last success, and action menu. Row click and Enter open
  detail rather than depending on a small unlabeled control.
- Endpoint detail tabs are **Overview**, **Event subscriptions**,
  **Deliveries**, **Signing secret**, and **Audit**. Authorized actions include
  edit metadata/URL/timeout, change event subscriptions, send a marked test,
  pause/resume, disable, rotate the secret with bounded overlap, and replay an
  eligible delivery. Deliveries show safe attempt classifications and correlation
  data, never payloads, headers, response bodies, or credentials.
- **Delete webhook** is available from detail and the row menu. Its danger
  dialog previews pending deliveries, recent use, and the effect on subscribed
  events, then requires the endpoint name and a reason. Completion disables and
  tombstones the endpoint, prevents queued workers from sending, and preserves
  delivery/audit history behind **Show deleted**.
- Tenant-context administrators receive create/edit/delete/rotate actions only
  when the session contains the corresponding `organization.webhooks.*`
  permissions. Cross-tenant `platform.webhooks.*` inspection, emergency-disable,
  and replay permissions do not silently grant endpoint configuration authority.
- Bindings: `f` filters, `j/k` moves rows, Enter opens detail, `n` creates, `e`
  edits, `p` pauses/resumes, `t` sends a test, `r` replays a selected eligible
  delivery, and `Delete` opens typed deletion confirmation. Secret rotation is a
  named command requiring step-up and is not assigned an easy accidental hotkey.

### 11.12 Notifications

- The Notifications destination opens on **Streams**, not delivery history. A
  notification stream is the stable contract behind
  `ctx.notifications.send({ type, recipient, data })`: it defines accepted data,
  channel routing, templates, preference policy, grouping, deduplication, and
  scheduling behavior.
- Make **New stream** the primary action. The first step asks only for name and
  immutable type key, then creates a draft and opens its editor. The guided
  editor configures input schema and recipient types, selects channels, maps
  templates and variables, chooses parallel/fallback routing, defines preference
  and mandatory/transactional policy, and configures optional grouping,
  deduplication, delay, and digest windows.
- The stream table shows human name, type key, state, active version, configured
  channels, preference policy, configuration health, last published, and known
  call-site count. Row click and Enter open stream detail.
- Stream detail tabs are **Overview**, **Inputs**, **Channels & routing**,
  **Templates**, **Preferences**, **Test**, **Deliveries**, and **Audit**. Channel
  cards explain which setup-owned provider adapter will deliver them; provider
  credentials stay in `trestle setup` and are never entered into a stream.
- The template editor provides channel-specific preview, required-variable
  validation, accessible plain-text fallback where applicable, and a safe test
  payload. **Send test** requires an explicit test recipient, is visibly marked
  in history, and never changes production preference or deduplication state.
- Publishing validates the complete contract and makes an immutable active
  version. Editing an active stream creates a draft version; existing queued
  notifications retain their recorded version. Drafts may be deleted when
  unreferenced. Published streams are archived, not hard-deleted, and new sends
  to an archived key fail with an actionable configuration error.
- A secondary global **Deliveries** tab retains type/channel/status filters,
  grouping count, scheduling state, safe recipient identity, and correlation
  identifiers. Platform views MUST not expose rendered title/body, template data,
  links, or provider payloads without a separately declared content permission.
  Retry and cancellation remain operations on eligible deliveries, not the
  organizing purpose of the page.
- Stream creation/edit/publish/archive requires
  `platform.notification_streams.manage`; read-only inspection requires
  `platform.notification_streams.read`. Tenant notification permissions control
  tenant preferences and delivery visibility, not project-wide stream schemas.
- Bindings: `f` filters, `j/k` moves streams, Enter opens detail, `n` creates a
  stream, `e` edits into a draft, `p` opens publish review, `t` opens Send test,
  and `a` opens archive confirmation. Delivery-tab bindings scope `r` to retry
  and `c` to cancel so those commands cannot fire from stream configuration.

### 11.13 Email

- Use a compact table and Kumo status badges.
- Recipient remains masked; bodies, links, and tokens remain absent.
- Correlation IDs use `InlineCopyText` or `ClipboardText`.
- Bindings: `f`, `j/k`, Enter for safe detail, `r` refresh.

### 11.14 Async operations

- Use summary cards plus a dead-letter table.
- Dead-letter detail uses `LayerDialog` or a detail route; errors remain
  categorized and redacted.
- Bindings: `j/k`, Enter, `r` redrive, `Shift+R` refresh all state.

### 11.15 Artifacts

- Use a searchable compact table with content type, size, retention, and deletion
  state.
- No object contents or signed URLs are added by this redesign.
- Bindings: `f`, `j/k`, Enter for metadata detail.

### 11.16 Audit

- Audit is a full-width, server-paginated table. It MUST NOT reserve page width
  for a persistent detail pane, empty selection card, or usage instructions.
  Before selection, every pixel below the filters belongs to the table.
- Filters occupy a responsive toolbar above the table. At narrower widths they
  wrap into additional rows rather than shrinking the data columns. Filter and
  pagination state live in the URL; event selection need not remain visible in
  the base layout.
- Default columns are **When**, **Event**, **Actor**, **Organization**,
  **Result**, and **Correlation**. Timestamp, result, and identifier cells never
  wrap word-by-word. The timestamp has a stable minimum width and renders on one
  line at desktop widths. Event and actor columns have readable minimum widths;
  internal IDs may truncate with a tooltip/copy action, not force neighboring
  columns into unusable slivers.
- If the viewport cannot satisfy those minimums, use deliberate horizontal table
  scrolling or hide lower-priority columns behind the row detail. Do not squeeze
  every column into the viewport. The Organization cell uses its display name as
  the primary value and its stable ID only as secondary copyable metadata.
- Clicking a row or pressing Enter opens event detail in a `LayerDialog`, modal
  drawer, or dedicated route layered over the unchanged full-width table. Detail
  includes safe summary, actor/principal, tenant, target, reason, result,
  before/after redacted values, correlation, support session, environment, and
  timestamps. Closing detail restores focus to the originating row.
- Correlation and support-session IDs are copyable and navigable from both the
  row and detail. The page contains no instructional card explaining that a user
  must select an event; row affordance, cursor treatment, and accessible labels
  communicate that interaction.
- Bindings: `f` focuses filters, `j/k` moves rows, Enter opens detail, `c` copies
  correlation ID, and `s` opens the associated support session.

### 11.17 Support sessions

- Add Active and History tabs.
- Show operator, tenant, profile, requested permissions, denied permissions,
  reason, ticket, start, expiry, end reason, and linked audit activity.
- Starting a session requires organization, profile, reason, optional ticket,
  duration, and a preflight effective-access preview.
- Revocation of another operator's session is a separately permissioned,
  destructive action.
- Bindings: `f`, `j/k`, Enter, `n` start session, `x` exit own session, `r` revoke
  selected session when authorized.

### 11.18 Authentication configuration

- Add **Authentication** under System as the single configuration destination.
  It is a Trestle UI over Better Auth capabilities and Trestle policy, not a
  redirect to a competing Better Auth administration surface.
- Begin with an environment posture header showing active policy version,
  configured methods, MFA posture, session posture, provider/setup health, last
  change, and warnings. Every setting identifies its owner/source as **Runtime
  policy**, **Setup**, **Environment**, or **Better Auth default**.
- Use tabs for **Overview**, **Sign-in methods**, **Registration & verification**,
  **MFA & step-up**, **Sessions**, **Organizations**, **Enterprise identity**,
  **Email flows**, and **History**. Hide enterprise-only tabs when the capability
  is absent, but summarize them as optional setup capabilities on Overview.
- Setup/deployment-owned settings are readable but not editable as ordinary form
  fields. Their cards show safe readiness, callback/origin metadata, missing
  requirements, and an exact copyable `trestle setup` command. Secrets are never
  prefilled, displayed, or accepted by this view.
- Runtime-policy edits create a draft. A persistent draft bar exposes
  **Discard**, **Validate**, and **Review & activate**. Review uses a semantic diff
  with affected-user/admin counts, unenrolled-factor warnings, session effects,
  missing email flows, unconfigured provider dependencies, and rollout behavior.
- Activation requires a reason and appropriate step-up. High-risk changes use
  phishing-resistant step-up and, where configured, second-administrator
  approval. The activation control remains disabled with a specific explanation
  when lockout prevention or dependency validation fails.
- History lists immutable policy versions, actor, reason, environment, outcome,
  and impact summary. **Roll back** creates a reviewed draft from a previously
  valid version; it never mutates history or accepts arbitrary browser state.
- **Account Security** remains a neighboring destination for the current
  operator's TOTP, backup codes, passkeys, trusted devices, and session assurance.
  It contains no application-wide sign-in, provider, registration, MFA, or
  session-policy controls.
- Bindings: `e` edits runtime policy, `v` validates, `p` opens activation review,
  and `r` opens rollback review while History has a selected version. All are
  view-scoped and permission-aware.

### 11.19 Account security

- Preserve the operator's current factor-enrollment workflows but group them as
  **Current session**, **Authenticator app**, **Passkeys**, **Recovery**, and
  **Other sessions**. Never expose a TOTP setup key or backup codes after their
  one-time enrollment/recovery presentation.
- Explain assurance in terms of the active authentication policy and link to
  Authentication only for operators with `platform.authentication.read`.
- Bindings remain scoped to personal actions such as adding a passkey; they
  cannot invoke system-policy mutations.

### 11.20 Health

- Use Kumo `LayerCard`, `Badge`, `Banner`, and `Collapsible` for checks and repair
  detail.
- Failed checks precede degraded and healthy checks.
- Repair commands are copyable but never executed from the browser.
- Bindings: `j/k`, Enter to expand, `r` refresh.

## 12. Extensibility contract

Consumer-provided views remain file-convention extensions under
`src/views/<view>/admin-view.ts` and `view.tsx`.

The descriptor MUST grow to support:

```ts
type AdminViewDescriptor = {
  id: string;
  path: string;
  navigation: {
    label: string;
    group: string;
    order: number;
    icon: Icon;
  };
  permission: string;
  capability?: CapabilityId;
  component: AdminComponentLoader;
  commands: readonly AdminCommandDefinition[];
};
```

Rules:

- Every view MUST declare at least one open/navigation command.
- Every interactive view MUST declare its primary action commands.
- Icons MUST come from `@phosphor-icons/react` unless the consumer supplies an
  accessible, theme-compatible icon component.
- Extension views MUST use Kumo or the Trestle Kumo adapters by default.
- The build checker MUST report raw color classes, missing command declarations,
  hotkey conflicts, unknown permissions/capabilities, missing icons, missing
  component exports, and routes without corresponding backend policy evidence.
- Trestle MUST document an escape hatch for truly custom visualization content,
  but the surrounding page frame, feedback, forms, and actions still follow this
  specification.

## 13. Accessibility and responsive behavior

- Conformance target is WCAG 2.2 AA.
- Every page MUST work at 320 CSS pixels without horizontal page scrolling;
  tables may scroll inside their own labeled region.
- Pointer-only hover interactions are forbidden.
- Focus indicators MUST use Kumo tokens and remain visible in every mode.
- Focus order MUST follow visual order.
- Overlays MUST trap and restore focus through Kumo/Base UI.
- Status changes, loading completion, and mutation outcomes MUST be announced.
- Reduced-motion preferences MUST be respected.
- Color MUST not be the only status signal.
- Shortcut help MUST show platform-correct key labels and only commands currently
  available to the operator.

## 14. Loading, empty, error, and mutation states

Every resource surface MUST define:

- initial loading skeleton or loader;
- empty state with a meaningful next action when one exists;
- permission-denied state without a pointless retry action;
- unavailable/unconfigured capability state with the exact setup command;
- retryable transport/server failure with correlation ID where available;
- mutation-in-progress disabled state;
- complete success state;
- partial-success state preserving failed targets;
- stale/background refresh treatment that does not replace usable data with a
  blank loader.

Kumo `Banner`, `Empty`, `Loader`, button loading states, and toast components
SHOULD implement these states through the Trestle adapter layer.

## 15. Testing and release gates

### 15.1 Static/build gates

The generated admin build MUST fail when:

- a raw color utility appears in admin TSX/CSS outside an explicitly approved
  compatibility file;
- a deprecated Kumo prop or component is used;
- a view lacks icon or navigation command metadata;
- a primary/destructive action lacks a command;
- hotkeys conflict in overlapping scopes;
- a destructive command does not resolve to confirmation;
- a command names an unknown permission, capability, route, or action handler;
- a Kumo stylesheet/source directive is missing or in the wrong order.

### 15.2 Component tests

Test the Trestle adapters rather than retesting Kumo internals:

- status-to-variant mappings;
- query-state transitions;
- table active-row and selection behavior;
- URL state synchronization;
- confirmation, step-up, and partial failure;
- permission/capability command filtering;
- command scope precedence and cleanup on unmount;
- one-field plan creation, derived-key validation, duplicate handling, and
  focus transfer into the new draft editor;
- entitlement explorer organization selection, complete-catalog filters,
  provenance layers, usage meters, and Current-versus-Proposed comparison that
  performs no mutation;
- custom organization/application role creation, descriptions, plane-filtered
  permission selection, member/service-account assignment, protected built-ins,
  impact confirmation, and directory-owned assignment behavior;
- admin-defined permission creation, immutable code/plane behavior, same-plane
  role assignment, honest zero-enforcement state, impact-aware editing,
  deprecation, and protected-definition behavior;
- service-account creation without implicit key minting, detail inspection,
  metadata and application-role editing, effective-authority explanation,
  suspend/reactivate, standalone named-key creation, authority-bounded scope
  selection, idempotent minting, one-time key presentation, API-key detail,
  rotation, immediate credential revocation, tombstoned account deletion,
  duplicate-name handling, and retained audit history;
- webhook creation, event selection, one-time signing-secret presentation,
  idempotent retry, endpoint editing and testing, pause/resume, bounded secret
  rotation, delivery replay lineage, queued-send cancellation, tombstoned
  deletion, and retained safe delivery/audit history;
- notification-stream draft creation, immutable key and published versions,
  typed inputs, channel routing, template-variable validation, preference and
  mandatory policy, grouping/deduplication, safe tests, publish diffs, archival,
  and separation between stream configuration and delivery operations;
- audit full-width layout, non-wrapping timestamp and identifier cells, minimum
  readable column widths, responsive filter wrapping, horizontal overflow, and
  on-demand detail that restores row focus;
- authentication effective-value/source rendering, setup-owned read-only states,
  runtime draft validation and semantic diff, provider dependency checks,
  session impact, lockout rejection, step-up, activation, rollback, environment
  isolation, and separation from personal Account Security;
- support-context expiration and revocation.

### 15.3 Keyboard integration matrix

For every default view, browser tests MUST prove:

1. its global `g …` sequence navigates correctly;
2. `f` focuses its primary filter when present;
3. `j/k` moves the active row when a resource list exists;
4. Enter opens/selects the active row;
5. its declared primary action shortcut opens the correct workflow;
6. its destructive shortcut opens confirmation and cannot bypass the reason;
7. bindings do not fire while typing;
8. disabled-by-permission and disabled-by-capability commands do not fire or
   appear in help;
9. Escape closes only the topmost overlay and restores focus;
10. commands unregister when navigating away.

### 15.4 Visual and accessibility gates

- Capture light and dark screenshots at desktop, tablet, and mobile widths for
  shell, table, form, dialog, empty, error, production, and support-context
  states.
- Capture Audit at desktop and tablet widths with long event names, actor IDs,
  tenant names, and timestamps; fail the visual gate if a permanent detail pane
  appears or core cells collapse into word-by-word wrapping.
- Run automated accessibility checks on every default route and every overlay.
- Manually complete the critical workflows using only a keyboard and a screen
  reader before beta.
- Verify 200% zoom and reduced-motion behavior.
- Run the full generated-project `pnpm check`; template-source-only checks do not
  satisfy release acceptance.

## 16. Migration sequence

### Phase 0 — Stabilize contracts

- Repair permission and support-session schema drift.
- Add missing Authentication, Webhooks, Notifications, and Support Sessions
  route/API contracts.
- Establish generated-project tests as a clean baseline.

### Phase 1 — Foundation

- Add Kumo and Phosphor dependencies.
- Install CSS in the required order.
- Add providers, router link bridge, semantic adapter layer, and root isolation.
- Add lint/build gates for Kumo tokens and deprecated APIs.

### Phase 2 — Shell and commands

- Replace sidebar, drawer, top bar, breadcrumbs, banners, operator menu, command
  palette, shortcut overlay, and confirmation dialog.
- Implement scoped command registration and collision validation.
- Add URL-backed global search and selection.

### Phase 3 — Resource primitives

- Replace query states, sections, badges, fields, data tables, pagination, row
  selection, action menus, meters, and toast feedback.
- Prove keyboard behavior on one read-only and one destructive resource page.

### Phase 4 — All default views

- Migrate every screen in Section 11.
- Add Authentication, Webhooks, Notifications, and Support Sessions.
- Remove the legacy visual classes and manual modal implementation.

### Phase 5 — Extension and hardening

- Update `trestle generate admin-view` to emit Kumo and command metadata.
- Update build-time view validation and documentation.
- Complete browser, visual, accessibility, and generated-project verification.

The migration MUST be performed as coherent vertical slices. A route is migrated
only when its presentation, keyboard commands, URL state, loading/error states,
authorization behavior, and tests all meet this specification.

## 17. Definition of done

The migration is complete only when all of the following are true:

- every shipped admin route renders through Kumo or the approved Trestle Kumo
  adapters;
- no legacy visual primitive or raw palette class remains in active admin code;
- every default and consumer-generated view has icon and command metadata;
- every primary and destructive workflow is keyboard-operable and command-palette
  discoverable;
- every declared TanStack binding is permission-, capability-, route-, overlay-,
  input-, and target-aware;
- sidebar, palette, dialogs, menus, forms, tables, and toast behavior remain
  accessible in light and dark modes;
- support context is server-authoritative, visually persistent, time-boxed, and
  attributed in audit/outbox records;
- Authentication, Account Security, Webhooks, Notifications, and Support
  Sessions have complete, correctly separated admin destinations;
- the extension mechanism renders consumer views indistinguishably from built-in
  views while preserving authorization boundaries;
- generated-project typecheck, unit, integration, browser, accessibility, visual,
  and production build gates pass.

## 18. Authoritative Kumo references

- [Kumo repository](https://github.com/cloudflare/kumo)
- [Kumo usage guide at the reviewed commit](https://github.com/cloudflare/kumo/blob/462516f9b75489c45a68aff26d3cd6ce66de5c49/packages/kumo/ai/USAGE.md)
- [Kumo Sidebar implementation](https://github.com/cloudflare/kumo/blob/462516f9b75489c45a68aff26d3cd6ce66de5c49/packages/kumo/src/components/sidebar/sidebar.tsx)
- [Kumo Command Palette implementation](https://github.com/cloudflare/kumo/blob/462516f9b75489c45a68aff26d3cd6ce66de5c49/packages/kumo/src/components/command-palette/command-palette.tsx)
- [Kumo semantic theme](https://github.com/cloudflare/kumo/blob/462516f9b75489c45a68aff26d3cd6ce66de5c49/packages/kumo/src/styles/theme-kumo.css)
- [Kumo page-header block](https://github.com/cloudflare/kumo/blob/462516f9b75489c45a68aff26d3cd6ce66de5c49/packages/kumo/src/blocks/page-header/page-header.tsx)
- [Kumo resource-list block](https://github.com/cloudflare/kumo/blob/462516f9b75489c45a68aff26d3cd6ce66de5c49/packages/kumo/src/blocks/resource-list/resource-list.tsx)

If the pinned Kumo version changes, this specification's component API, CSS
installation, deprecated API list, screenshots, and keyboard integration MUST be
revalidated before updating the generated template.
