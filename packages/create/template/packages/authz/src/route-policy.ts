import type { PermissionPrincipal, PermissionRegistry } from "./registry.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RoutePolicy = Readonly<{
  method: HttpMethod;
  path: string;
  /** Public routes perform no principal authentication (health, signed webhooks, auth handler). */
  public?: true;
  permission?: string;
  entitlement?: string;
  /** Principal types accepted by the endpoint. Defaults to the permission's principals. */
  principals?: readonly PermissionPrincipal[];
  audience: "tenant" | "platform" | "public" | "session";
  /** The response carries a newly minted credential or signing secret; refused in support sessions. */
  revealsSecret?: true;
}>;

export class RoutePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutePolicyError";
  }
}

export function defineRoutePolicies(registry: PermissionRegistry, policies: readonly RoutePolicy[]): readonly RoutePolicy[] {
  const seen = new Set<string>();
  for (const policy of policies) {
    const key = `${policy.method} ${policy.path}`;
    if (seen.has(key)) throw new RoutePolicyError(`Route ${key} has more than one policy`);
    seen.add(key);
    if (policy.public && (policy.permission || policy.entitlement)) throw new RoutePolicyError(`Public route ${key} cannot require authority`);
    if (!policy.public && policy.audience === "public") throw new RoutePolicyError(`Route ${key} is marked public without public: true`);
    if (policy.permission) {
      const permission = registry.get(policy.permission);
      if (!permission) throw new RoutePolicyError(`Route ${key} requires unregistered permission ${policy.permission}`);
      if ((permission.plane === "platform") !== (policy.audience === "platform")) throw new RoutePolicyError(`Route ${key} mixes ${policy.audience} audience with ${permission.plane}-plane permission`);
      for (const principal of policy.principals ?? []) {
        if (!permission.principals.includes(principal)) throw new RoutePolicyError(`Route ${key} accepts ${principal} principals that ${policy.permission} does not allow`);
      }
    } else if (policy.audience === "tenant" || policy.audience === "platform") {
      throw new RoutePolicyError(`${policy.audience} route ${key} must declare a permission`);
    }
  }
  return [...policies].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export function acceptsApiKeys(registry: PermissionRegistry, policy: RoutePolicy): boolean {
  if (!policy.permission) return false;
  const allowed = policy.principals ?? registry.get(policy.permission)?.principals ?? [];
  return allowed.includes("api_key");
}
