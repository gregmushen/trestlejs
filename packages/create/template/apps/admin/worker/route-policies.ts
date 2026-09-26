import { defineRoutePolicies, permissions, type HttpMethod, type RoutePolicy } from "@__TRESTLE_PROJECT_NAME__/authz";

import { adminViews } from "../src/api-registry.js";

/**
 * Every admin Worker route and the authority it requires. View routes come
 * from the view registry, so the permission a view's sidebar entry checks is
 * the permission the server enforces. The route-drift test fails when a
 * registered route has no policy or a policy has no route.
 */
const basePolicies: RoutePolicy[] = [
  // Only sign-in, session, sign-out, and the operator's own factors reach Better Auth on the admin origin.
  // Better Auth authenticates these itself; the Worker adds step-up before factor changes.
  { method: "POST", path: "/api/auth/sign-in/email", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/sign-out", public: true, audience: "public" },
  { method: "GET", path: "/api/auth/get-session", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/two-factor/enable", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/two-factor/disable", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/two-factor/verify-totp", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/two-factor/verify-backup-code", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/two-factor/generate-backup-codes", public: true, audience: "public" },
  { method: "GET", path: "/api/auth/passkey/list-user-passkeys", public: true, audience: "public" },
  { method: "GET", path: "/api/auth/passkey/generate-register-options", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/passkey/verify-registration", public: true, audience: "public" },
  { method: "GET", path: "/api/auth/passkey/generate-authenticate-options", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/passkey/verify-authentication", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/passkey/delete-passkey", public: true, audience: "public" },
  { method: "GET", path: "/api/admin/health/live", public: true, audience: "public" },
  { method: "GET", path: "/api/admin/session", audience: "session" },
  // The admin API document is operator-only: it describes platform operations.
  { method: "GET", path: "/api/admin/openapi.json", audience: "platform", permission: "platform.overview.read" },
];
const viewPolicies = adminViews.flatMap((view) => view.api.map((route): RoutePolicy => ({ method: route.method, path: route.path, audience: "platform", permission: route.permission ?? view.permission })));

export const adminRoutePolicies = defineRoutePolicies(permissions, [...basePolicies, ...viewPolicies]
  .filter((policy, index, all) => all.findIndex((other) => other.method === policy.method && other.path === policy.path) === index));

const compiled = adminRoutePolicies.map((policy) => ({
  policy,
  pattern: new RegExp(`^${policy.path.split("/").map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("/")}$`, "u"),
}));

export function adminPolicyFor(method: string, path: string): RoutePolicy | undefined {
  const normalized = (method === "HEAD" ? "GET" : method) as HttpMethod;
  return compiled.find(({ policy, pattern }) => policy.method === normalized && pattern.test(path))?.policy;
}
