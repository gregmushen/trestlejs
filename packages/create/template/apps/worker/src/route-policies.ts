import { customerRoutePolicies, type HttpMethod, type RoutePolicy } from "@__TRESTLE_PROJECT_NAME__/authz";

/** The customer Worker route table lives beside the permission registry in packages/authz/src/routes.ts. */
export const routePolicies = customerRoutePolicies;

/** Generated tenant resources without an explicit policy read with resource.read and mutate with resource.write. */
export function defaultResourcePolicy(method: HttpMethod, path: string): RoutePolicy {
  return { method, path, audience: "tenant", permission: method === "GET" ? "resource.read" : "resource.write", principals: ["user", "api_key"] };
}

const compiled = routePolicies.map((policy) => ({
  policy,
  pattern: new RegExp(`^${policy.path.split("/").map((segment) => segment === "*" ? ".*" : segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("/")}$`, "u"),
}));

export function policyFor(method: string, path: string): RoutePolicy | undefined {
  const normalized = (method === "HEAD" ? "GET" : method) as HttpMethod;
  return compiled.find(({ policy, pattern }) => policy.method === normalized && pattern.test(path))?.policy;
}
