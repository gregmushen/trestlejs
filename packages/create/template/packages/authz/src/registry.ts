export type AuthorityPlane = "organization" | "application" | "platform";
export type PermissionPrincipal = "user" | "api_key";

export const authorityPlanes: readonly AuthorityPlane[] = ["organization", "application", "platform"];

export type PermissionDefinition = Readonly<{
  /** Exactly one authority plane. Explicit and authoritative; names only make it apparent. */
  plane: AuthorityPlane;
  description: string;
  /** Defaults to human users. Machine-capable organization permissions must declare api_key explicitly. */
  principals?: readonly PermissionPrincipal[];
  entitlement?: string;
  group?: string;
  deprecated?: string;
  /** The permission can reveal a credential or signing secret. Support profiles can never grant it. */
  secret?: true;
}>;

export type RegisteredPermission<Code extends string = string> = Readonly<{
  code: Code;
  /** Human name; code-defined permissions use their description. */
  name?: string;
  /** Where the definition lives: reviewed source, or the runtime catalog (grant-only, never code-enforced by itself). */
  origin?: "code" | "runtime";
  plane: AuthorityPlane;
  description: string;
  principals: readonly PermissionPrincipal[];
  entitlement?: string;
  group: string;
  deprecated?: string;
  secret?: true;
}>;

export type PermissionRegistry<Code extends string = string> = Readonly<{
  codes: readonly Code[];
  has(code: string): code is Code;
  get(code: string): RegisteredPermission<Code> | undefined;
  require(code: string): RegisteredPermission<Code>;
  list(plane?: AuthorityPlane): RegisteredPermission<Code>[];
}>;

export const permissionCodePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

export class PermissionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionRegistryError";
  }
}

const reservedPrefix: Readonly<Record<string, AuthorityPlane>> = { organization: "organization", platform: "platform" };

export function definePermissions<const Definitions extends Record<string, PermissionDefinition>>(
  definitions: Definitions,
): PermissionRegistry<Extract<keyof Definitions, string>> {
  type Code = Extract<keyof Definitions, string>;
  const entries = new Map<string, RegisteredPermission<Code>>();
  for (const [code, definition] of Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))) {
    if (!permissionCodePattern.test(code)) throw new PermissionRegistryError(`Permission ${code} must be a lowercase dotted code`);
    if (!authorityPlanes.includes(definition.plane)) throw new PermissionRegistryError(`Permission ${code} must declare an organization, application, or platform plane`);
    if (!definition.description.trim()) throw new PermissionRegistryError(`Permission ${code} requires a description`);
    const prefixPlane = reservedPrefix[code.split(".")[0]!];
    if (prefixPlane && prefixPlane !== definition.plane) throw new PermissionRegistryError(`Permission ${code} uses the ${prefixPlane}. prefix but declares the ${definition.plane} plane`);
    if (!prefixPlane && definition.plane !== "application") throw new PermissionRegistryError(`${definition.plane} permission ${code} must use the ${definition.plane}. prefix`);
    const principals = definition.principals ?? ["user"];
    if (principals.length === 0) throw new PermissionRegistryError(`Permission ${code} must allow at least one principal type`);
    if (new Set(principals).size !== principals.length) throw new PermissionRegistryError(`Permission ${code} repeats a principal type`);
    if (definition.plane === "platform" && principals.includes("api_key")) throw new PermissionRegistryError(`Platform permission ${code} is only grantable to human users`);
    if (definition.plane === "platform" && definition.entitlement) throw new PermissionRegistryError(`Platform permission ${code} cannot depend on a tenant entitlement`);
    entries.set(code, {
      code: code as Code,
      plane: definition.plane,
      description: definition.description,
      principals,
      group: definition.group ?? code.split(".").slice(0, -1).join("."),
      ...(definition.entitlement ? { entitlement: definition.entitlement } : {}),
      ...(definition.deprecated ? { deprecated: definition.deprecated } : {}),
      ...(definition.secret ? { secret: true as const } : {}),
    });
  }
  const codes = [...entries.keys()] as Code[];
  return {
    codes,
    has: (code): code is Code => entries.has(code),
    get: (code) => entries.get(code),
    require: (code) => {
      const permission = entries.get(code);
      if (!permission) throw new PermissionRegistryError(`Permission ${code} is not registered`);
      return permission;
    },
    list: (plane) => [...entries.values()].filter((permission) => !plane || permission.plane === plane),
  };
}
