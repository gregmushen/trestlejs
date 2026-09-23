import { defineRoutePolicies, permissions, type HttpMethod, type RoutePolicy } from "@__TRESTLE_PROJECT_NAME__/authz";

import { adminViews } from "../src/registry.js";

/**
 * Every admin Worker route and the authority it requires. View routes come
 * from the view registry, so the permission a view's sidebar entry checks is
 * the permission the server enforces. The route-drift test fails when a
 * registered route has no policy or a policy has no route.
 */
const basePolicies: RoutePolicy[] = [
  // Only sign-in, session, and sign-out reach Better Auth on the admin origin.
  { method: "POST", path: "/api/auth/sign-in/email", public: true, audience: "public" },
  { method: "POST", path: "/api/auth/sign-out", public: true, audience: "public" },
  { method: "GET", path: "/api/auth/get-session", public: true, audience: "public" },
  { method: "GET", path: "/api/admin/health/live", public: true, audience: "public" },
  { method: "GET", path: "/api/admin/session", audience: "session" },
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
