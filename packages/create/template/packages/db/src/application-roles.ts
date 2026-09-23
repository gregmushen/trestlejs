import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { applicationRoleAssignment } from "./access-schema.js";
import type { Database } from "./index.js";

export type ApplicationRoleGrant = Readonly<{ userId: string; role: string; grantedBy: string; grantedAt: Date }>;

/**
 * Tenant-bound application-role storage. Every call takes a database bound to
 * the restricted role and the organization, so forced RLS is the second,
 * independent tenant boundary behind the caller's own organization predicate.
 * Role keys are validated against the reviewed catalog by callers.
 */
export async function activeApplicationRoles(database: Database, organizationId: string, userId: string): Promise<string[]> {
  const rows = await database.select({ role: applicationRoleAssignment.role }).from(applicationRoleAssignment)
    .where(and(eq(applicationRoleAssignment.organizationId, organizationId), eq(applicationRoleAssignment.userId, userId), isNull(applicationRoleAssignment.revokedAt)))
    .orderBy(asc(applicationRoleAssignment.role));
  return rows.map(({ role }) => role);
}

export async function listApplicationRoleGrants(database: Database, organizationId: string): Promise<ApplicationRoleGrant[]> {
  return await database.select({ userId: applicationRoleAssignment.userId, role: applicationRoleAssignment.role, grantedBy: applicationRoleAssignment.grantedBy, grantedAt: applicationRoleAssignment.grantedAt })
    .from(applicationRoleAssignment)
    .where(and(eq(applicationRoleAssignment.organizationId, organizationId), isNull(applicationRoleAssignment.revokedAt)))
    .orderBy(asc(applicationRoleAssignment.userId), asc(applicationRoleAssignment.role));
}

/** Adds roles the user does not already hold. Existing active grants are left untouched. */
export async function grantApplicationRoles(database: Database, input: Readonly<{ organizationId: string; userId: string; roles: readonly string[]; grantedBy: string }>): Promise<void> {
  if (input.roles.length === 0) return;
  await database.insert(applicationRoleAssignment)
    .values(input.roles.map((role) => ({ organizationId: input.organizationId, userId: input.userId, role, grantedBy: input.grantedBy })))
    .onConflictDoNothing();
}

/**
 * Makes `roles` the user's exact active application roles in one transaction.
 * Removed roles are revoked, not deleted, so the grant history remains.
 */
export async function replaceApplicationRoles(database: Database, input: Readonly<{ organizationId: string; userId: string; roles: readonly string[]; actor: string; now: Date }>): Promise<{ added: string[]; removed: string[] }> {
  return await database.transaction(async (transaction) => {
    const scope = and(eq(applicationRoleAssignment.organizationId, input.organizationId), eq(applicationRoleAssignment.userId, input.userId), isNull(applicationRoleAssignment.revokedAt));
    const current = (await transaction.select({ role: applicationRoleAssignment.role }).from(applicationRoleAssignment).where(scope)).map(({ role }) => role);
    const wanted = [...new Set(input.roles)].sort();
    const added = wanted.filter((role) => !current.includes(role));
    const removed = current.filter((role) => !wanted.includes(role)).sort();
    if (removed.length) await transaction.update(applicationRoleAssignment).set({ revokedAt: input.now, revokedBy: input.actor }).where(and(scope, inArray(applicationRoleAssignment.role, removed)));
    if (added.length) await transaction.insert(applicationRoleAssignment).values(added.map((role) => ({ organizationId: input.organizationId, userId: input.userId, role, grantedBy: input.actor, grantedAt: input.now })));
    return { added, removed };
  });
}

/** Active holders of a role, used to refuse removing the organization's last application administrator. */
export async function applicationRoleHolders(database: Database, organizationId: string, role: string): Promise<string[]> {
  const rows = await database.select({ userId: applicationRoleAssignment.userId }).from(applicationRoleAssignment)
    .where(and(eq(applicationRoleAssignment.organizationId, organizationId), eq(applicationRoleAssignment.role, role), isNull(applicationRoleAssignment.revokedAt)));
  return rows.map(({ userId }) => userId);
}
