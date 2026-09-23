import { permissions } from "@__TRESTLE_PROJECT_NAME__/authz";

/**
 * The admin view registry: the single source for each view's sidebar entry,
 * the platform permission it requires, the capability it depends on, and the
 * admin API routes it calls. The SPA renders its navigation from this list and
 * the admin Worker derives its route policies from it, so a view's visibility,
 * capability status, and server-enforced permission cannot drift apart.
 * Add application views here; `trestle upgrade` preserves this file.
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
  /** Admin Worker routes the view calls. Each is enforced with the view's permission, or an action's own platform permission. */
  api: ReadonlyArray<Readonly<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; permission?: string }>>;
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
    }
    ids.add(view.id);
    paths.add(view.path);
  }
  return views;
}

export const adminViews: readonly AdminView[] = defineAdminViews([
  { id: "overview", path: "/", label: "Overview", group: "Platform", permission: "platform.overview.read", api: [{ method: "GET", path: "/api/admin/overview" }] },
  { id: "health", path: "/health", label: "Health", group: "Platform", permission: "platform.overview.read", api: [{ method: "GET", path: "/api/admin/health" }] },
  { id: "async", path: "/operations/async", label: "Async events", group: "Operations", permission: "platform.operations.read", capability: "queues", api: [
    { method: "GET", path: "/api/admin/operations/outbox" },
    { method: "POST", path: "/api/admin/operations/outbox/:id/redrive", permission: "platform.outbox.redrive" },
  ] },
  { id: "webhooks", path: "/operations/webhooks", label: "Webhooks", group: "Operations", permission: "platform.operations.read", api: [
    { method: "GET", path: "/api/admin/operations/webhooks" },
    { method: "POST", path: "/api/admin/operations/webhooks/:organizationId/endpoints/:endpointId/disable", permission: "platform.webhooks.manage" },
    { method: "POST", path: "/api/admin/operations/webhooks/:organizationId/deliveries/:deliveryId/replay", permission: "platform.webhooks.manage" },
  ] },
  { id: "artifacts", path: "/operations/artifacts", label: "Artifacts", group: "Operations", permission: "platform.operations.read", capability: "artifacts", api: [{ method: "GET", path: "/api/admin/operations/artifacts" }] },
]);
