import { permissions } from "./permissions.js";
import { defineRoutePolicies, type HttpMethod, type RoutePolicy } from "./route-policy.js";

/**
 * Every customer Worker route declares its audience and required authority
 * here, and the execution-context middleware enforces it before the handler
 * runs. The route-drift test fails when a registered route has no policy or a
 * policy names a route that does not exist. Generated tenant resources without
 * an explicit policy fall back to `defaultResourcePolicy`.
 */
export const customerRoutePolicies = defineRoutePolicies(permissions, [
  { method: "GET", path: "/api/health", public: true, audience: "public" },
  { method: "GET", path: "/api/health/operational", public: true, audience: "public" },
  { method: "GET", path: "/api/openapi.json", public: true, audience: "public" },
  { method: "GET", path: "/api/docs", public: true, audience: "public" },
  { method: "GET", path: "/api/auth/*", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/*", public: true, audience: "public" },
  { method: "POST", path: "/api/webhooks/resend", public: true, audience: "public" },
  { method: "POST", path: "/webhooks/stripe", public: true, audience: "public" },
  // Local-only email capture; the handlers return 404 outside local capture mode.
  { method: "GET", path: "/api/dev/emails", public: true, audience: "public" },
  { method: "GET", path: "/api/dev/emails/:id", public: true, audience: "public" },
  { method: "DELETE", path: "/api/dev/emails", public: true, audience: "public" },
  { method: "POST", path: "/api/dev/emails/flush", public: true, audience: "public" },
  // Local only (404 elsewhere): the due-time scheduler's own state and a no-op alarm probe.
  { method: "GET", path: "/api/dev/scheduler", public: true, audience: "public" },
  { method: "POST", path: "/api/dev/scheduler/probe", public: true, audience: "public" },
  // Signed, expiring artifact downloads; the signature is the authority.
  { method: "GET", path: "/artifacts/:id", public: true, audience: "public" },
  { method: "GET", path: "/api/me", audience: "session" },
  // Separate opaque support credential; handlers verify it against the live
  // platform session and never treat it as a Better Auth customer session.
  { method: "POST", path: "/api/support/exchange", audience: "support" },
  { method: "GET", path: "/api/support/context", audience: "support" },
  { method: "POST", path: "/api/support/exit", audience: "support" },

  { method: "GET", path: "/api/tenant/access", audience: "tenant", permission: "organization.read" },
  { method: "GET", path: "/api/tenant/application-role-assignments", audience: "tenant", permission: "application.roles.read" },
  { method: "GET", path: "/api/tenant/audit", audience: "tenant", permission: "organization.audit.read" },
  { method: "GET", path: "/api/tenant/regional", audience: "tenant", permission: "organization.read" },
  { method: "PUT", path: "/api/tenant/regional", audience: "tenant", permission: "organization.settings.manage" },
  { method: "PUT", path: "/api/tenant/users/:userId/application-roles", audience: "tenant", permission: "application.roles.assign" },
  { method: "GET", path: "/api/tenant/service-accounts", audience: "tenant", permission: "application.service_accounts.read" },
  { method: "POST", path: "/api/tenant/service-accounts", audience: "tenant", permission: "application.service_accounts.manage" },
  { method: "POST", path: "/api/tenant/service-accounts/:id/api-keys", audience: "tenant", permission: "application.service_accounts.manage" },
  { method: "POST", path: "/api/tenant/api-keys/:id/rotate", audience: "tenant", permission: "application.service_accounts.manage" },
  { method: "POST", path: "/api/tenant/api-keys/:id/revoke", audience: "tenant", permission: "application.service_accounts.manage" },

  { method: "POST", path: "/api/billing/checkout", audience: "tenant", permission: "organization.billing.manage" },
  { method: "POST", path: "/api/billing/portal", audience: "tenant", permission: "organization.billing.manage" },
  { method: "GET", path: "/api/billing/subscription", audience: "tenant", permission: "organization.billing.read" },
  // Local-only billing simulator; acts on the caller's own organization.
  { method: "POST", path: "/api/dev/billing", audience: "tenant", permission: "organization.billing.manage" },

  { method: "GET", path: "/api/developer/webhooks/events", audience: "tenant", permission: "organization.webhooks.read" },
  { method: "GET", path: "/api/developer/webhooks/endpoints", audience: "tenant", permission: "organization.webhooks.read" },
  { method: "POST", path: "/api/developer/webhooks/endpoints", audience: "tenant", permission: "organization.webhooks.manage" },
  { method: "PATCH", path: "/api/developer/webhooks/endpoints/:id/state", audience: "tenant", permission: "organization.webhooks.manage" },
  { method: "GET", path: "/api/developer/webhooks/endpoints/:id/subscriptions", audience: "tenant", permission: "organization.webhooks.read" },
  { method: "PATCH", path: "/api/developer/webhooks/endpoints/:id/subscriptions", audience: "tenant", permission: "organization.webhooks.manage" },
  { method: "GET", path: "/api/developer/webhooks/endpoints/:id/deliveries", audience: "tenant", permission: "organization.webhooks.deliveries.read" },
  { method: "GET", path: "/api/developer/webhooks/deliveries/:id/attempts", audience: "tenant", permission: "organization.webhooks.deliveries.read" },
  { method: "POST", path: "/api/developer/webhooks/deliveries/:id/replay", audience: "tenant", permission: "organization.webhooks.replay" },

  // Artifacts are product resources: only application-plane authority grants them.
  { method: "POST", path: "/api/artifacts", audience: "tenant", permission: "resource.write" },
  { method: "GET", path: "/api/artifacts/:id/access", audience: "tenant", permission: "resource.read" },
  { method: "DELETE", path: "/api/artifacts/:id", audience: "tenant", permission: "resource.write" },
]);

/** Generated tenant resources without an explicit policy read with resource.read and mutate with resource.write. */
export function defaultResourcePolicy(method: HttpMethod, path: string): RoutePolicy {
  return { method, path, audience: "tenant", permission: method === "GET" ? "resource.read" : "resource.write" };
}

const compiled = customerRoutePolicies.map((policy) => ({
  policy,
  pattern: new RegExp(`^${policy.path.split("/").map((segment) => segment === "*" ? ".*" : segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("/")}$`, "u"),
}));

export function policyFor(method: string, path: string): RoutePolicy | undefined {
  const normalized = (method === "HEAD" ? "GET" : method) as HttpMethod;
  return compiled.find(({ policy, pattern }) => policy.method === normalized && pattern.test(path))?.policy;
}
