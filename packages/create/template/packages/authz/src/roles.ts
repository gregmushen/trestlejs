import type { AuthorityPlane, PermissionRegistry } from "./registry.js";

export type RoleDefinition<Code extends string = string> = Readonly<{
  name: string;
  description: string;
  permissions: readonly Code[];
}>;

export type Role = Readonly<{
  key: string;
  name: string;
  description: string;
  plane: AuthorityPlane;
  permissions: readonly string[];
  custom: boolean;
  /** Built-in (code), the global admin catalog, or one tenant's own roles. */
  source?: "builtin" | "catalog" | "tenant";
}>;

export type CustomRoleInput = Readonly<{ key: string; name: string; description?: string; permissions: readonly string[] }>;

/** Every effective permission records the roles that granted it, within one plane. */
export type EffectivePermissions = ReadonlyMap<string, readonly string[]>;

export const roleKeyPattern = /^[a-z][a-z0-9_-]{1,39}$/u;

export class RoleDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleDefinitionError";
  }
}

export type RoleCatalog = Readonly<{
  plane: AuthorityPlane;
  get(key: string): Role | undefined;
  list(): Role[];
  withCustomRoles(customRoles: readonly CustomRoleInput[]): RoleCatalog;
  resolve(roleKeys: readonly string[]): { permissions: EffectivePermissions; unknownRoles: string[] };
}>;

function validate(registry: PermissionRegistry, plane: AuthorityPlane, key: string, permissions: readonly string[]): void {
  if (!roleKeyPattern.test(key)) throw new RoleDefinitionError(`Role ${key} must be a lowercase key`);
  if (new Set(permissions).size !== permissions.length) throw new RoleDefinitionError(`Role ${key} repeats a permission`);
  for (const code of permissions) {
    const permission = registry.get(code);
    if (!permission) throw new RoleDefinitionError(`Role ${key} grants unregistered permission ${code}`);
    if (permission.plane !== plane) throw new RoleDefinitionError(`${plane} role ${key} cannot grant ${permission.plane} permission ${code}`);
  }
}

export function roleCatalog(registry: PermissionRegistry, plane: AuthorityPlane, roles: readonly Role[]): RoleCatalog {
  const byKey = new Map(roles.map((role) => [role.key, role]));
  return {
    plane,
    get: (key) => byKey.get(key),
    list: () => [...byKey.values()],
    withCustomRoles: (customRoles) => {
      if (plane !== "application") throw new RoleDefinitionError("Custom roles are only supported for application roles");
      const kept = roles.filter((role) => !role.custom || role.source === "catalog");
      const catalogKeys = new Set(kept.filter((role) => role.source === "catalog").map((role) => role.key));
      // A tenant role never shadows a global catalog role; writes refuse the collision up front.
      const custom = customRoles.filter((role) => !catalogKeys.has(role.key)).map((role): Role => {
        if (byKey.has(role.key)) throw new RoleDefinitionError(`Custom role ${role.key} collides with a default role`);
        validate(registry, plane, role.key, role.permissions);
        return { key: role.key, name: role.name, description: role.description ?? "", plane, permissions: [...role.permissions].sort(), custom: true, source: "tenant" };
      });
      return roleCatalog(registry, plane, [...kept, ...custom]);
    },
    resolve: (roleKeys) => {
      const granted = new Map<string, string[]>();
      const unknownRoles: string[] = [];
      for (const key of [...new Set(roleKeys)].sort()) {
        const role = byKey.get(key);
        if (!role) { unknownRoles.push(key); continue; }
        for (const code of role.permissions) {
          if (registry.get(code)?.deprecated) continue;
          granted.set(code, [...(granted.get(code) ?? []), key]);
        }
      }
      return { permissions: new Map([...granted].sort(([a], [b]) => a.localeCompare(b))), unknownRoles };
    },
  };
}

export function defineRoles<Code extends string>(
  registry: PermissionRegistry<Code>,
  plane: AuthorityPlane,
  definitions: Readonly<Record<string, RoleDefinition<Code>>>,
): RoleCatalog {
  const roles = Object.entries(definitions).map(([key, definition]): Role => {
    validate(registry, plane, key, definition.permissions);
    return { key, name: definition.name, description: definition.description, plane, permissions: [...definition.permissions].sort(), custom: false };
  });
  return roleCatalog(registry, plane, roles);
}

/** Better Auth stores multiple organization roles as a comma-separated value. */
export function parseMembershipRoles(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((role) => role.trim()).filter(Boolean))].sort();
}
