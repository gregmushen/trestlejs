import { permissionCodePattern, PermissionRegistryError, type AuthorityPlane, type PermissionPrincipal, type PermissionRegistry, type RegisteredPermission } from "./registry.js";
import { roleCatalog, roleKeyPattern, RoleDefinitionError, type Role, type RoleCatalog } from "./roles.js";

/**
 * The runtime access catalog (docs/ADMIN_REQUIRED_CHANGES.md §5). Operators
 * can add grant-only permissions and global catalog roles in the admin. They
 * extend, never replace, the reviewed registry and built-in roles:
 *
 * - runtime permissions live in the organization or application plane only
 *   (platform authority stays in code) and are enforced wherever code checks
 *   them, which the admin reports as discovered enforcement;
 * - catalog roles are available to every organization, next to built-ins;
 * - a runtime definition that no longer validates grants nothing instead of
 *   failing the request.
 */

export type RuntimePermission = Readonly<{
  code: string;
  name: string;
  description: string;
  plane: "organization" | "application";
  principals: readonly PermissionPrincipal[];
  entitlement?: string | null;
  deprecated?: boolean;
}>;

export type CatalogRole = Readonly<{ key: string; name: string; description: string; plane: "organization" | "application"; permissions: readonly string[]; archived?: boolean }>;

export type AccessCatalog = Readonly<{
  permissions: PermissionRegistry;
  organization: RoleCatalog;
  application: RoleCatalog;
}>;

/** Validates a runtime permission against the reviewed registry. Returns problems; empty means valid. */
export function runtimePermissionProblems(base: PermissionRegistry, permission: RuntimePermission): string[] {
  const problems: string[] = [];
  if (!permissionCodePattern.test(permission.code)) problems.push("The code must be lowercase dotted words, such as reports.export");
  if (base.get(permission.code)) problems.push(`${permission.code} is already defined in code`);
  const prefix = permission.code.split(".")[0];
  if ((permission.plane as AuthorityPlane) === "platform" || prefix === "platform") problems.push("Platform permissions can only be defined in reviewed source");
  if (permission.plane === "organization" && prefix !== "organization") problems.push("Organization permissions must start with organization.");
  if (permission.plane === "application" && prefix === "organization") problems.push("Application permissions cannot use the organization. prefix");
  if (!permission.name.trim()) problems.push("A name is required");
  if (!permission.description.trim()) problems.push("A description is required");
  if (!permission.principals.length) problems.push("Allow at least one principal type");
  if (permission.plane === "organization" && permission.principals.includes("api_key")) problems.push("Only application permissions can be granted to API keys");
  return problems;
}

/** The reviewed registry plus valid runtime permissions. Invalid runtime entries are omitted. */
export function extendPermissions(base: PermissionRegistry, runtime: readonly RuntimePermission[]): PermissionRegistry {
  const extra = new Map<string, RegisteredPermission>();
  for (const permission of runtime) {
    if (runtimePermissionProblems(base, permission).length || extra.has(permission.code)) continue;
    extra.set(permission.code, {
      code: permission.code, name: permission.name, origin: "runtime", plane: permission.plane, description: permission.description, principals: [...permission.principals],
      group: permission.code.split(".").slice(0, -1).join("."),
      ...(permission.entitlement ? { entitlement: permission.entitlement } : {}),
      ...(permission.deprecated ? { deprecated: "Deprecated in the admin catalog" } : {}),
    });
  }
  const get = (code: string) => base.get(code) ?? extra.get(code);
  return {
    codes: [...base.codes, ...extra.keys()],
    has: (code): code is string => Boolean(get(code)),
    get,
    require: (code) => { const permission = get(code); if (!permission) throw new PermissionRegistryError(`Permission ${code} is not registered`); return permission; },
    list: (plane) => [...base.list(plane).map((permission) => ({ ...permission, origin: "code" as const })), ...[...extra.values()].filter((permission) => !plane || permission.plane === plane)],
  };
}

/** Validates a catalog role for writing. Returns problems; empty means valid. */
export function catalogRoleProblems(catalog: AccessCatalog, role: CatalogRole, options: { creating: boolean }): string[] {
  const problems: string[] = [];
  const plane = role.plane === "organization" ? catalog.organization : catalog.application;
  if (!roleKeyPattern.test(role.key)) problems.push("The key must be 2-40 lowercase letters, digits, hyphens, or underscores");
  const existing = plane.get(role.key);
  if (existing && !existing.custom) problems.push(`${role.key} is a built-in role; clone it instead`);
  if (options.creating && existing?.custom) problems.push(`${role.key} already exists`);
  if (!role.name.trim()) problems.push("A name is required");
  if (new Set(role.permissions).size !== role.permissions.length) problems.push("Permissions must not repeat");
  for (const code of role.permissions) {
    const permission = catalog.permissions.get(code);
    if (!permission) problems.push(`${code} is not a registered permission`);
    else if (permission.plane !== role.plane) problems.push(`${code} is a ${permission.plane} permission, not ${role.plane}`);
    else if (permission.deprecated) problems.push(`${code} is deprecated`);
  }
  return problems;
}

function composed(registry: PermissionRegistry, base: RoleCatalog, roles: readonly CatalogRole[]): RoleCatalog {
  const builtIns = base.list().filter((role) => !role.custom);
  const taken = new Set(builtIns.map((role) => role.key));
  const extra = roles.filter((role) => !role.archived && !taken.has(role.key) && roleKeyPattern.test(role.key)).map((role): Role => ({
    key: role.key, name: role.name, description: role.description, plane: base.plane, custom: true, source: "catalog",
    // Fail safe: a permission deleted or moved since the role was saved simply grants nothing.
    permissions: role.permissions.filter((code) => registry.get(code)?.plane === base.plane).sort(),
  }));
  return roleCatalog(registry, base.plane, [...builtIns.map((role) => ({ ...role })), ...extra]);
}

export function buildAccessCatalog(base: Readonly<{ permissions: PermissionRegistry; organization: RoleCatalog; application: RoleCatalog }>, runtime: Readonly<{ permissions: readonly RuntimePermission[]; roles: readonly CatalogRole[] }>): AccessCatalog {
  const permissions = extendPermissions(base.permissions, runtime.permissions);
  if (base.organization.plane !== "organization" || base.application.plane !== "application") throw new RoleDefinitionError("Access catalog planes are mismatched");
  return {
    permissions,
    organization: composed(permissions, base.organization, runtime.roles.filter((role) => role.plane === "organization")),
    application: composed(permissions, base.application, runtime.roles.filter((role) => role.plane === "application")),
  };
}
