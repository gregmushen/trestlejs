# Platform admin

`apps/admin` is the optional, separately deployed platform control plane. It is
two deployables that share this package:

- `src/`: a React SPA (TanStack Router and Query) served from its own origin.
- `worker/`: a Hono Worker for `/api/admin/*` and operator sign-in at
  `/api/auth/*`, configured by `wrangler.jsonc`.

The Worker connects to PostgreSQL through `PLATFORM_DATABASE_URL`, a login that
is granted only the `trestle_platform` role. That role can read across tenants,
but grants never expose session tokens, passwords, API-key verifiers, or
application-role writes. Every mutation requires a platform permission, a
written reason, and recent sign-in evidence (step-up). Each mutation
commits with an audit record and an outbox event.

Authentication alone grants nothing. Operators need an explicit
`platform_role_assignment`, and organization or application roles never confer
platform authority.

The step-up window defaults to 15 minutes. It is one of the runtime
authentication settings under System → Authentication, where safe policy is
versioned, checked against lockout safeguards, and rolled back. Providers,
secrets, origins, and cookies stay with `trestle setup`.

## Design system

The admin is built on [Kumo](https://github.com/cloudflare/kumo)
(`@cloudflare/kumo` 2.14.0, pinned) and Phosphor icons. Kumo supplies
presentation and widget accessibility: focus trapping, menus, dialogs, and
ARIA. Trestle adds a thin semantic layer in `src/shell`:

- **`shell/kumo.tsx`** is the single import point for Kumo components.
- **`shell/ui.tsx`** holds the Trestle adapters:
  - `AdminPageHeader`, `AdminSection`, and `AdminQueryState` for page
    structure and loading, empty, error, and denied states;
  - `AdminStatus` for domain states mapped to semantic variants;
  - `AdminDataTable`, a keyboard-operable table with URL-backed selection and
    paging;
  - `AdminFilter` for the page filter, bound to `f`;
  - `AdminForm`, which submits with Mod+Enter;
  - `AdminStat`, `AdminUsageMeter`, and `AdminCopy`.
- **`shell/ConfirmAction.tsx`** provides `useConfirmAction()`, the only way to
  run a sensitive action. It handles the reason, step-up, partial failure, and
  focus restoration.
- **`shell/pickers.tsx`** and **`shell/feature-editor.tsx`** provide
  searchable organization and user comboboxes, and typed feature controls.
- **`src/blocks/`** holds Kumo's page-header and resource-list blocks,
  installed as Trestle-owned source.

Colors use Kumo semantic tokens only (`bg-kumo-base`, `text-kumo-subtle`, and
so on). Light and dark mode come from `data-mode`, never `dark:` classes. The
build (`scripts/check-admin-views.ts`) fails on:

- raw palette classes;
- `dark:` variants;
- the legacy `panel`, `button`, and `input` classes;
- deprecated Kumo APIs;
- Cloudflare branding components;
- a stylesheet that loses Kumo's required `@source` → `@import
  "@cloudflare/kumo/styles"` → `@import "tailwindcss"` order.

Custom visualizations may render their own content inside an `AdminSection`.
The page frame, feedback, forms, and actions still use the adapters.

## Adding a view

Views are discovered by file convention. Add a directory under `src/views`:

```text
src/views/contracts/
  admin-view.ts
  view.tsx
```

```ts
import { FileTextIcon } from "@phosphor-icons/react";

import { defineAdminView } from "../../registry";

export default defineAdminView({
  id: "contracts",
  path: "/contracts",
  navigation: { label: "Contracts", group: "Customers", order: 40, icon: FileTextIcon },
  permission: "platform.organizations.read",
  component: () => import("./view"),
  commands: [
    { id: "contracts.open", label: "Go to Contracts", hotkey: "g v" },
    { id: "contracts.cancel", label: "Cancel the selected contract", hotkey: "c", kind: "action", scope: "selection", requires: "a contract", destructive: true, permission: "platform.contracts.manage" },
  ],
});
```

Or generate one with `pnpm exec trestle generate admin-view Contracts --group
Customers --permission platform.organizations.read --icon FileTextIcon`.

`pnpm build` runs `scripts/check-admin-views.ts`. It fails on:

- duplicate ids or paths;
- permissions that are unknown or not in the platform plane;
- unknown entitlement or capability codes;
- invalid navigation groups;
- missing icons;
- views without a navigate command;
- components that do not resolve to a default-exported React component;
- the command and design rules below.

Add navigation groups in `src/navigation.ts`; consumer views render through
exactly the same sidebar path as the defaults. A view may also declare an
`overviewCard`.

Registering a view grants no backend authority. Hiding a navigation item is a
usability behavior, not a security boundary. Every `/api/admin` route enforces
its own platform permission, declared in `worker/route-policies.ts`, and a
test fails if a route lacks a policy.

## Commands and keyboard

The sidebar is the discoverable interface; the command registry is the expert
interface. The palette (⌘K), the shortcut reference (`?`), row action menus,
and hotkeys all run the same mounted handler.

| Field | Meaning |
| --- | --- |
| `kind` | `navigate` (default) opens the view; `focus` moves focus; `action` runs a handler |
| `scope` | `global` for navigation; `view` works on the view; `selection` needs a selected resource and says what in `requires` |
| `destructive` | The handler may only open a confirmation, registered as `confirm:` |
| `hotkey` | A chord (`Mod+Shift+R`) or sequence (`g v`), handled by TanStack Hotkeys and ignored while typing |
| `permission`, `capability` | Default to the view's; commands the operator cannot run are neither listed nor bound |

Implement action and focus commands in the view:

```tsx
const confirm = useConfirmAction();
useAdminCommands({
  "contracts.cancel": { enabled: Boolean(selected), target: selected?.id, confirm: () => confirm.open(cancel(selected!)) },
});
```

The build rejects:

- action commands without a handler in the view source;
- destructive commands not registered with `confirm:`;
- a global sequence that is a prefix of another;
- a view key that collides with a global binding, the first key of a `g`
  sequence, or the reserved keys.

The reserved shell keys are ⌘K, `/`, `?`, Escape, and `[`. The reserved
resource keys are `f`, `j`, `k`, Enter, Space, Shift+A, Mod+Enter, and
Mod+Shift+Enter. The same single key may be reused on different views.

Filters, the selected resource, tabs, and pages live in the URL (`?q=`,
`?selected=`, `?tab=`, `?page=`), so back, forward, and shared links restore
the view. Never put secrets in URL state; `sanitizeSearch` drops anything but
short tokens.

## Testing

- `pnpm test` runs the registry, adapter, and Worker integration tests.
- `pnpm build` runs the view, command, and design gates.
- `pnpm test:keyboard` runs the keyboard matrix in headless Chrome against a
  running `trestle dev`. It covers every view's navigation, filter focus, row
  movement and selection, the guarded destructive shortcuts, and command
  cleanup. Set `CHROME_PATH`, `ADMIN_URL`, `ADMIN_USER`, and `ADMIN_PASSWORD`
  as needed.

## Support sessions

Operators with `platform.support.enter_tenant` start a support session from an
organization's page. A session needs:

- a reason, and optionally a ticket;
- a duration of 15 to 240 minutes;
- an application-owned support profile from `packages/authz/src/support-profiles.ts`.

The dialog previews every organization and application permission the profile
grants or denies in that tenant. The platform permission only lets you start a
session; the profile's permission snapshot is the only tenant authority, and
only until the session ends.

While a session is active:

- A banner shows the tenant, operator, reason, and countdown.
- Support Workspace acts through the tenant's own services under forced RLS.
- Every audit record and event carries the operator, the session ID, and the
  reason.

Profiles can never grant secret-revealing permissions, and support routes
never return secrets.

Starting a new session ends the current one. Revocation
(`platform.support.revoke`) and expiry take effect on the next request, and
the SPA drops that tenant's cached data. User impersonation is a separate
capability and is not generated.

## Local development

`trestle dev` starts the SPA on `http://localhost:42070` and the Worker on
`http://localhost:8788`. It also seeds a local operator, `admin` / `admin`
(`admin@trestle.local`), with every platform role. The seed script and the
Worker both refuse that account outside the local environment. To grant a
platform role to another local user:

```sql
insert into platform_role_assignment (user_id, role, granted_by, reason)
values ('<user id>', 'security_admin', 'bootstrap', 'local development');
```

## Deploying

Deploy the SPA and the Worker on the admin origin, and route `/api/*` on that
origin to the admin Worker so operator cookies stay on the admin origin. Set
`ADMIN_ORIGIN` for each environment in `wrangler.jsonc`, and push its secrets
with `pnpm exec trestle secrets push --env <env>`, which also projects secrets
declared with `target: admin` or `shareWith: [admin]`.
