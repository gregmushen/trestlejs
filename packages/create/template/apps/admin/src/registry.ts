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
  /** Admin Worker routes the view calls. Each is enforced with the view's permission. */
  api: ReadonlyArray<Readonly<{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string }>>;
}>;

export class AdminViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminViewError";
  }
}

export function defineAdminViews<const Views extends readonly AdminView[]>(views: Views): Views {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const routes = new Map<string, string>();
  for (const view of views) {
    if (!/^[a-z][a-z0-9-]*$/u.test(view.id) || ids.has(view.id)) throw new AdminViewError(`Admin view ${view.id} needs a unique kebab-case id`);
    if (!view.path.startsWith("/") || paths.has(view.path)) throw new AdminViewError(`Admin view ${view.id} needs a unique path`);
    const permission = permissions.get(view.permission);
    if (!permission) throw new AdminViewError(`Admin view ${view.id} requires unregistered permission ${view.permission}`);
    if (permission.plane !== "platform") throw new AdminViewError(`Admin view ${view.id} must require a platform permission, not ${permission.plane} permission ${view.permission}`);
    for (const route of view.api) {
      if (!route.path.startsWith("/api/admin/")) throw new AdminViewError(`Admin view ${view.id} route ${route.path} must be under /api/admin/`);
      const key = `${route.method} ${route.path}`;
      const owner = routes.get(key);
      // Two views may share a read route only when they require the same permission.
      if (owner && owner !== view.permission) throw new AdminViewError(`Route ${key} is claimed by views with different permissions`);
      routes.set(key, view.permission);
    }
    ids.add(view.id);
    paths.add(view.path);
  }
  return views;
}

export const adminViews: readonly AdminView[] = defineAdminViews([
  { id: "overview", path: "/", label: "Overview", group: "Platform", permission: "platform.overview.read", api: [{ method: "GET", path: "/api/admin/overview" }] },
  { id: "health", path: "/health", label: "Health", group: "Platform", permission: "platform.overview.read", api: [{ method: "GET", path: "/api/admin/health" }] },
]);
