import { and, asc, count, desc, eq, sql } from "drizzle-orm";

import { recordAuditEvent, type AuditEventInput } from "./audit.js";
import type { Database } from "./index.js";
import { integrationAuthorizationAttempt, integrationConnection } from "./integration-schema.js";

export type ConnectionState = "disconnected" | "authorizing" | "connected" | "degraded" | "reauthorization_required" | "revoked";
export const connectionStates = ["disconnected", "authorizing", "connected", "degraded", "reauthorization_required", "revoked"] as const;

/** A Connection's safe read model: never a token, and the backend reference only as an opaque ID. */
export type ConnectionSummary = Readonly<{
  id: string; organizationId: string; environment: string; backend: string; providerConfigKey: string; provider: string | null;
  state: ConnectionState; generation: number; cleanupPending: boolean; connectedAt: Date | null; revokedAt: Date | null; createdAt: Date; updatedAt: Date;
}>;

/** The backend reference an adapter needs to proxy or revoke; usable only through the backend. */
export type ConnectionBackendRef = Readonly<{ backend: string; providerConfigKey: string; backendConnectionId: string }>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const summaryColumns = {
  id: integrationConnection.id, organizationId: integrationConnection.organizationId, environment: integrationConnection.environment, backend: integrationConnection.backend,
  providerConfigKey: integrationConnection.providerConfigKey, provider: integrationConnection.provider, state: integrationConnection.state, generation: integrationConnection.generation,
  cleanupPending: integrationConnection.cleanupPending, connectedAt: integrationConnection.connectedAt, revokedAt: integrationConnection.revokedAt,
  createdAt: integrationConnection.createdAt, updatedAt: integrationConnection.updatedAt,
};
const toSummary = (row: Record<keyof typeof summaryColumns, unknown>): ConnectionSummary => ({ ...row, state: row.state as ConnectionState, cleanupPending: row.cleanupPending !== null } as ConnectionSummary);
const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<Record<string, unknown>>;

/** The organization's Connections in one environment, newest first. Tenant RLS bounds the rows as well. */
export async function listIntegrationConnections(database: Database, input: Readonly<{ organizationId: string; environment: string; limit?: number }>): Promise<ConnectionSummary[]> {
  const rows = await database.select(summaryColumns).from(integrationConnection)
    .where(and(eq(integrationConnection.organizationId, input.organizationId), eq(integrationConnection.environment, input.environment)))
    .orderBy(desc(integrationConnection.updatedAt), asc(integrationConnection.id)).limit(Math.min(Math.max(input.limit ?? 50, 1), 100));
  return rows.map(toSummary);
}

/** Records a durable, single-use attempt before any backend session is minted. */
export async function createAuthorizationAttempt(database: Database, input: Readonly<{ organizationId: string; environment: string; backend: string; providerConfigKey: string; initiatedBy: string; now: Date; expiresAt: Date }>): Promise<string> {
  const [row] = await database.insert(integrationAuthorizationAttempt).values({
    organizationId: input.organizationId, environment: input.environment, backend: input.backend, providerConfigKey: input.providerConfigKey,
    initiatedBy: input.initiatedBy, expiresAt: input.expiresAt, createdAt: input.now,
  }).returning();
  return row!.id;
}

export type ResolvedAuthorizationAttempt = Readonly<{ organizationId: string; environment: string; backend: string; providerConfigKey: string; status: string; expiresAt: Date }>;

/**
 * Looks an attempt up by ID before any tenant is known (a verified backend
 * callback carries only the ID). The SECURITY DEFINER resolver returns the
 * persisted binding; the caller then acts on the tenant connection it names.
 */
export async function resolveAuthorizationAttempt(database: Database, attemptId: string): Promise<ResolvedAuthorizationAttempt | null> {
  if (!uuidPattern.test(attemptId)) return null;
  const [row] = rowsOf(await database.execute(sql`select organization_id, environment, backend, provider_config_key, status, expires_at from trestle_resolve_integration_attempt(${attemptId}::uuid)`));
  return row ? { organizationId: String(row.organization_id), environment: String(row.environment), backend: String(row.backend), providerConfigKey: String(row.provider_config_key), status: String(row.status), expiresAt: new Date(row.expires_at as string) } : null;
}

/** Looks a Connection up by its backend reference, for backend callbacks about an existing Connection. */
export async function resolveIntegrationConnection(database: Database, input: Readonly<{ backend: string; environment: string; providerConfigKey: string; backendConnectionId: string }>): Promise<Readonly<{ organizationId: string; connectionId: string }> | null> {
  const [row] = rowsOf(await database.execute(sql`select organization_id, id from trestle_resolve_integration_connection(${input.backend}, ${input.environment}, ${input.providerConfigKey}, ${input.backendConnectionId})`));
  return row ? { organizationId: String(row.organization_id), connectionId: String(row.id) } : null;
}

export type CompleteAuthorizationResult =
  | Readonly<{ state: "connected"; connectionId: string; generation: number; reconnected: boolean }>
  | Readonly<{ state: "duplicate"; connectionId: string }>
  | Readonly<{ state: "rejected"; reason: "attempt_not_found" | "attempt_used" | "attempt_expired" | "binding_mismatch" }>;

/**
 * Binds a verified backend connection to the attempt's tenant, once. Runs on
 * the tenant connection named by the persisted attempt. A repeat of the same
 * completion is a duplicate; a different backend connection for a used
 * attempt is rejected. Reconnecting the same backend connection starts a new
 * generation of the existing Connection.
 */
export async function completeAuthorizationAttempt(database: Database, input: Readonly<{
  organizationId: string; attemptId: string; backend: string; providerConfigKey: string; backendConnectionId: string; provider: string | null; now: Date;
  audit: Omit<AuditEventInput, "summary" | "target" | "name" | "organizationId">;
}>): Promise<CompleteAuthorizationResult> {
  return await database.transaction(async (transaction) => {
    const [attempt] = await transaction.select().from(integrationAuthorizationAttempt)
      .where(and(eq(integrationAuthorizationAttempt.id, input.attemptId), eq(integrationAuthorizationAttempt.organizationId, input.organizationId))).for("update").limit(1);
    if (!attempt) return { state: "rejected", reason: "attempt_not_found" } as const;
    if (attempt.backend !== input.backend || attempt.providerConfigKey !== input.providerConfigKey) return { state: "rejected", reason: "binding_mismatch" } as const;
    if (attempt.status === "completed" && attempt.connectionId) {
      const [bound] = await transaction.select({ backendConnectionId: integrationConnection.backendConnectionId }).from(integrationConnection).where(eq(integrationConnection.id, attempt.connectionId)).limit(1);
      return bound?.backendConnectionId === input.backendConnectionId ? { state: "duplicate", connectionId: attempt.connectionId } as const : { state: "rejected", reason: "attempt_used" } as const;
    }
    if (attempt.status !== "pending") return { state: "rejected", reason: "attempt_used" } as const;
    if (attempt.expiresAt.getTime() <= input.now.getTime()) {
      await transaction.update(integrationAuthorizationAttempt).set({ status: "failed", failureCategory: "expired", completedAt: input.now }).where(eq(integrationAuthorizationAttempt.id, attempt.id));
      return { state: "rejected", reason: "attempt_expired" } as const;
    }
    const [existing] = await transaction.select({ id: integrationConnection.id, generation: integrationConnection.generation, state: integrationConnection.state }).from(integrationConnection)
      .where(and(eq(integrationConnection.organizationId, input.organizationId), eq(integrationConnection.backend, input.backend), eq(integrationConnection.environment, attempt.environment),
        eq(integrationConnection.providerConfigKey, input.providerConfigKey), eq(integrationConnection.backendConnectionId, input.backendConnectionId))).for("update").limit(1);
    let connectionId: string;
    let generation = 1;
    if (existing) {
      generation = existing.generation + 1;
      connectionId = existing.id;
      await transaction.update(integrationConnection).set({ state: "connected", generation, provider: input.provider, revokedAt: null, cleanupPending: null, connectedAt: input.now, updatedAt: input.now, updatedBy: attempt.initiatedBy })
        .where(eq(integrationConnection.id, existing.id));
    } else {
      const [created] = await transaction.insert(integrationConnection).values({
        organizationId: input.organizationId, environment: attempt.environment, backend: input.backend, providerConfigKey: input.providerConfigKey, backendConnectionId: input.backendConnectionId,
        provider: input.provider, state: "connected", createdBy: attempt.initiatedBy, updatedBy: attempt.initiatedBy, connectedAt: input.now, createdAt: input.now, updatedAt: input.now,
      }).returning();
      connectionId = created!.id;
    }
    await transaction.update(integrationAuthorizationAttempt).set({ status: "completed", connectionId, completedAt: input.now }).where(eq(integrationAuthorizationAttempt.id, attempt.id));
    await recordAuditEvent(transaction, { ...input.audit, name: "integrations.connection.connected", organizationId: input.organizationId, target: { type: "integration_connection", id: connectionId },
      summary: { backend: input.backend, providerConfigKey: input.providerConfigKey, provider: input.provider, generation, initiatedBy: attempt.initiatedBy } });
    return { state: "connected", connectionId, generation, reconnected: Boolean(existing) } as const;
  });
}

/** Records a failed authorization reported by the backend. The Connection (if any) is unchanged. */
export async function failAuthorizationAttempt(database: Database, input: Readonly<{ organizationId: string; attemptId: string; category: string; now: Date }>): Promise<boolean> {
  const updated = await database.update(integrationAuthorizationAttempt).set({ status: "failed", failureCategory: input.category.slice(0, 64), completedAt: input.now })
    .where(and(eq(integrationAuthorizationAttempt.id, input.attemptId), eq(integrationAuthorizationAttempt.organizationId, input.organizationId), eq(integrationAuthorizationAttempt.status, "pending")))
    .returning();
  return updated.length > 0;
}

/**
 * Moves a usable Connection to `reauthorization_required` (refresh failure,
 * revoked grant, or a provider 401). Already-flagged, revoked, or
 * disconnected Connections are left alone, so a repeated report is a no-op.
 */
export async function requireConnectionReauthorization(database: Database, input: Readonly<{ organizationId: string; connectionId: string; category: string; now: Date; audit: Omit<AuditEventInput, "summary" | "target" | "name" | "organizationId"> }>): Promise<boolean> {
  return await database.transaction(async (transaction) => {
    const updated = await transaction.update(integrationConnection).set({ state: "reauthorization_required", updatedAt: input.now, updatedBy: `${input.audit.actor.type}:${input.audit.actor.id}` })
      .where(and(eq(integrationConnection.id, input.connectionId), eq(integrationConnection.organizationId, input.organizationId), sql`${integrationConnection.state} IN ('connected', 'degraded')`))
      .returning();
    if (updated.length === 0) return false;
    await recordAuditEvent(transaction, { ...input.audit, name: "integrations.connection.reauthorization_required", organizationId: input.organizationId,
      target: { type: "integration_connection", id: input.connectionId }, summary: { category: input.category.slice(0, 64), generation: updated[0]!.generation } });
    return true;
  });
}

/**
 * Revokes local use first: new work stops at once. The backend reference is
 * returned so the caller can delete the backend credential afterwards; the
 * row keeps `cleanupPending` until `clearConnectionCleanup` records that.
 */
export async function revokeIntegrationConnection(database: Database, input: Readonly<{ organizationId: string; connectionId: string; actor: string; now: Date; audit: Omit<AuditEventInput, "summary" | "target" | "name" | "organizationId"> }>): Promise<ConnectionBackendRef | null> {
  if (!uuidPattern.test(input.connectionId)) return null;
  return await database.transaction(async (transaction) => {
    const [row] = await transaction.update(integrationConnection).set({ state: "revoked", revokedAt: input.now, cleanupPending: "backend_delete", updatedAt: input.now, updatedBy: input.actor })
      .where(and(eq(integrationConnection.id, input.connectionId), eq(integrationConnection.organizationId, input.organizationId), sql`${integrationConnection.state} <> 'revoked'`))
      .returning();
    if (!row) return null;
    await recordAuditEvent(transaction, { ...input.audit, name: "integrations.connection.revoked", organizationId: input.organizationId,
      target: { type: "integration_connection", id: input.connectionId }, summary: { backend: row.backend, providerConfigKey: row.providerConfigKey, generation: row.generation } });
    return { backend: row.backend, providerConfigKey: row.providerConfigKey, backendConnectionId: row.backendConnectionId };
  });
}

/** Records that the backend credential behind a revoked Connection was deleted. */
export async function clearConnectionCleanup(database: Database, input: Readonly<{ organizationId: string; connectionId: string; now: Date }>): Promise<void> {
  await database.update(integrationConnection).set({ cleanupPending: null, updatedAt: input.now })
    .where(and(eq(integrationConnection.id, input.connectionId), eq(integrationConnection.organizationId, input.organizationId), eq(integrationConnection.state, "revoked")));
}

export type PlatformConnection = ConnectionSummary;

/** Connections across organizations for the platform admin, on the trestle_platform connection. Never a backend connection ID. */
export async function listPlatformIntegrationConnections(database: Database, options: Readonly<{ state?: ConnectionState; limit?: number }> = {}): Promise<{ connections: PlatformConnection[]; counts: Record<ConnectionState, number> }> {
  const [rows, grouped] = await Promise.all([
    database.select(summaryColumns).from(integrationConnection).where(options.state ? eq(integrationConnection.state, options.state) : undefined)
      .orderBy(desc(integrationConnection.updatedAt), asc(integrationConnection.id)).limit(Math.min(Math.max(options.limit ?? 100, 1), 200)),
    database.select({ state: integrationConnection.state, total: count() }).from(integrationConnection).groupBy(integrationConnection.state),
  ]);
  const counts = Object.fromEntries(connectionStates.map((state) => [state, 0])) as Record<ConnectionState, number>;
  for (const row of grouped) if ((connectionStates as readonly string[]).includes(row.state)) counts[row.state as ConnectionState] = Number(row.total);
  return { connections: rows.map(toSummary), counts };
}

/** The backend reference and current generation of a usable Connection, for a proxied provider call. Null unless connected or degraded. */
export async function usableConnectionRef(database: Database, input: Readonly<{ organizationId: string; connectionId: string }>): Promise<(ConnectionBackendRef & { generation: number }) | null> {
  if (!uuidPattern.test(input.connectionId)) return null;
  const [row] = await database.select({ backend: integrationConnection.backend, providerConfigKey: integrationConnection.providerConfigKey, backendConnectionId: integrationConnection.backendConnectionId, generation: integrationConnection.generation })
    .from(integrationConnection).where(and(eq(integrationConnection.id, input.connectionId), eq(integrationConnection.organizationId, input.organizationId), sql`${integrationConnection.state} IN ('connected', 'degraded')`)).limit(1);
  return row ?? null;
}
