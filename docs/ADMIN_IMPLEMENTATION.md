# Administration and Access Control: Implementation Status

This document maps the [Administration and Access Control Specification](ADMIN_SPEC.md)
to the implementation on `milestone/admin-access-control`. Template paths are
relative to `packages/create/template`. The specification remains the source of
intent. This page records what exists, what evidence covers it, and what does
not exist yet.

## Summary

| Delivery slice (§18) | Status |
| --- | --- |
| 1. Setup console foundation | Implemented |
| 2. Admin foundation | Implemented; deployment workflows pending |
| 3. Authorization (three planes) | Implemented |
| 4. Commercial control plane | Implemented for local and Stripe; Lago pending |
| 5. Machine access | Implemented |
| 6. Operational depth | Implemented for email status, jobs, artifacts, and audit; Lago views pending |
| Additions: webhooks, notifications, support sessions ([spec](ADMIN_ADDITIONS_SPEC.md)) | Implemented |
| 7. Beta hardening | Partial: real-PostgreSQL and HTTP-level suites exist; browser and deployed-system suites pending |

## Where each part lives

| Spec | Implementation |
| --- | --- |
| §3.4, §4 setup console | `packages/cli/src/setup/*`. The console is loopback-only on a random port, with a one-time token exchanged for an HttpOnly SameSite=Strict cookie. It checks Host and Origin, requires CSRF on every POST, sends a strict CSP, and closes after 60 minutes idle. Secrets are encrypted on submit, and responses carry only an 8-hex fingerprint. The flags are `--no-open`, `--resume`, `--plan-only`, and `--env`. |
| §5 capability lifecycle | `trestle capabilities` (`packages/cli/src/capabilities.ts`) plus a Doctor capability group. The deployed and verified states come only from non-secret `.trestle/evidence/<env>.json`. At runtime, the customer Worker reports a sanitized `capability_status` projection (`apps/worker/src/capability-report.ts`), and admin reads it and shows `trestle setup --env <env>` repairs. |
| §6 identities and planes | `packages/authz/src/access.ts`. Identity types are user, service account, and system. `AccessSubject.authority` holds separate organization, application, and platform permission maps. |
| §7 permissions and roles | Every permission declares one `plane` in `packages/authz/src/permissions.ts`, and prefixes are validated. `role-definitions.ts` defines organization roles (owner, admin, billing_admin, member), application roles (app_admin, editor, publisher, reader, plus custom roles gated by `roles.custom`), and platform roles (support, billing_operations, platform_operator, security_admin). The only cross-plane rule is `policies.ts`: an organization's creator also becomes its application administrator, applied once by a Better Auth hook. |
| §7.3 application-role assignments | The `application_role_assignment` table (forced RLS) is separate from Better Auth `member.role`. Custom roles live in `application_role`. |
| §8 service accounts and API keys | `packages/authz/src/api-keys.ts` and `packages/domain/src/access/services.ts`. Keys use the `tr_<live\|test\|dev>_<publicId>_<secret>` format, are returned once, and are stored only as a SHA-256 verifier. Scopes must be application-plane and at most the service account's authority. Keys can carry expiry, CIDR restrictions, a per-key rate limit, and a plan `maxKeys` cap. Rotation has a bounded overlap of at most 168 hours, and revocation is audited. Authentication uses the single-key SECURITY DEFINER `trestle_resolve_api_key`. |
| §9 plans and entitlements | `packages/billing/src`: typed privileges, immutable versioned plans (draft → active → grandfathered → retired), subscription overrides with reason and author, provenance-bearing effective entitlements, quotas, reconciliation, and transparency. The `plan_version` catalog is seeded by migration. Scheduled changes are applied by the admin Worker cron. |
| §9.6 usage | API-key requests increment the `api.requests` allowance. Hard quotas return 429 `quota_exceeded`. |
| §10 explainable access | `evaluateAccess` returns an `AccessDecision` with plane, assignments per plane, entitlement provenance, scope, credential, and constraints. The admin Effective Access Explorer calls `POST /api/admin/access/explain`. |
| §11 admin information architecture | `apps/admin`: collapsible sidebar and mobile drawer, environment badge, tenant-context banner, global search, 17 default views (including Organization, Application, and Platform Roles and Permissions), overview cards, and a build-time-validated view registry. See `apps/admin/README.md`. Views also register permission-aware commands and hotkeys (TanStack Hotkeys), which drive the ⌘K palette, `g`-prefixed navigation, and target actions. A support session scopes the tenant-bound views to its organization. |
| Additions §1 webhooks | The catalog in `packages/events/src/catalog.ts` registers events, and only those with a `webhook` projection are published. The domain code is in `packages/domain/src/webhooks`: URL policy, state machine, bounded retries, Standard Webhooks signing, and AES-GCM secret encryption. The repository is `packages/data/src/webhooks`. The customer routes are `apps/worker/src/webhook-routes.ts` (UI at `/settings/webhooks`). Platform routes (read, emergency disable, replay) are in `apps/admin/worker/communications.ts` (view: Integrations → Webhook Delivery). The platform role cannot read raw URLs, ciphertexts, or payloads, and replay runs through `trestle_replay_webhook_delivery`. |
| Additions §2 notifications | Definitions live in `packages/domain/src/notifications/definitions.ts`. Preference resolution is mandatory, then user, then organization default, then the definition default. Grouping and deduplication, the inbox, preferences, organization defaults, and delivery history are all implemented. Email is sent through `createApplicationEmail`. Admin views are Communications → Notifications and Email Delivery. Retry and cancel are available only where the definition exposes them. Titles and bodies are not granted to the platform role. |
| Additions §3 support sessions | `support_session` stores the reason, ticket, profile, frozen permission snapshot, expiry, and how the session ended. Profiles and the preview are in `packages/authz/src/support-profiles.ts`. The admin support routes, which check the active session on every request, are in `apps/admin/worker/support.ts`. The views are Support Sessions and Support Workspace. `audit_event.support_session_id` and outbox payloads record the session. |
| Outbox runner | `apps/worker/src/outbox-runner.ts` runs on the Worker cron trigger. It leases with SKIP LOCKED, fans out to webhooks and notifications, forwards to the queue when bound, and delivers due work found by the SECURITY DEFINER due-work functions, processing each item on its tenant's RLS connection. `trestle dev` fires the trigger every 3 seconds. |
| §12 customer transparency | `/settings/plan`, `/settings/members`, and `/settings/api-keys` in `apps/app`, backed by `GET /api/tenant/plan-usage` and `/api/tenant/access`. |
| §13 persistence | Migrations `0012_access_control` (forced RLS on every tenant table, `trestle_platform` role, column grants that exclude verifiers, session tokens, and passwords, the resolver function, and the plan seed) and `0013_operational_projections`. Tenant repositories are in `packages/data`, platform repositories in `packages/platform`. Every mutation commits with its audit row and outbox event, including on Neon HTTP, through `createSqlRunner().atomic`. |
| Email operations | `RecordingEmailService` records each send (template, masked recipient, provider, correlation, failure category) in `email_delivery`. Provider webhooks update its status. Content is never stored. |
| §14 audit | Semantic, versioned `audit_event` rows are append-only and grant only SELECT and INSERT. Tenants never see platform rows. |
| §16 CLI | The access commands are `trestle permissions/roles/entitlements`, `trestle admin install/doctor/views`, `trestle api-keys doctor`, and `trestle generate permission --plane / admin-view / admin-resource`. Inspection runs the project's `scripts/inspect-access.ts`. |

## Verification evidence

Run with `TRESTLE_RLS_TEST_DATABASE_URL` pointing at a migrated database.

| Spec §17 requirement | Test |
| --- | --- |
| No assignments means no authority; Owner, App Admin, and platform roles stay in their planes; no cross-plane role | `packages/authz/src/authz.test.ts`; `apps/worker/src/execution-context.test.ts`; `apps/worker/src/tenant-routes.integration.test.ts` |
| Tenant admins cannot escape their tenant; revoked or stale membership fails closed | `execution-context.test.ts`; `tenant-routes.integration.test.ts`; `packages/db/src/access-rls.integration.test.ts` |
| Platform operators need the exact permission; tenant selection grants nothing | `apps/admin/worker/index.integration.test.ts` |
| Scopes only reduce authority; expired, revoked, rotated, and wrong-environment keys fail closed | `authz.test.ts`; `execution-context.test.ts`; `tenant-routes.integration.test.ts`, which runs mint → use → rotate overlap → revoke over HTTP |
| Route metadata and enforcement do not drift | Route-drift tests in `tenant-routes.integration.test.ts` and `apps/admin/worker/index.integration.test.ts` |
| Unsubscribed tenants are not entitled; versions and overrides are explainable | `packages/billing/src/commercial.test.ts`; `packages/billing/src/repository.integration.test.ts` |
| Setup never persists or logs plaintext credentials | `packages/cli/test/setup.test.ts` scans every written file and response for a sentinel secret |
| Admin reports missing configuration with a setup command | `apps/admin/src/registry.test.ts`; `packages/platform/src/capabilities.ts` |
| A dropped-in view is discovered, routed, placed, permission-filtered, and survives apply | `apps/admin/scripts/check-admin-views.test.ts`; `packages/cli/test/access.test.ts` |
| Invalid descriptors fail the build | `check-admin-views.test.ts`, and the admin `build` script runs the check |
| Admin actions preserve validation, audit, events, and RLS | `packages/domain/src/access/services.test.ts`; `packages/data/src/access/postgres-tenant-access-repository.integration.test.ts`; admin Worker integration test |

## Browser evidence

The flows were driven in headless Chrome against a clean generated project
running under `trestle dev`, using the real UI and real data, with nothing
seeded except the local operator.

- **Customer additions:**
  - the notification bell and inbox, populated by the outbox;
  - a webhook endpoint whose secret is shown once;
  - a signed test event received by the local receiver;
  - a live `api_key.created` delivery;
  - a failing endpoint with a scheduled retry;
  - preferences with a locked mandatory channel;
  - mark all read.
- **Customer:** sign up, verify through the captured email, create an
  organization (including a slug collision), choose a plan, and view Plan &
  usage and Members. Then create a service account and mint a key that is
  shown once, and use that key against a generated resource: GET is allowed,
  a write is refused, and a forged key gets 401.
- **Admin:** sign in with admin/admin, then:
  - organization search and detail;
  - starting a support session with a previewed profile, acting in its
    workspace (audited as the operator with the session and reason),
    listing it with its activity, and exiting;
  - webhook delivery health, attempt history, and emergency disable;
  - notification channel states and preference resolution without content;
  - session revocation;
  - suspension, which blocks the customer's sign-in, and restoration;
  - drafting, editing, and activating a plan version;
  - adding an override, which appears in the customer's own plan document;
  - reconciliation and a scheduled change;
  - the entitlement provenance view and the access explainer;
  - revoking a key, after which requests with it fail with 401;
  - email delivery records and correlated audit events;
  - step-up re-authentication;
  - the ⌘K palette, sequence hotkeys, and the shortcut overlay.

## Kumo migration ([spec](ADMIN_KUMO_SPEC.md))

| Spec | Implementation |
| --- | --- |
| §5 dependencies and CSS | `@cloudflare/kumo` 2.14.0 and `@phosphor-icons/react` 2.1.10 are pinned. `styles.css` uses `@source` for Kumo's dist, then the Kumo styles, then Tailwind; the `@source` path was verified in a generated pnpm workspace (without it the CSS drops from 164 KB to 50 KB). The legacy component classes and raw palette are gone. |
| §6 providers | QueryClientProvider → LinkProvider (TanStack Router bridge) → KumoPortalProvider (`#admin-overlays`, isolated) → TooltipProvider → Toasty → ThemeProvider → AdminProvider → CommandProvider → Router (Sidebar.Provider in the shell). |
| §7 shell | Kumo Sidebar is registry-driven, with icons, a disabled "Setup" state that tooltips the repair command, and a persisted open state. The top bar has Kumo Breadcrumbs, a ⌘K trigger, the environment badge, and a DropdownMenu with the theme choice. Production and staging get a persistent strip. The support banner shows tenant, profile, operator, ticket, reason, countdown, and links to the session and workspace; it wraps on phones and clears when the server reports the session ended. The page frame uses the installed page-header and resource-list blocks in `src/blocks`. |
| §8 adapters | `shell/ui.tsx`, `shell/ConfirmAction.tsx`, `shell/pickers.tsx`, and `shell/feature-editor.tsx`. Adapters expose semantic variants only. |
| §9 commands | `AdminCommand` has `kind`, `scope`, `destructive`, `requires`, and `capability`. Mounted views register handlers with `useAdminCommands`; destructive ones only `confirm`. The dispatcher runs same-view handlers or opens other views with `?command=`. Selection commands without a target show "Select … first" and are not bound. Collision validation is scope-aware (`hotkeyConflicts`), and shortcuts ignore inputs and overlays; toasts are non-modal and never block shortcuts. |
| §10 URL state | `shell/url-state.ts`: `q`, `selected`, `tab`, `page`, `organization`, and view filters. Global search opens the organization or user selected. |
| §11 screens | All 21 default views are migrated, with the §11 bindings: organizations `e`/`x`, users `s`/`r`, plans `n`/`e`/`a`/`Shift+G`/`Shift+R`, subscriptions `o`/`c`/`r`, entitlements `s` plus Mod+Enter, platform roles `n`/`r`, permissions `x` plus Mod+Enter, service accounts `s`, API keys `r`, webhooks `d`/`r`, notifications `r`/`c`, email `r`, async `r`/`Shift+R`, audit `c`/`s`, support sessions `n`/`x`/`r`, workspace `p`/`t`/`r`, health `r`, overview `r`/`c`. Overrides, simulations, and plan drafts use typed controls from the feature catalog, and organization, user, and permission fields are comboboxes. |
| §12 extensibility | Descriptors require an icon and a navigate command. `trestle generate admin-view --icon` and `generate admin-resource` emit Kumo adapters and icon metadata. |
| §15 gates | `check-admin-views.ts` enforces: handler contract, `confirm:` for destructive commands, raw palette, `dark:`, legacy classes, deprecated or branded Kumo APIs, and CSS order. Tests: `registry.test.ts`, `check-admin-views.test.ts`, `shell/adapters.test.ts`. Browser: `pnpm --filter ./apps/admin test:keyboard` (98 checks across every view). |

Browser evidence for the migration:

- the keyboard matrix across all 21 views;
- the customer and admin functional flows, rerun on the Kumo UI, including
  support-workspace actions driven by selection hotkeys;
- light and dark screenshots at 1440, 820, and 390 px of the shell, tables,
  forms, dialogs, empty, not-found, and support-context states, with no
  console errors and no horizontal page overflow on phones.

## Required changes ([spec](ADMIN_REQUIRED_CHANGES.md))

| Spec | Implementation |
| --- | --- |
| §2 shared patterns | `shell/resource.tsx` adds `AdminDetailDrawer` (a side dialog bound to `?selected=` that returns focus to the originating row), `AdminFacts`, `AdminCreateDialog`, `OneTimeSecretDialog` (copy or download, shown once), and `keyFromName`. `AdminDataTable` gains `minWidth`, `nowrap`, `priority: "low"`, and `server` pagination. Confirmations (`useConfirmAction`) carry reason, step-up, scope, and fields. |
| §3.1 header geometry | The sidebar logo row and the top bar are both 48 px with one shared bottom rule. The top bar uses the content gutter (`px-4 lg:px-8`), so the collapse control and the page content start at the same x in both states. The collapsed rail shows only the mark. |
| §3.2 overview | `GET /api/admin/overview` returns `exceptions`, most severe first, each linked to its resource. They come from unhealthy or declared capabilities and from `PostgresPlatformRepository.overviewExceptions`: dead letters, failing or system-disabled webhooks, failed notification deliveries and email (24 h), reconciliation drift, past-due subscriptions, support sessions expiring within 15 minutes, and API keys expiring within 7 days. Each probe fails independently and is reported as its own exception. Healthy state is one compact section. |
| §4.1 plans | `POST /api/admin/plans` creates version 1 as a draft; the New plan dialog derives the key and opens the feature editor. |
| §4.2 Stripe mapping | `billing_provider_mapping` stores explicit links per environment: plan family → Product, plan version + offer → Price. `apps/admin/worker/billing-mappings.ts` connects an existing ID or creates the object in Stripe (REST, idempotency keys), then verifies it. Prices must be active and recurring, belong to the family's mapped Product, and match the environment's live or test mode. Without a Stripe key, mappings are saved `unverified`. The Worker resolves checkout prices from mappings (active version, `monthly` or unnamed offer) over `STRIPE_PRICES` (`packages/data/src/billing/provider-mappings.ts`). Webhook events resolve the plan and version from mapped Price IDs, never names or metadata when a mapping exists, and write `subscription_line` rows; unmapped prices are recorded as `unmapped:<price>`. The plan drawer has a Stripe section; the subscription detail has a Provider chain tab (environment, product, price, customer, subscription, lines, verification, and last reconciliation). |
| §4.3 entitlement explorer | `explainEntitlements` and `compareEntitlements` (`packages/billing/src/explorer.ts`) cover the whole catalog, so unavailable features are listed. Each value carries provenance (plan version or override). The view shows plan and subscription state, features filterable by state, usage with reset dates, active and scheduled overrides, and Compare changes (`POST /api/admin/entitlements/:organizationId/compare`), which writes nothing. |
| §5 roles and permissions | `buildAccessCatalog` merges the reviewed code catalog with runtime `access_permission` (grant-only, organization and application planes) and global `access_role` rows; it is loaded per request into `AppExecutionContext.accessCatalog`. Operators change tenant assignments through the tenant's own domain services on its forced-RLS connection, with `platform_operator` as the attributed actor and the reason recorded. An assigned role can be archived but not deleted. New platform permissions: `access_catalog.manage`, `tenant_access.assign`, `machine_access.manage`, `webhooks.manage`, `notification_streams.manage`, and `auth_policy.read`/`auth_policy.manage`. |
| §6 service accounts and API keys | Unique active names; deletion tombstones the account and revokes every key. Key creation takes a name and an idempotency key (a replay returns the same key and no second secret). Changing scopes issues a replacement (`replaced_by`); the active key is never mutated. |
| §7.1 webhooks | Create, edit, test, pause, resume, rotate (one-time secret), and delete (a tombstone that cancels pending deliveries) in `apps/admin/worker/webhooks.ts`. `trestle_due_webhook_deliveries` excludes deleted endpoints, so no Worker sends after deletion. Outside local, destinations are re-resolved over DNS-over-HTTPS and private addresses are refused. |
| §8.1 notification streams | `notification_stream` and `notification_stream_version` hold data-defined types: typed inputs, recipient kinds, routes, parallel or fallback delivery, user, organization, or mandatory policy, templates validated against the inputs, grouping, deduplication, delay, and email digest. `composeNotificationCatalog` adds active versions to the code catalog; code types always win. `ctx.notifications.send({ type, recipient, data })` validates recipient kind, membership, and data, and records `stream_version`. Archived and unknown types throw. Admin: Notifications opens on Streams (Deliveries is secondary), with New stream, a draft editor, preview, a marked test send, publish (the previous version is superseded), and archive or restore (`apps/admin/worker/streams.ts`). |
| §8.2 email delivery | The drawer shows provider-neutral status, the template, the masked recipient, attempts (from the linked notification delivery), correlation, safe failure category, and the provider event timeline. It never shows content. |
| §9 audit | Full width and server-paginated (`?page=`, 50 per page, with the total). Filters wrap above the table. Columns are When, Event, Actor (email when known), Organization (name), Result, and Correlation (low priority). The detail drawer loads the event by ID, so selection survives paging, and it restores focus on close. |
| §10 authentication | System → Authentication (`g t`). Runtime policy (`packages/auth/src/policy.ts`) covers password sign-in, registration mode (open, invite-only, closed), email verification, password length and reset, reset session revocation, trusted-device lifetime, step-up freshness, session lifetime, refresh, and concurrency, and organization creation, limits, invitation lifetime, and membership limit. `createAuth` applies it: invite-only through a `/sign-up/email` hook, and concurrency by revoking the oldest sessions at sign-in. The step-up window feeds `PlatformAuthority`. Policies are versioned in `auth_policy_version`: draft, validate, review impact, activate with reason and step-up, and roll back by activating a copy of a superseded version. Every setting shows its source (runtime version, Better Auth default, or Trestle default). Setup-owned settings are read-only, and secrets are shown only as configured or not. Safeguards refuse removing the last platform-admin sign-in path (no guardian with a passkey), removing the last recovery path, requiring an uninstalled factor or provider, and depending on unhealthy email. Isolates apply a new version within 10 seconds. |
| §11 extensibility | Setup, apply, and `admin install` write only the manifest, plan, and state. `packages/cli/test/access.test.ts` proves a generated and customized view, its navigation, and its permission are byte-identical after apply, `admin install`, and a refused re-generate. |

Evidence for these changes:

- `pnpm check` in a generated project (typecheck, every package's tests
  including PostgreSQL integration suites, build), repository `pnpm check`, and
  the generated-project canary.
- Integration: authentication policy activation, safeguard refusal, and rollback
  with audit; Stripe mapping verification rules against a fake catalog; signed
  Stripe events resolving plans from mapped prices and writing lines;
  `ctx.notifications.send` resolving and recording stream versions and refusing
  archived types and non-members.
- Browser (running `trestle dev`):
  - plans, permissions, roles, service accounts, and API keys (15 checks);
  - streams and webhooks (12), including a Svix-signed test delivery and no
    request within 75 seconds after deletion;
  - Stripe mapping and entitlements (7);
  - authentication policy (5), where the customer Worker refused sign-up while
    registration was closed, accepted it after reopening, and refused it again
    after rollback.
- A readability sweep over 17 views at 1440 px, 820 px, and 640 px (1280 px at
  200% zoom), with long organization and audit content: no page-level
  horizontal overflow and no one-word-per-line cells.

## Known gaps

- **Kumo migration.**
  - Production appearance was checked in code only; the local stack always
    runs as `local`.
  - Automated accessibility scanning (axe or similar) is not wired in, and
    the manual screen-reader pass is not done.
  - The keyboard matrix needs Chrome and a running `trestle dev`, so it is not
    part of `pnpm check`.
- **Additions.**
  - Webhook delivery runs from the cron trigger, not a Queue consumer.
  - Endpoints are never auto-disabled. They report `failing`, and admins are
    notified.
  - Notification streams support delay and email digest windows; code-defined
    notifications do not declare them yet.
- **Required changes.**
  - Stripe product and price creation and verification were exercised against
    a fake catalog only; no Stripe key is available in this environment.
  - Authentication policy does not force members to enroll a second factor;
    it governs step-up freshness, trusted devices, and recovery.
  - Support Workspace covers members, webhooks, notification history, and
    audit; add routes to `supportRoutePolicies` for more.

- **Deployment workflows.** The generated GitHub Actions do not yet build or
  deploy `apps/admin` (Pages plus Worker) or run `db:roles:configure-platform`.
  These files were being changed on another branch and were left untouched
  here, so acceptance criterion 2 is not yet demonstrable.
- **Lago payments.** Lago metering ships (see
  [INTEGRATION_IMPLEMENTATION.md](INTEGRATION_IMPLEMENTATION.md)), but the Lago
  payments adapter still does not: subscription synchronization and
  reconciliation support the local and Stripe providers only.
- **Step-up authentication** now reads recorded assurance evidence
  (password, MFA, or phishing-resistant, at most 15 minutes old), not session
  age. See [INTEGRATION_IMPLEMENTATION.md](INTEGRATION_IMPLEMENTATION.md).
- **API-key rate limits.** They are enforced per Worker isolate. There is no
  global limiter backed by Durable Objects yet.
- **Browser and deployed-system suites.** §17 browser and deployed evidence,
  plus the §19 deployed acceptance run, remain for the beta-hardening slice.
- **Existing projects.** `trestle admin install` declares the surface but does
  not copy the scaffold. Projects generated before this milestone must copy
  `apps/admin`, `packages/platform`, and migrations 0012 through 0018 from a
  fresh project.

## Port onto alpha 31

This work began on alpha 8 and was ported onto alpha 31. What changed in the port:

- **Migrations moved after `main`'s.** The admin migrations are now `0012` through `0017`,
  following `main`'s `0006` through `0011` (commercial control plane, application role,
  event inbox, and artifact lifecycle), with journal timestamps after `0011`.
- **The `plan_version` column is converted in place.** `0012_access_control` turns
  `organization_subscription.plan_version` from `main`'s integer into the
  `plan@version` text reference.
- **`0018_reconcile_authority` carries forward alpha data.**
  - `member.application_role` becomes `application_role_assignment` rows:
    `contributor` becomes `editor` and `viewer` becomes `reader`.
  - `organization_entitlement_override` rows move into `subscription_override`.
  - Both superseded structures are then dropped.
  - Forced RLS is relaxed for the owner only while the backfill runs.
  - Existing organization owners keep `editor`. `app_admin` is granted only to the
    creator of a new organization.
- **`AUTHORITY_MODEL_VERSION` is now 3.** `trestle upgrade` and `trestle generate
  resource` gate on it. Generated routes call `ctx.access.require({ permission })`
  with registry codes (`resource.read`, `resource.write`).
- **Artifact routes use only the application plane.**
  - They declare `resource.read` and `resource.write` in `packages/authz/src/routes.ts`.
  - The old `organization:manage` fallback is removed, so Owner no longer implies
    product actions.
  - `POST /api/dev/billing` acts on the caller's own organization and requires
    `organization.billing.manage`.
- **One setup console remains.** `main`'s `packages/cli/src/setup.ts` was
  superseded by `packages/cli/src/setup/`. `trestle setup --plan-only` now opens a
  read-only console. Use `trestle plan diff` for a non-interactive preview.
- **Outbox dispatch combines both sides.**
  - The cron runner publishes webhooks and notifications, and forwards to
    `TRESTLE_EVENTS` when it is bound.
  - Queue consumption keeps `main`'s inbox and Workflow paths.
  - Remote dispatch fails closed without the binding only when `capabilities.queues`
    is declared.
- **Other merged pieces.**
  - `createSqlRunner` accepts the `neon-serverless` driver.
  - Billing services resolve lazily with admin price mappings.
  - The execution context authenticates before it loads the access catalog.

