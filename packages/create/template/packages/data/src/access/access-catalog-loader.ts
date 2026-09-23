import { applicationRoles, buildAccessCatalog, organizationRoles, permissions, type AccessCatalog, type CatalogRole, type RuntimePermission } from "@__TRESTLE_PROJECT_NAME__/authz";
import type { SqlRow, SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { sql } from "drizzle-orm";

const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : typeof value === "string" && value.startsWith("{") ? value.slice(1, -1).split(",").filter(Boolean).map((item) => item.replace(/^"|"$/gu, "")) : [];

export const runtimePermissionFrom = (row: SqlRow): RuntimePermission => ({
  code: String(row.code), name: String(row.name), description: String(row.description), plane: String(row.plane) as RuntimePermission["plane"],
  principals: strings(row.principals).filter((value): value is "user" | "api_key" => value === "user" || value === "api_key"),
  entitlement: row.entitlement ? String(row.entitlement) : null, deprecated: row.state === "deprecated",
});

export const catalogRoleFrom = (row: SqlRow): CatalogRole => ({
  plane: String(row.plane) as CatalogRole["plane"], key: String(row.key), name: String(row.name), description: String(row.description ?? ""), permissions: strings(row.permissions), archived: Boolean(row.archived_at),
});

/**
 * Reads the global runtime catalog (grant-only permissions and catalog roles)
 * and composes it with the reviewed registry and built-in roles. Loaded per
 * request so archiving a role or deprecating a permission takes effect at once.
 */
export async function loadAccessCatalog(runner: SqlRunner): Promise<AccessCatalog> {
  const [permissionRows, roleRows] = await Promise.all([
    runner.query(sql`select code, name, description, plane, principals, entitlement, state from access_permission`),
    runner.query(sql`select plane, key, name, description, permissions, archived_at from access_role`),
  ]);
  return buildAccessCatalog({ permissions, organization: organizationRoles, application: applicationRoles }, { permissions: permissionRows.map(runtimePermissionFrom), roles: roleRows.map(catalogRoleFrom) });
}
