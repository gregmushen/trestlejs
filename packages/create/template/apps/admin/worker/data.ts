import { activePlatformRoles, auditEvent, organization, passkey, platformRoleAssignment, user, type Database } from "@__TRESTLE_PROJECT_NAME__/db";
import { count, countDistinct, desc, eq, isNull, sql } from "drizzle-orm";

/**
 * Platform reads for the admin, always on the trestle_platform connection.
 * They return counts and sanitized metadata only; grants and RLS limit what
 * the role can see even if a query were widened.
 */
export async function platformRolesFor(database: Database, userId: string): Promise<string[]> {
  return await activePlatformRoles(database, userId);
}

/** Counts need `platform.overview.read`; recent audit activity additionally needs `platform.audit.read`. */
export async function overview(database: Database, options: Readonly<{ includeAudit: boolean }>) {
  const [organizations] = await database.select({ total: count(organization.id) }).from(organization);
  const [users] = await database.select({ total: count(user.id) }).from(user);
  const [operators] = await database.select({ total: countDistinct(platformRoleAssignment.userId) }).from(platformRoleAssignment).where(isNull(platformRoleAssignment.revokedAt));
  const recentAudit = !options.includeAudit ? [] : await database.select({
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

/** The strongest factor the person has enrolled: a passkey, then two-factor. Reads Better Auth's tables, so it runs on the auth connection. */
export async function strongestEnrolledFactor(database: Database, userId: string): Promise<"phishing_resistant" | "mfa" | null> {
  const [credential] = await database.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId)).limit(1);
  if (credential) return "phishing_resistant";
  const [person] = await database.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId)).limit(1);
  return person?.twoFactorEnabled ? "mfa" : null;
}
