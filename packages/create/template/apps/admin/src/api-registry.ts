import { permissions } from "@__TRESTLE_PROJECT_NAME__/authz";

/**
 * The admin view registry: the single source for each view's sidebar entry,
 * the platform permission it requires, the capability it depends on, and the
 * admin API routes it calls. The SPA renders its navigation from this list and
 * the admin Worker derives its route policies from it, so a view's visibility,
 * capability status, and server-enforced permission cannot drift apart.
 * Add application views here. This file is template-owned: once edited,
 * `trestle upgrade` reports it for manual review instead of replacing it.
 */
export type AdminCapability = "database" | "email" | "billing" | "queues" | "artifacts" | "workflows";

export type AdminView = Readonly<{
  id: string;
  /** SPA path. */
  path: string;
  label: string;
  group: string;
  /** Platform permission required to see the view and call its API. */
  permission: string;
  /** A capability the view depends on; the sidebar shows setup guidance while it is not configured. */
  capability?: AdminCapability;
  /**
   * Admin Worker routes the view calls. Each is enforced with the view's permission, or an action's own platform permission.
   * `stepUp: false` exempts a non-GET route from fresh step-up (a read over POST, or a change that only reduces privilege);
   * the minimum sign-in level still applies.
   */
  api: ReadonlyArray<Readonly<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; permission?: string; stepUp?: false }>>;
}>;

export class AdminViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminViewError";
  }
}

function requirePlatformPermission(viewId: string, code: string): void {
  const permission = permissions.get(code);
  if (!permission) throw new AdminViewError(`Admin view ${viewId} requires unregistered permission ${code}`);
  if (permission.plane !== "platform") throw new AdminViewError(`Admin view ${viewId} must require a platform permission, not ${permission.plane} permission ${code}`);
}

export function defineAdminViews<const Views extends readonly AdminView[]>(views: Views): Views {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const routes = new Map<string, string>();
  const stepUp = new Map<string, boolean>();
  for (const view of views) {
    if (!/^[a-z][a-z0-9-]*$/u.test(view.id) || ids.has(view.id)) throw new AdminViewError(`Admin view ${view.id} needs a unique kebab-case id`);
    if (!view.path.startsWith("/") || paths.has(view.path)) throw new AdminViewError(`Admin view ${view.id} needs a unique path`);
    requirePlatformPermission(view.id, view.permission);
    for (const route of view.api) {
      if (!route.path.startsWith("/api/admin/")) throw new AdminViewError(`Admin view ${view.id} route ${route.path} must be under /api/admin/`);
      if (route.method !== "GET" && !route.permission) throw new AdminViewError(`Admin view ${view.id} action ${route.method} ${route.path} must declare its own platform permission`);
      const required = route.permission ?? view.permission;
      requirePlatformPermission(view.id, required);
      const key = `${route.method} ${route.path}`;
      const owner = routes.get(key);
      // Two views may share a route only when it requires the same permission.
      if (owner && owner !== required) throw new AdminViewError(`Route ${key} is claimed by views with different permissions`);
      routes.set(key, required);
      const fresh = route.stepUp !== false;
      if (!fresh && route.method === "GET") throw new AdminViewError(`Route ${key} is a read; only actions declare stepUp: false`);
      if (stepUp.has(key) && stepUp.get(key) !== fresh) throw new AdminViewError(`Route ${key} is declared with different step-up requirements`);
      stepUp.set(key, fresh);
    }
    ids.add(view.id);
    paths.add(view.path);
  }
  return views;
}

export const adminViews: readonly AdminView[] = defineAdminViews([
  { id: "overview", path: "/", label: "Overview", group: "Overview", permission: "platform.overview.read", api: [{ method: "GET", path: "/api/admin/overview" }, { method: "GET", path: "/api/admin/organizations", permission: "platform.organizations.read" }] },
  { id: "health", path: "/system/health", label: "Health", group: "System", permission: "platform.overview.read", api: [{ method: "GET", path: "/api/admin/health" }] },
  { id: "async", path: "/operations/async", label: "Async Operations", group: "Operations", permission: "platform.operations.read", capability: "queues", api: [
    { method: "GET", path: "/api/admin/operations/outbox" },
    { method: "POST", path: "/api/admin/operations/outbox/:id/redrive", permission: "platform.outbox.redrive" },
  ] },
  { id: "webhooks", path: "/integrations/webhooks", label: "Webhooks", group: "Integrations", permission: "platform.operations.read", api: [
    { method: "GET", path: "/api/admin/operations/webhooks" },
    { method: "POST", path: "/api/admin/operations/webhooks/:organizationId/endpoints/:endpointId/disable", permission: "platform.webhooks.manage" },
    { method: "POST", path: "/api/admin/operations/webhooks/:organizationId/deliveries/:deliveryId/replay", permission: "platform.webhooks.manage" },
  ] },
  { id: "organizations", path: "/organizations", label: "Organizations", group: "Customers", permission: "platform.organizations.read", api: [
    { method: "GET", path: "/api/admin/organizations" },
    { method: "GET", path: "/api/admin/organizations/:organizationId" },
  ] },
  { id: "users", path: "/users", label: "Users", group: "Customers", permission: "platform.users.read", api: [{ method: "GET", path: "/api/admin/users" }] },
  { id: "audit", path: "/operations/audit", label: "Audit", group: "Operations", permission: "platform.audit.read", api: [
    { method: "GET", path: "/api/admin/audit" },
    { method: "GET", path: "/api/admin/audit/:id" },
  ] },
  { id: "platform-roles", path: "/access/platform-roles", label: "Platform Roles", group: "Access", permission: "platform.roles.read", api: [
    { method: "GET", path: "/api/admin/platform-roles" },
    { method: "POST", path: "/api/admin/platform-roles", permission: "platform.roles.manage" },
    { method: "POST", path: "/api/admin/platform-roles/:userId/:role/revoke", permission: "platform.roles.manage" },
  ] },
  { id: "organization-roles", path: "/access/organization-roles", label: "Organization Roles", group: "Access", permission: "platform.roles.read", api: [
    { method: "GET", path: "/api/admin/access/role-assignments" },
  ] },
  { id: "application-roles", path: "/access/application-roles", label: "Application Roles", group: "Access", permission: "platform.roles.read", api: [
    { method: "GET", path: "/api/admin/access/role-assignments" },
  ] },
  { id: "permissions", path: "/access/permissions", label: "Permissions", group: "Access", permission: "platform.roles.read", api: [
    // A read over POST: explaining access changes nothing.
    { method: "POST", path: "/api/admin/access/explain", permission: "platform.roles.read", stepUp: false },
  ] },
  { id: "service-accounts", path: "/access/service-accounts", label: "Service Accounts", group: "Access", permission: "platform.machine_access.read", api: [
    { method: "GET", path: "/api/admin/service-accounts" },
  ] },
  { id: "email", path: "/communications/email", label: "Email", group: "Communications", permission: "platform.operations.read", capability: "email", api: [{ method: "GET", path: "/api/admin/email" }] },
  { id: "plans", path: "/commercial/plans", label: "Plans", group: "Commercial", permission: "platform.subscriptions.read", capability: "billing", api: [] },
  { id: "entitlements", path: "/commercial/entitlements", label: "Entitlements", group: "Commercial", permission: "platform.subscriptions.read", capability: "billing", api: [
    { method: "GET", path: "/api/admin/commercial/subscriptions" },
    { method: "GET", path: "/api/admin/commercial/subscriptions/:organizationId" },
  ] },
  { id: "support-workspace", path: "/support/workspace", label: "Support Workspace", group: "Customers", permission: "platform.support_sessions.use", api: [
    { method: "GET", path: "/api/admin/support/sessions/:id/organization" },
  ] },
  { id: "support-sessions", path: "/support/sessions", label: "Support Sessions", group: "Customers", permission: "platform.support_sessions.use", api: [
    { method: "GET", path: "/api/admin/support/sessions" },
    { method: "POST", path: "/api/admin/support/sessions", permission: "platform.support_sessions.use" },
    { method: "GET", path: "/api/admin/support/sessions/:id/organization" },
    // Ending a support session only gives up access.
    { method: "POST", path: "/api/admin/support/sessions/:id/end", permission: "platform.support_sessions.use", stepUp: false },
  ] },
  { id: "subscriptions", path: "/commercial/subscriptions", label: "Subscriptions", group: "Commercial", permission: "platform.subscriptions.read", capability: "billing", api: [
    { method: "GET", path: "/api/admin/commercial/subscriptions" },
    { method: "GET", path: "/api/admin/commercial/subscriptions/:organizationId" },
    { method: "POST", path: "/api/admin/commercial/subscriptions/:organizationId/overrides", permission: "platform.entitlements.manage" },
    { method: "POST", path: "/api/admin/commercial/subscriptions/:organizationId/overrides/:entitlement/revoke", permission: "platform.entitlements.manage" },
  ] },
  { id: "api-keys", path: "/access/api-keys", label: "API Keys", group: "Access", permission: "platform.machine_access.read", api: [
    { method: "GET", path: "/api/admin/security/api-keys" },
    { method: "POST", path: "/api/admin/security/api-keys/:organizationId/:keyId/revoke", permission: "platform.api_keys.revoke" },
  ] },
  { id: "artifacts", path: "/operations/artifacts", label: "Artifacts", group: "Operations", permission: "platform.operations.read", capability: "artifacts", api: [{ method: "GET", path: "/api/admin/operations/artifacts" }] },
  // The operator's own factors go through Better Auth on the admin origin, not the admin API.
  { id: "account-security", path: "/account/security", label: "Account Security", group: "System", permission: "platform.overview.read", api: [] },
]);

/** Admin actions exempt from fresh step-up, as `METHOD /path` keys; the Worker still applies the minimum sign-in level. */
export const stepUpExemptRoutes: ReadonlySet<string> = new Set(adminViews.flatMap((view) => view.api.filter((route) => route.stepUp === false).map((route) => `${route.method} ${route.path}`)));
