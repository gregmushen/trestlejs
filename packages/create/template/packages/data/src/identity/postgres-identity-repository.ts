import { createSqlRunner, tenantConnectionString, type DatabaseDriver, type SqlRow, type SqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import type { Mutation } from "@__TRESTLE_PROJECT_NAME__/domain";
import type { DirectoryProviderKind, ExternalRoleMapping, SourcedAssignment } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { sql, type SQL } from "drizzle-orm";

import { mutationRecords } from "../access/postgres-tenant-access-repository.js";

const date = (value: unknown): Date | null => value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value));

export type IdentityConnection = Readonly<{
  id: string;
  provider: "better_auth" | "workos";
  kind: "sso" | "directory";
  externalId: string;
  domain: string | null;
  state: "active" | "pending" | "disabled";
  lastEventAt: Date | null;
  lastError: string | null;
  createdBy: string;
  createdAt: Date;
}>;

export type StoredMapping = ExternalRoleMapping & Readonly<{ id: string; createdBy: string; createdAt: Date }>;
export type DirectoryEventRecord = Readonly<{ id: string; provider: string; type: string; outcome: string; receivedAt: Date }>;

const connection = (row: SqlRow): IdentityConnection => ({
  id: String(row.id), provider: String(row.provider) as IdentityConnection["provider"], kind: String(row.kind) as IdentityConnection["kind"], externalId: String(row.external_id),
  domain: row.domain ? String(row.domain) : null, state: String(row.state) as IdentityConnection["state"], lastEventAt: date(row.last_event_at), lastError: row.last_error ? String(row.last_error) : null,
  createdBy: String(row.created_by), createdAt: date(row.created_at)!,
});

/**
 * Tenant identity configuration on the forced-RLS connection: provider
 * bindings (never credentials), group-to-role mappings, directory events, and
 * directory-owned application role assignments. Every change commits with its
 * audit and outbox records.
 */
export class PostgresIdentityRepository {
  private readonly tenant: SqlRunner;
  constructor(databaseUrl: string, driver: DatabaseDriver | undefined, private readonly organizationId: string) {
    this.tenant = createSqlRunner(tenantConnectionString(databaseUrl, organizationId), driver);
  }

  private async write(statements: SQL[], mutation?: Mutation): Promise<void> {
    if (mutation && mutation.context.organizationId !== this.organizationId) throw new Error("Mutation context does not match the repository tenant");
    await this.tenant.atomic([...statements, ...(mutation ? mutationRecords(mutation) : [])]);
  }

  async connections(): Promise<IdentityConnection[]> {
    return (await this.tenant.query(sql`select * from identity_connection where organization_id = ${this.organizationId} order by kind, provider, domain`)).map(connection);
  }

  async bindConnection(value: Omit<IdentityConnection, "id" | "lastEventAt" | "lastError" | "createdAt">, mutation: Mutation): Promise<void> {
    await this.write([sql`insert into identity_connection (id, organization_id, provider, kind, external_id, domain, state, created_by)
      values (${crypto.randomUUID()}, ${this.organizationId}, ${value.provider}, ${value.kind}, ${value.externalId}, ${value.domain}, ${value.state}, ${value.createdBy})
      on conflict (provider, kind, external_id, coalesce(domain, '')) do update set state = excluded.state, updated_at = now()
      where identity_connection.organization_id = ${this.organizationId}`], mutation);
  }

  async setConnectionState(provider: string, kind: string, externalId: string, state: IdentityConnection["state"], mutation: Mutation): Promise<void> {
    await this.write([sql`update identity_connection set state = ${state}, updated_at = now() where organization_id = ${this.organizationId} and provider = ${provider} and kind = ${kind} and external_id = ${externalId}`], mutation);
  }

  async removeConnection(provider: string, kind: string, externalId: string, mutation: Mutation): Promise<void> {
    await this.write([
      sql`delete from external_role_mapping where organization_id = ${this.organizationId} and connection_id = ${externalId} and ${kind} = 'directory'`,
      sql`delete from identity_connection where organization_id = ${this.organizationId} and provider = ${provider} and kind = ${kind} and external_id = ${externalId}`,
    ], mutation);
  }

  async recordConnectionOutcome(provider: string, kind: string, externalId: string, failure: string | null): Promise<void> {
    await this.tenant.query(sql`update identity_connection set last_event_at = now(), last_error = ${failure}, updated_at = now() where organization_id = ${this.organizationId} and provider = ${provider} and kind = ${kind} and external_id = ${externalId}`);
  }

  async mappings(provider?: DirectoryProviderKind, connectionId?: string): Promise<StoredMapping[]> {
    return (await this.tenant.query(sql`select * from external_role_mapping where organization_id = ${this.organizationId}
      and (${provider ?? null}::text is null or provider = ${provider ?? null}) and (${connectionId ?? null}::text is null or connection_id = ${connectionId ?? null}) order by target_plane, target_role`))
      .map((row) => ({ id: String(row.id), provider: String(row.provider) as DirectoryProviderKind, connectionId: String(row.connection_id), externalGroupId: String(row.external_group_id), targetPlane: String(row.target_plane) as "organization" | "application", targetRole: String(row.target_role), createdBy: String(row.created_by), createdAt: date(row.created_at)! }));
  }

  async createMapping(mapping: ExternalRoleMapping, createdBy: string, mutation: Mutation): Promise<string> {
    const id = crypto.randomUUID();
    await this.write([sql`insert into external_role_mapping (id, organization_id, provider, connection_id, external_group_id, target_plane, target_role, created_by)
      values (${id}, ${this.organizationId}, ${mapping.provider}, ${mapping.connectionId}, ${mapping.externalGroupId}, ${mapping.targetPlane}, ${mapping.targetRole}, ${createdBy})`], mutation);
    return id;
  }

  async deleteMapping(id: string, mutation: Mutation): Promise<boolean> {
    const [row] = await this.tenant.query(sql`select id from external_role_mapping where organization_id = ${this.organizationId} and id = ${id}`);
    if (!row) return false;
    await this.write([sql`delete from external_role_mapping where organization_id = ${this.organizationId} and id = ${id}`], mutation);
    return true;
  }

  async directoryEvents(limit = 25): Promise<DirectoryEventRecord[]> {
    return (await this.tenant.query(sql`select id, provider, type, outcome, received_at from directory_event where organization_id = ${this.organizationId} order by received_at desc limit ${limit}`))
      .map((row) => ({ id: String(row.id), provider: String(row.provider), type: String(row.type), outcome: String(row.outcome), receivedAt: date(row.received_at)! }));
  }

  async hasDirectoryEvent(id: string): Promise<boolean> {
    return (await this.tenant.query(sql`select 1 from directory_event where organization_id = ${this.organizationId} and id = ${id}`)).length > 0;
  }

  /** Assignments one directory connection owns for a user, in the shape the reconciler compares. */
  async sourcedAssignments(userId: string, provider: DirectoryProviderKind, connectionId: string): Promise<Array<SourcedAssignment & { id: string }>> {
    return (await this.tenant.query(sql`select id, role, source_group_id from application_role_assignment where organization_id = ${this.organizationId} and user_id = ${userId}
      and source_provider = ${provider} and source_connection_id = ${connectionId} and revoked_at is null`))
      .map((row) => ({ id: String(row.id), plane: "application" as const, role: String(row.role), source: { provider, connectionId, externalGroupId: String(row.source_group_id ?? "") } }));
  }

  async activeRoles(userId: string): Promise<string[]> {
    return (await this.tenant.query(sql`select role from application_role_assignment where organization_id = ${this.organizationId} and user_id = ${userId} and revoked_at is null`)).map((row) => String(row.role));
  }

  /**
   * Applies one directory event's application-role changes, records the event
   * for idempotency, and writes one audit/outbox pair per change, atomically.
   */
  async applyDirectoryChanges(input: Readonly<{
    eventId: string; provider: DirectoryProviderKind; type: string; userId: string | null; connectionId: string; now: Date; correlationId: string; environment: ApplicationEnvironment;
    grant: readonly SourcedAssignment[]; revoke: ReadonlyArray<SourcedAssignment & { id: string }>; revokeReason: string; outcome: string;
    extraAudit?: ReadonlyArray<{ name: string; summary: Record<string, unknown> }>;
  }>): Promise<void> {
    const actor = `${input.provider}:${input.connectionId}`;
    const statements: SQL[] = [sql`insert into directory_event (id, organization_id, provider, type, outcome, received_at) values (${input.eventId}, ${this.organizationId}, ${input.provider}, ${input.type}, ${input.outcome}, ${input.now}) on conflict (id) do nothing`];
    const audit: Array<{ name: string; summary: Record<string, unknown> }> = [...(input.extraAudit ?? [])];
    for (const assignment of input.revoke) {
      statements.push(sql`update application_role_assignment set revoked_at = ${input.now}, revoked_by = ${actor}, revocation_reason = ${input.revokeReason} where organization_id = ${this.organizationId} and id = ${assignment.id} and revoked_at is null`);
      audit.push({ name: "directory.role.revoked", summary: { plane: "application", role: assignment.role, group: assignment.source?.externalGroupId ?? null } });
    }
    for (const assignment of input.grant) {
      statements.push(sql`insert into application_role_assignment (organization_id, user_id, role, granted_by, granted_at, source_provider, source_connection_id, source_group_id)
        values (${this.organizationId}, ${input.userId}, ${assignment.role}, ${actor}, ${input.now}, ${input.provider}, ${input.connectionId}, ${assignment.source?.externalGroupId ?? null})`);
      audit.push({ name: "directory.role.granted", summary: { plane: "application", role: assignment.role, group: assignment.source?.externalGroupId ?? null } });
    }
    const context = { organizationId: this.organizationId, actor: { type: "system" as const, id: actor }, correlationId: input.correlationId, environment: input.environment, now: input.now };
    for (const entry of audit) {
      statements.push(...mutationRecords({ context, audit: { name: entry.name, targetType: "user", targetId: input.userId ?? "unknown", summary: entry.summary, outcome: "succeeded" }, event: { name: "access.directory_user_reconciled", resourceType: "user", resourceId: input.userId ?? "unknown", payload: { organizationId: this.organizationId, change: entry.name, ...entry.summary } } }));
    }
    await this.tenant.atomic(statements);
  }
}
