import { activePlatformRoles, auditEvent, organization, platformRoleAssignment, user, type Database } from "@__TRESTLE_PROJECT_NAME__/db";
import { count, countDistinct, desc, isNull, sql } from "drizzle-orm";

/**
 * Platform reads for the admin, always on the trestle_platform connection.
 * They return counts and sanitized metadata only; grants and RLS limit what
 * the role can see even if a query were widened.
 */
export async function platformRolesFor(database: Database, userId: string): Promise<string[]> {
  return await activePlatformRoles(database, userId);
}

export async function overview(database: Database) {
  const [organizations] = await database.select({ total: count(organization.id) }).from(organization);
  const [users] = await database.select({ total: count(user.id) }).from(user);
  const [operators] = await database.select({ total: countDistinct(platformRoleAssignment.userId) }).from(platformRoleAssignment).where(isNull(platformRoleAssignment.revokedAt));
  const recentAudit = await database.select({
    name: auditEvent.name, occurredAt: auditEvent.occurredAt, actorType: auditEvent.actorType, organizationId: auditEvent.organizationId, outcome: auditEvent.outcome, correlationId: auditEvent.correlationId,
  }).from(auditEvent).orderBy(desc(auditEvent.occurredAt)).limit(10);
  return {
    organizations: Number(organizations?.total ?? 0),
    users: Number(users?.total ?? 0),
    operators: Number(operators?.total ?? 0),
    recentAudit: recentAudit.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })),
  };
}

export async function databaseReachable(database: Database): Promise<boolean> {
  try { await database.execute(sql`select 1`); return true; } catch { return false; }
}
