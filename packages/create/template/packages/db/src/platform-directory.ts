import { and, asc, count, desc, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";

import { applicationRoleAssignment } from "./access-schema.js";
import { auditEvent } from "./audit-schema.js";
import { emailDeliveryEvent } from "./email-schema.js";
import { member, organization, user } from "./auth-schema.js";
import type { Database } from "./index.js";
import { serviceAccount } from "./machine-access-schema.js";
import { platformRoleAssignment } from "./platform-schema.js";

/**
 * Cross-tenant directory reads for the platform admin. They run on the
 * trestle_platform connection, which is granted organization and member rows,
 * user identity columns (id, name, email, verification, creation), audit
 * history, and platform-role assignments, and nothing else about a tenant.
 */
const pageSize = (limit: number | undefined, fallback = 50, maximum = 200) => Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit! : fallback), 1), maximum);
const like = (query: string) => `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

export type PlatformMember = Readonly<{ memberId: string; userId: string; name: string; email: string; organizationRole: string; joinedAt: Date }>;
export type PlatformOrganizationDetail = Readonly<{ organization: { id: string; name: string; slug: string | null; createdAt: Date }; members: PlatformMember[] }>;

export async function platformOrganizationDetail(database: Database, organizationId: string): Promise<PlatformOrganizationDetail | null> {
  const [found] = await database.select({ id: organization.id, name: organization.name, slug: organization.slug, createdAt: organization.createdAt }).from(organization).where(eq(organization.id, organizationId)).limit(1);
  if (!found) return null;
  const members = await database.select({ memberId: member.id, userId: member.userId, name: user.name, email: user.email, organizationRole: member.role, joinedAt: member.createdAt })
    .from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.organizationId, organizationId)).orderBy(asc(user.name), asc(user.id)).limit(500);
  return { organization: found, members };
}

export type PlatformUser = Readonly<{
  id: string; name: string; email: string; emailVerified: boolean; createdAt: Date;
  memberships: Array<{ organizationId: string; organizationName: string; organizationRole: string }>;
  platformRoles: string[];
}>;

export async function listPlatformUsers(database: Database, options: Readonly<{ query?: string; limit?: number }> = {}): Promise<PlatformUser[]> {
  const query = options.query?.trim();
  const users = await database.select({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, createdAt: user.createdAt }).from(user)
    .where(query ? or(ilike(user.name, like(query)), ilike(user.email, like(query))) : undefined)
    .orderBy(asc(user.email), asc(user.id)).limit(pageSize(options.limit, 100, 500));
  if (users.length === 0) return [];
  const ids = users.map((item) => item.id);
  const [memberships, roles] = await Promise.all([
    database.select({ userId: member.userId, organizationId: member.organizationId, organizationName: organization.name, organizationRole: member.role })
      .from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(inArray(member.userId, ids)),
    database.select({ userId: platformRoleAssignment.userId, role: platformRoleAssignment.role }).from(platformRoleAssignment)
      .where(and(inArray(platformRoleAssignment.userId, ids), isNull(platformRoleAssignment.revokedAt))),
  ]);
  return users.map((item) => ({
    ...item,
    memberships: memberships.filter((entry) => entry.userId === item.id).map(({ organizationId, organizationName, organizationRole }) => ({ organizationId, organizationName, organizationRole })),
    platformRoles: roles.filter((entry) => entry.userId === item.id).map((entry) => entry.role).sort(),
  }));
}

export type PlatformAuditRecord = Readonly<{
  id: string; occurredAt: Date; name: string; actorType: string; actorId: string; organizationId: string | null; organizationName: string | null;
  targetType: string; targetId: string; reason: string | null; summary: Record<string, unknown>; outcome: string; environment: string; correlationId: string; supportSessionId: string | null;
}>;
export type PlatformAuditFilter = Readonly<{ organizationId?: string; actor?: string; name?: string; correlationId?: string; page?: number; pageSize?: number }>;

const auditColumns = {
  id: auditEvent.id, occurredAt: auditEvent.occurredAt, name: auditEvent.name, actorType: auditEvent.actorType, actorId: auditEvent.actorId,
  organizationId: auditEvent.organizationId, organizationName: organization.name, targetType: auditEvent.targetType, targetId: auditEvent.targetId,
  reason: auditEvent.reason, summary: auditEvent.summary, outcome: auditEvent.outcome, environment: auditEvent.environment, correlationId: auditEvent.correlationId, supportSessionId: auditEvent.supportSessionId,
};

/** Audit history across tenants and platform actions, newest first. Summaries were redacted when recorded. */
export async function listPlatformAuditEvents(database: Database, filter: PlatformAuditFilter = {}): Promise<{ events: PlatformAuditRecord[]; total: number; page: number; pageSize: number }> {
  const size = pageSize(filter.pageSize, 50, 100);
  const page = Math.max(1, Math.trunc(filter.page ?? 1));
  const conditions: SQL[] = [];
  if (filter.organizationId) conditions.push(eq(auditEvent.organizationId, filter.organizationId));
  if (filter.actor) conditions.push(eq(auditEvent.actorId, filter.actor));
  if (filter.name) conditions.push(ilike(auditEvent.name, like(filter.name)));
  if (filter.correlationId) conditions.push(eq(auditEvent.correlationId, filter.correlationId));
  const where = conditions.length ? and(...conditions) : undefined;
  const [rows, [totals]] = await Promise.all([
    database.select(auditColumns).from(auditEvent).leftJoin(organization, eq(organization.id, auditEvent.organizationId)).where(where)
      .orderBy(desc(auditEvent.occurredAt), desc(auditEvent.id)).limit(size).offset((page - 1) * size),
    database.select({ total: count() }).from(auditEvent).where(where),
  ]);
  return { events: rows.map((row) => ({ ...row, summary: row.summary ?? {} })), total: Number(totals?.total ?? 0), page, pageSize: size };
}

export async function platformAuditEvent(database: Database, id: string): Promise<PlatformAuditRecord | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) return null;
  const [row] = await database.select(auditColumns).from(auditEvent).leftJoin(organization, eq(organization.id, auditEvent.organizationId)).where(eq(auditEvent.id, id)).limit(1);
  return row ? { ...row, summary: row.summary ?? {} } : null;
}

export type PlatformRoleAssignmentRecord = Readonly<{ id: string; userId: string; email: string | null; name: string | null; role: string; grantedAt: Date; grantedBy: string; reason: string; revokedAt: Date | null; revokedBy: string | null; revocationReason: string | null }>;

/** Platform-role assignments with the operator's identity; history includes revoked assignments. */
export async function listPlatformRoleAssignments(database: Database, options: Readonly<{ history?: boolean }> = {}): Promise<PlatformRoleAssignmentRecord[]> {
  return await database.select({
    id: platformRoleAssignment.id, userId: platformRoleAssignment.userId, email: user.email, name: user.name, role: platformRoleAssignment.role,
    grantedAt: platformRoleAssignment.grantedAt, grantedBy: platformRoleAssignment.grantedBy, reason: platformRoleAssignment.reason,
    revokedAt: platformRoleAssignment.revokedAt, revokedBy: platformRoleAssignment.revokedBy, revocationReason: platformRoleAssignment.revocationReason,
  }).from(platformRoleAssignment).leftJoin(user, eq(user.id, platformRoleAssignment.userId))
    .where(options.history ? undefined : isNull(platformRoleAssignment.revokedAt))
    .orderBy(desc(platformRoleAssignment.grantedAt)).limit(500);
}

export type PlatformRoleHolder = Readonly<{ kind: "member" | "user" | "service_account"; id: string; organizationId: string; organizationName: string; principalId: string; name: string; detail: string; role: string; email?: string; grantedAt?: Date; grantedBy?: string }>;

/** Organization roles are stored on the membership, comma-separated; parsed exactly as authz parseMembershipRoles does. */
const membershipRoles = (value: string | null) => [...new Set((value ?? "").split(",").map((role) => role.trim()).filter(Boolean))].sort();

/** Who holds organization or application roles, optionally for one role. Active application assignments only. */
export async function listPlatformRoleHolders(database: Database, plane: "organization" | "application", role?: string): Promise<PlatformRoleHolder[]> {
  if (plane === "organization") {
    const rows = await database.select({ id: member.id, organizationId: member.organizationId, organizationName: organization.name, userId: member.userId, name: user.name, email: user.email, roles: member.role })
      .from(member).innerJoin(user, eq(user.id, member.userId)).innerJoin(organization, eq(organization.id, member.organizationId)).limit(2000);
    return rows.flatMap((row) => membershipRoles(row.roles).filter((key) => !role || key === role).map((key): PlatformRoleHolder => ({ kind: "member", id: `${row.id}:${key}`, organizationId: row.organizationId, organizationName: row.organizationName, principalId: row.userId, name: row.name, detail: `${row.email} · ${key}`, role: key, email: row.email })));
  }
  const [users, accounts] = await Promise.all([
    database.select({ id: applicationRoleAssignment.id, organizationId: applicationRoleAssignment.organizationId, organizationName: organization.name, userId: applicationRoleAssignment.userId, name: user.name, email: user.email, role: applicationRoleAssignment.role, grantedAt: applicationRoleAssignment.grantedAt, grantedBy: applicationRoleAssignment.grantedBy })
      .from(applicationRoleAssignment).innerJoin(user, eq(user.id, applicationRoleAssignment.userId)).innerJoin(organization, eq(organization.id, applicationRoleAssignment.organizationId))
      .where(and(isNull(applicationRoleAssignment.revokedAt), role ? eq(applicationRoleAssignment.role, role) : undefined)).limit(2000),
    database.select({ id: serviceAccount.id, organizationId: serviceAccount.organizationId, organizationName: organization.name, name: serviceAccount.name, roles: serviceAccount.applicationRoles, status: serviceAccount.status })
      .from(serviceAccount).innerJoin(organization, eq(organization.id, serviceAccount.organizationId)).limit(2000),
  ]);
  return [
    ...users.map((row): PlatformRoleHolder => ({ kind: "user", id: row.id, organizationId: row.organizationId, organizationName: row.organizationName, principalId: row.userId, name: row.name, detail: `${row.email} · ${row.role}`, role: row.role, email: row.email, grantedAt: row.grantedAt, grantedBy: row.grantedBy })),
    ...accounts.flatMap((row) => row.roles.filter((key) => !role || key === role).map((key): PlatformRoleHolder => ({ kind: "service_account", id: `${row.id}:${key}`, organizationId: row.organizationId, organizationName: row.organizationName, principalId: row.id, name: row.name, detail: `service account · ${row.status} · ${key}`, role: key }))),
  ];
}

export type PlatformServiceAccount = Readonly<{ id: string; organizationId: string; organizationName: string; name: string; applicationRoles: string[]; status: string; createdAt: Date }>;

export async function listPlatformServiceAccounts(database: Database, organizationId?: string): Promise<PlatformServiceAccount[]> {
  return await database.select({ id: serviceAccount.id, organizationId: serviceAccount.organizationId, organizationName: organization.name, name: serviceAccount.name, applicationRoles: serviceAccount.applicationRoles, status: serviceAccount.status, createdAt: serviceAccount.createdAt })
    .from(serviceAccount).innerJoin(organization, eq(organization.id, serviceAccount.organizationId))
    .where(organizationId ? eq(serviceAccount.organizationId, organizationId) : undefined).orderBy(asc(organization.name), asc(serviceAccount.name)).limit(500);
}

export type PlatformAccessAssignments = Readonly<{ organizationName: string; principalName: string; organizationRoles: string[]; applicationRoles: string[]; member: boolean; status?: string }>;

/** The assignments a user or service account holds in one organization, for access explanation. */
export async function platformAccessAssignments(database: Database, organizationId: string, principal: Readonly<{ type: "user" | "service_account"; id: string }>): Promise<PlatformAccessAssignments | null> {
  const [found] = await database.select({ name: organization.name }).from(organization).where(eq(organization.id, organizationId)).limit(1);
  if (!found) return null;
  if (principal.type === "service_account") {
    const [account] = await database.select({ name: serviceAccount.name, roles: serviceAccount.applicationRoles, status: serviceAccount.status }).from(serviceAccount)
      .where(and(eq(serviceAccount.id, principal.id), eq(serviceAccount.organizationId, organizationId))).limit(1);
    return account ? { organizationName: found.name, principalName: account.name, organizationRoles: [], applicationRoles: account.roles, member: true, status: account.status } : null;
  }
  const [person] = await database.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, principal.id)).limit(1);
  if (!person) return null;
  const [membership, assignments] = await Promise.all([
    database.select({ roles: member.role }).from(member).where(and(eq(member.userId, principal.id), eq(member.organizationId, organizationId))).limit(1),
    database.select({ role: applicationRoleAssignment.role }).from(applicationRoleAssignment)
      .where(and(eq(applicationRoleAssignment.userId, principal.id), eq(applicationRoleAssignment.organizationId, organizationId), isNull(applicationRoleAssignment.revokedAt))),
  ]);
  return { organizationName: found.name, principalName: `${person.name} <${person.email}>`, organizationRoles: membership[0] ? membershipRoles(membership[0].roles) : [], applicationRoles: assignments.map((row) => row.role), member: Boolean(membership[0]) };
}

export type PlatformEmailEvent = Readonly<{ id: string; emailDeliveryId: string; status: string; occurredAt: Date; receivedAt: Date }>;

/** Provider delivery-status events, newest first. The table holds no bodies, recipients, or templates. */
export async function listPlatformEmailEvents(database: Database, options: Readonly<{ status?: string; limit?: number }> = {}): Promise<PlatformEmailEvent[]> {
  return await database.select({ id: emailDeliveryEvent.id, emailDeliveryId: emailDeliveryEvent.emailDeliveryId, status: emailDeliveryEvent.status, occurredAt: emailDeliveryEvent.occurredAt, receivedAt: emailDeliveryEvent.receivedAt })
    .from(emailDeliveryEvent).where(options.status ? eq(emailDeliveryEvent.status, options.status) : undefined)
    .orderBy(desc(emailDeliveryEvent.occurredAt), desc(emailDeliveryEvent.id)).limit(pageSize(options.limit, 100, 500));
}
