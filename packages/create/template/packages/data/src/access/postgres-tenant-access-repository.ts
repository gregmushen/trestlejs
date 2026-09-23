import { createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import type { ApiKeyMetadata, ApiKeyUsageDay, ApplicationRoleAssignment, ApplicationRoleRecord, AuditEntry, Member, Mutation, NewApiKey, ScopeProfile, ServiceAccountRecord, TenantAccessRepository } from "@__TRESTLE_PROJECT_NAME__/domain";
import { sql, type SQL } from "drizzle-orm";

const textArray = (values: readonly string[]) => sql`${`{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`).join(",")}}`}::text[]`;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : typeof value === "string" && value.startsWith("{") ? value.slice(1, -1).split(",").filter(Boolean).map((item) => item.replace(/^"|"$/gu, "")) : [];
const date = (value: unknown): Date | null => value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value));

/** Audit and outbox statements that commit in the same transaction as the mutation. */
export function mutationRecords(mutation: Mutation): SQL[] {
  const { context, audit, event } = mutation;
  const eventId = crypto.randomUUID();
  // Support-session work keeps the operator as actor and carries the session and its reason.
  const reason = audit.reason ?? context.support?.reason ?? context.reason ?? null;
  const payload = context.support ? { ...event.payload, support: { sessionId: context.support.sessionId, operatorId: context.actor.id } } : event.payload;
  return [
    sql`insert into audit_event (name, schema_version, actor_type, actor_id, organization_id, target_type, target_id, reason, summary, outcome, environment, correlation_id, occurred_at, support_session_id)
        values (${audit.name}, 1, ${context.actor.type}, ${context.actor.id}, ${context.organizationId}, ${audit.targetType}, ${audit.targetId}, ${reason}, ${JSON.stringify(audit.summary)}::text::jsonb, ${audit.outcome}, ${context.environment}, ${context.correlationId}, ${context.now}, ${context.support?.sessionId ?? null})`,
    sql`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, correlation_id, idempotency_key, payload, available_at)
        values (${eventId}, ${event.name}, 1, ${context.now}, ${event.resourceType}, ${event.resourceId}, ${context.correlationId}, ${`${event.name}:${eventId}`}, ${JSON.stringify(payload)}::text::jsonb, ${context.now})`,
  ];
}

function apiKey(row: SqlRow): ApiKeyMetadata {
  return {
    id: String(row.id), serviceAccountId: String(row.service_account_id), environment: String(row.environment) as ApiKeyMetadata["environment"], displayPrefix: String(row.display_prefix),
    scopes: strings(row.scopes), expiresAt: date(row.expires_at), allowedCidrs: row.allowed_cidrs ? strings(row.allowed_cidrs) : null,
    rateLimitPerMinute: row.rate_limit_per_minute === null || row.rate_limit_per_minute === undefined ? null : Number(row.rate_limit_per_minute),
    createdBy: String(row.created_by), createdAt: date(row.created_at)!, lastUsedAt: date(row.last_used_at), rotatedFrom: row.rotated_from ? String(row.rotated_from) : null,
    rotatedTo: row.rotated_to ? String(row.rotated_to) : null, revokedAt: date(row.revoked_at),
    name: row.name ? String(row.name) : null, replacedBy: row.replaced_by ? String(row.replaced_by) : null, revocationReason: row.revocation_reason ? String(row.revocation_reason) : null,
  };
}

const serviceAccount = (row: SqlRow): ServiceAccountRecord => ({ id: String(row.id), name: String(row.name), description: String(row.description ?? ""), applicationRoles: strings(row.application_roles), status: row.status === "suspended" ? "suspended" : "active", createdBy: String(row.created_by), createdAt: date(row.created_at)!, deletedAt: date(row.deleted_at), suspensionReason: row.suspension_reason ? String(row.suspension_reason) : null });

const apiKeyColumns = sql`id, service_account_id, environment, display_prefix, scopes, expires_at, allowed_cidrs, rate_limit_per_minute, created_by, created_at, last_used_at, rotated_from, rotated_to, revoked_at, name, replaced_by, revocation_reason`;

/**
 * Tenant repository. Tenant-owned tables use a connection bound to the
 * restricted role and the organization (forced RLS). Better Auth membership
 * rows are read through the identity connection with explicit organization
 * predicates, like the ExecutionContext membership check.
 */
export class PostgresTenantAccessRepository implements TenantAccessRepository {
  private readonly tenant: SqlRunner;
  private readonly identity: SqlRunner;

  constructor(databaseUrl: string, driver: DatabaseDriver | undefined, private readonly organizationId: string) {
    this.tenant = createSqlRunner(tenantConnectionString(databaseUrl, organizationId), driver);
    this.identity = createSqlRunner(databaseUrl, driver);
  }

  private async write(statements: SQL[], mutation: Mutation): Promise<void> {
    if (mutation.context.organizationId !== this.organizationId) throw new Error("Mutation context does not match the repository tenant");
    await this.tenant.atomic([...statements, ...mutationRecords(mutation)]);
  }

  async listMembers(): Promise<Member[]> {
    const rows = await this.identity.query(sql`select m.id, m.user_id, m.role, u.name, u.email from member m join "user" u on u.id = m.user_id where m.organization_id = ${this.organizationId} order by lower(u.name), u.id`);
    return rows.map((row) => ({ memberId: String(row.id), userId: String(row.user_id), name: String(row.name), email: String(row.email), organizationRoles: String(row.role ?? "").split(",").map((role) => role.trim()).filter(Boolean).sort() }));
  }

  async setMemberOrganizationRoles(memberId: string, roles: readonly string[], mutation: Mutation): Promise<void> {
    const updated = await this.identity.query(sql`update member set role = ${roles.join(",")} where id = ${memberId} and organization_id = ${this.organizationId} returning id`);
    if (updated.length !== 1) throw new Error("Member not found");
    await this.tenant.atomic(mutationRecords(mutation));
  }

  async listApplicationRoles(): Promise<ApplicationRoleRecord[]> {
    return (await this.tenant.query(sql`select key, name, description, permissions from application_role where organization_id = ${this.organizationId} order by key`))
      .map((row) => ({ key: String(row.key), name: String(row.name), description: String(row.description ?? ""), permissions: strings(row.permissions) }));
  }

  async saveApplicationRole(role: ApplicationRoleRecord, mutation: Mutation): Promise<void> {
    await this.write([sql`insert into application_role (organization_id, key, name, description, permissions, created_by) values (${this.organizationId}, ${role.key}, ${role.name}, ${role.description}, ${textArray(role.permissions)}, ${mutation.context.actor.id})
      on conflict (organization_id, key) do update set name = excluded.name, description = excluded.description, permissions = excluded.permissions, updated_at = now()`], mutation);
  }

  async deleteApplicationRole(key: string, mutation: Mutation): Promise<void> {
    await this.write([
      sql`update application_role_assignment set revoked_at = ${mutation.context.now}, revoked_by = ${mutation.context.actor.id}, revocation_reason = 'role deleted' where organization_id = ${this.organizationId} and role = ${key} and revoked_at is null`,
      sql`update service_account set application_roles = array_remove(application_roles, ${key}) where organization_id = ${this.organizationId}`,
      sql`delete from application_role where organization_id = ${this.organizationId} and key = ${key}`,
    ], mutation);
  }

  async listApplicationRoleAssignments(userId?: string): Promise<ApplicationRoleAssignment[]> {
    const rows = await this.tenant.query(userId
      ? sql`select user_id, role, granted_by, granted_at from application_role_assignment where organization_id = ${this.organizationId} and user_id = ${userId} and revoked_at is null order by role`
      : sql`select user_id, role, granted_by, granted_at from application_role_assignment where organization_id = ${this.organizationId} and revoked_at is null order by user_id, role`);
    return rows.map((row) => ({ userId: String(row.user_id), role: String(row.role), grantedBy: String(row.granted_by), grantedAt: date(row.granted_at)! }));
  }

  async setUserApplicationRoles(userId: string, roles: readonly string[], mutation: Mutation): Promise<void> {
    await this.write([
      sql`update application_role_assignment set revoked_at = ${mutation.context.now}, revoked_by = ${mutation.context.actor.id}, revocation_reason = 'reassigned'
          where organization_id = ${this.organizationId} and user_id = ${userId} and revoked_at is null and resource_type is null and not (role = any(${textArray(roles)}))`,
      sql`insert into application_role_assignment (organization_id, user_id, role, granted_by, granted_at)
          select ${this.organizationId}, ${userId}, requested.role_key, ${mutation.context.actor.id}, ${mutation.context.now} from unnest(${textArray(roles)}) as requested(role_key)
          where not exists (select 1 from application_role_assignment a where a.organization_id = ${this.organizationId} and a.user_id = ${userId} and a.role = requested.role_key and a.revoked_at is null and a.resource_type is null)`,
    ], mutation);
  }

  async listServiceAccounts(): Promise<ServiceAccountRecord[]> {
    return (await this.tenant.query(sql`select * from service_account where organization_id = ${this.organizationId} order by lower(name)`)).map(serviceAccount);
  }

  async getServiceAccount(id: string): Promise<ServiceAccountRecord | null> {
    const [row] = await this.tenant.query(sql`select * from service_account where organization_id = ${this.organizationId} and id = ${id}`);
    return row ? serviceAccount(row) : null;
  }

  async createServiceAccount(account: ServiceAccountRecord, mutation: Mutation): Promise<void> {
    await this.write([sql`insert into service_account (id, organization_id, name, description, application_roles, status, created_by, created_at) values (${account.id}, ${this.organizationId}, ${account.name}, ${account.description}, ${textArray(account.applicationRoles)}, 'active', ${account.createdBy}, ${account.createdAt})`], mutation);
  }

  async setServiceAccountStatus(id: string, status: "active" | "suspended", reason: string | null, mutation: Mutation): Promise<void> {
    await this.write([status === "suspended"
      ? sql`update service_account set status = 'suspended', suspended_at = ${mutation.context.now}, suspended_by = ${mutation.context.actor.id}, suspension_reason = ${reason} where organization_id = ${this.organizationId} and id = ${id}`
      : sql`update service_account set status = 'active', suspended_at = null, suspended_by = null, suspension_reason = null where organization_id = ${this.organizationId} and id = ${id}`], mutation);
  }

  async updateServiceAccount(id: string, changes: Readonly<{ name: string; description: string }>, mutation: Mutation): Promise<void> {
    await this.write([sql`update service_account set name = ${changes.name}, description = ${changes.description} where organization_id = ${this.organizationId} and id = ${id} and deleted_at is null`], mutation);
  }

  async deleteServiceAccount(id: string, reason: string, mutation: Mutation): Promise<void> {
    const { now, actor } = mutation.context;
    await this.write([
      sql`update api_key set revoked_at = ${now}, revoked_by = ${actor.id}, revocation_reason = ${`service account deleted: ${reason}`} where organization_id = ${this.organizationId} and service_account_id = ${id} and revoked_at is null`,
      sql`update service_account set status = 'suspended', deleted_at = ${now}, deleted_by = ${actor.id}, deletion_reason = ${reason} where organization_id = ${this.organizationId} and id = ${id} and deleted_at is null`,
    ], mutation);
  }

  async findApiKeyByIdempotencyKey(idempotencyKey: string): Promise<ApiKeyMetadata | null> {
    const [row] = await this.tenant.query(sql`select ${apiKeyColumns} from api_key where organization_id = ${this.organizationId} and idempotency_key = ${idempotencyKey}`);
    return row ? apiKey(row) : null;
  }

  async setServiceAccountRoles(id: string, roles: readonly string[], mutation: Mutation): Promise<void> {
    await this.write([sql`update service_account set application_roles = ${textArray(roles)} where organization_id = ${this.organizationId} and id = ${id}`], mutation);
  }

  async listApiKeys(serviceAccountId?: string): Promise<ApiKeyMetadata[]> {
    const rows = await this.tenant.query(serviceAccountId
      ? sql`select ${apiKeyColumns} from api_key where organization_id = ${this.organizationId} and service_account_id = ${serviceAccountId} order by created_at desc`
      : sql`select ${apiKeyColumns} from api_key where organization_id = ${this.organizationId} order by created_at desc`);
    return rows.map(apiKey);
  }

  async getApiKey(id: string): Promise<ApiKeyMetadata | null> {
    const [row] = await this.tenant.query(sql`select ${apiKeyColumns} from api_key where organization_id = ${this.organizationId} and id = ${id}`);
    return row ? apiKey(row) : null;
  }

  private insertKey(key: NewApiKey): SQL {
    return sql`insert into api_key (id, organization_id, service_account_id, environment, display_prefix, verifier, scopes, expires_at, allowed_cidrs, rate_limit_per_minute, created_by, created_at, rotated_from, name, idempotency_key)
      values (${key.id}, ${this.organizationId}, ${key.serviceAccountId}, ${key.environment}, ${key.displayPrefix}, ${key.verifier}, ${textArray(key.scopes)}, ${key.expiresAt}, ${key.allowedCidrs ? textArray(key.allowedCidrs) : null}, ${key.rateLimitPerMinute}, ${key.createdBy}, ${key.createdAt}, ${key.rotatedFrom}, ${key.name ?? null}, ${key.idempotencyKey ?? null})`;
  }

  async insertApiKey(key: NewApiKey, mutation: Mutation): Promise<void> {
    await this.write([this.insertKey(key)], mutation);
  }

  async rotateApiKey(previousId: string, previousExpiresAt: Date, replacement: NewApiKey, mutation: Mutation, replaced = false): Promise<void> {
    await this.write([
      this.insertKey(replacement),
      sql`update api_key set expires_at = ${previousExpiresAt}, rotated_to = ${replacement.id}, replaced_by = ${replaced ? replacement.id : null} where organization_id = ${this.organizationId} and id = ${previousId} and rotated_to is null and revoked_at is null`,
    ], mutation);
  }

  async revokeApiKey(id: string, reason: string, mutation: Mutation): Promise<void> {
    await this.write([sql`update api_key set revoked_at = ${mutation.context.now}, revoked_by = ${mutation.context.actor.id}, revocation_reason = ${reason} where organization_id = ${this.organizationId} and id = ${id} and revoked_at is null`], mutation);
  }

  async apiKeyUsage(id: string): Promise<ApiKeyUsageDay[]> {
    return (await this.tenant.query(sql`select day::text as day, requests, denied from api_key_usage where organization_id = ${this.organizationId} and api_key_id = ${id} order by day desc limit 90`))
      .map((row) => ({ day: String(row.day), requests: Number(row.requests), denied: Number(row.denied) }));
  }

  async listScopeProfiles(): Promise<ScopeProfile[]> {
    return (await this.tenant.query(sql`select id, name, description, scopes from scope_profile where organization_id = ${this.organizationId} order by name`))
      .map((row) => ({ id: String(row.id), name: String(row.name), description: String(row.description ?? ""), scopes: strings(row.scopes) }));
  }

  async createScopeProfile(profile: ScopeProfile, mutation: Mutation): Promise<void> {
    await this.write([sql`insert into scope_profile (id, organization_id, name, description, scopes) values (${profile.id}, ${this.organizationId}, ${profile.name}, ${profile.description}, ${textArray(profile.scopes)})`], mutation);
  }

  async deleteScopeProfile(id: string, mutation: Mutation): Promise<void> {
    await this.write([sql`delete from scope_profile where organization_id = ${this.organizationId} and id = ${id}`], mutation);
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    return (await this.tenant.query(sql`select id, occurred_at, name, actor_type, actor_id, target_type, target_id, reason, outcome, correlation_id from audit_event where organization_id = ${this.organizationId} order by occurred_at desc limit ${Math.min(Math.max(limit, 1), 500)}`))
      .map((row) => ({ id: String(row.id), occurredAt: date(row.occurred_at)!, name: String(row.name), actorType: String(row.actor_type), actorId: String(row.actor_id), targetType: String(row.target_type), targetId: String(row.target_id), reason: row.reason ? String(row.reason) : null, outcome: String(row.outcome), correlationId: String(row.correlation_id) }));
  }
}
