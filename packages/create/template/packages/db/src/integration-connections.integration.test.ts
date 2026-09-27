import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, createPlatformDatabase, createTenantDatabase } from "./index.js";
import {
  clearConnectionCleanup, completeAuthorizationAttempt, createAuthorizationAttempt, failAuthorizationAttempt, listIntegrationConnections, listPlatformIntegrationConnections,
  requireConnectionReauthorization, resolveAuthorizationAttempt, resolveIntegrationConnection, revokeIntegrationConnection, usableConnectionRef,
} from "./integration-connections.js";
import { outboxApplicationConnectionString } from "./outbox.js";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `conn${Date.now()}`;
const organizationId = `${run}-org`;
const otherOrganizationId = `${run}-other`;
const audit = { actor: { type: "system" as const, id: "connection-backend:local" }, environment: "local", correlationId: `${run}-corr` };
const now = new Date();

suite("integration Connections", () => {
  afterAll(async () => {
    await sql!`delete from audit_event where organization_id in (${organizationId}, ${otherOrganizationId})`;
    await sql!`delete from integration_authorization_attempt where organization_id in (${organizationId}, ${otherOrganizationId})`;
    await sql!`delete from integration_connection where organization_id in (${organizationId}, ${otherOrganizationId})`;
    await sql!.end();
  });

  it("binds a verified backend connection once to the attempt's tenant, then reconnects as a new generation", async () => {
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    const app = createDatabase(outboxApplicationConnectionString(connectionString!), "postgres-js");
    const attemptId = await createAuthorizationAttempt(tenant, { organizationId, environment: "local", backend: "local", providerConfigKey: "github", initiatedBy: "user:alice", now, expiresAt: new Date(now.getTime() + 60_000) });
    // The resolver finds the attempt without a tenant; the organization comes from the row.
    expect(await resolveAuthorizationAttempt(app, attemptId)).toMatchObject({ organizationId, environment: "local", backend: "local", providerConfigKey: "github", status: "pending" });
    expect(await resolveAuthorizationAttempt(app, crypto.randomUUID())).toBeNull();
    expect(await resolveAuthorizationAttempt(app, "not-a-uuid")).toBeNull();
    const input = { organizationId, attemptId, backend: "local", providerConfigKey: "github", backendConnectionId: `${run}-c1`, provider: "github", now, audit };
    const first = await completeAuthorizationAttempt(tenant, input);
    expect(first).toMatchObject({ state: "connected", generation: 1, reconnected: false });
    const connectionId = (first as { connectionId: string }).connectionId;
    expect(await completeAuthorizationAttempt(tenant, input)).toEqual({ state: "duplicate", connectionId });
    expect(await completeAuthorizationAttempt(tenant, { ...input, backendConnectionId: `${run}-c2` })).toEqual({ state: "rejected", reason: "attempt_used" });
    expect(await resolveIntegrationConnection(app, { backend: "local", environment: "local", providerConfigKey: "github", backendConnectionId: `${run}-c1` })).toEqual({ organizationId, connectionId });
    const second = await createAuthorizationAttempt(tenant, { organizationId, environment: "local", backend: "local", providerConfigKey: "github", initiatedBy: "user:alice", now, expiresAt: new Date(now.getTime() + 60_000) });
    expect(await completeAuthorizationAttempt(tenant, { ...input, attemptId: second })).toMatchObject({ state: "connected", connectionId, generation: 2, reconnected: true });
    const [event] = await sql!`select actor_type, actor_id, summary from audit_event where organization_id = ${organizationId} and name = 'integrations.connection.connected' order by occurred_at limit 1`;
    expect(event).toMatchObject({ actor_type: "system", actor_id: "connection-backend:local" });
    await Promise.all([tenant.$client.end(), app.$client.end()]);
  });

  it("keeps Connections and attempts inside their tenant under forced RLS", async () => {
    const other = createTenantDatabase(connectionString!, "postgres-js", otherOrganizationId);
    expect(await listIntegrationConnections(other, { organizationId, environment: "local" })).toEqual([]);
    expect(await other.execute(`select id from integration_authorization_attempt`)).toHaveLength(0);
    const attemptId = await createAuthorizationAttempt(createTenantDatabase(connectionString!, "postgres-js", organizationId), { organizationId, environment: "local", backend: "local", providerConfigKey: "github", initiatedBy: "user:alice", now, expiresAt: new Date(now.getTime() + 60_000) });
    // Another tenant cannot complete someone else's attempt even with its ID.
    expect(await completeAuthorizationAttempt(other, { organizationId, attemptId, backend: "local", providerConfigKey: "github", backendConnectionId: `${run}-x`, provider: null, now, audit })).toEqual({ state: "rejected", reason: "attempt_not_found" });
    await expect(sql!`set role trestle_app; insert into integration_connection (organization_id, environment, backend, provider_config_key, backend_connection_id, state, created_by, updated_by) values ('x', 'local', 'local', 'k', 'y', 'connected', 'u', 'u')`.simple()).rejects.toThrow();
    await sql!`reset role`;
    await other.$client.end();
  });

  it("rejects expired attempts and records failures without touching Connections", async () => {
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    const expired = await createAuthorizationAttempt(tenant, { organizationId, environment: "local", backend: "local", providerConfigKey: "slack", initiatedBy: "user:alice", now: new Date(now.getTime() - 120_000), expiresAt: new Date(now.getTime() - 60_000) });
    expect(await completeAuthorizationAttempt(tenant, { organizationId, attemptId: expired, backend: "local", providerConfigKey: "slack", backendConnectionId: `${run}-s`, provider: null, now, audit })).toEqual({ state: "rejected", reason: "attempt_expired" });
    const mismatched = await createAuthorizationAttempt(tenant, { organizationId, environment: "local", backend: "local", providerConfigKey: "slack", initiatedBy: "user:alice", now, expiresAt: new Date(now.getTime() + 60_000) });
    expect(await completeAuthorizationAttempt(tenant, { organizationId, attemptId: mismatched, backend: "local", providerConfigKey: "github", backendConnectionId: `${run}-s`, provider: null, now, audit })).toEqual({ state: "rejected", reason: "binding_mismatch" });
    expect(await failAuthorizationAttempt(tenant, { organizationId, attemptId: mismatched, category: "access_denied", now })).toBe(true);
    expect(await failAuthorizationAttempt(tenant, { organizationId, attemptId: mismatched, category: "access_denied", now })).toBe(false);
    await tenant.$client.end();
  });

  it("moves a Connection to reauthorization_required once, then revokes local use before backend cleanup", async () => {
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    const [connection] = await listIntegrationConnections(tenant, { organizationId, environment: "local" });
    expect(connection).toMatchObject({ state: "connected", generation: 2 });
    expect(await usableConnectionRef(tenant, { organizationId, connectionId: connection!.id })).toMatchObject({ backend: "local", providerConfigKey: "github", generation: 2 });
    expect(await requireConnectionReauthorization(tenant, { organizationId, connectionId: connection!.id, category: "refresh_failed", now, audit })).toBe(true);
    expect(await requireConnectionReauthorization(tenant, { organizationId, connectionId: connection!.id, category: "refresh_failed", now, audit })).toBe(false);
    expect(await usableConnectionRef(tenant, { organizationId, connectionId: connection!.id })).toBeNull();
    const ref = await revokeIntegrationConnection(tenant, { organizationId, connectionId: connection!.id, actor: "user:alice", now, audit });
    expect(ref).toMatchObject({ backend: "local", providerConfigKey: "github", backendConnectionId: `${run}-c1` });
    expect(await revokeIntegrationConnection(tenant, { organizationId, connectionId: connection!.id, actor: "user:alice", now, audit })).toBeNull();
    expect((await listIntegrationConnections(tenant, { organizationId, environment: "local" }))[0]).toMatchObject({ state: "revoked", cleanupPending: true });
    await clearConnectionCleanup(tenant, { organizationId, connectionId: connection!.id, now });
    expect((await listIntegrationConnections(tenant, { organizationId, environment: "local" }))[0]).toMatchObject({ state: "revoked", cleanupPending: false });
    await tenant.$client.end();
  });

  it("lists Connections across tenants for the platform, without backend connection IDs", async () => {
    const platform = createPlatformDatabase(connectionString!, "postgres-js");
    const result = await listPlatformIntegrationConnections(platform);
    expect(result.connections.some((item) => item.organizationId === organizationId)).toBe(true);
    expect(result.counts.revoked).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain(`${run}-c1`);
    await expect(platform.execute(`select id from integration_authorization_attempt limit 1`)).rejects.toThrow();
    await platform.$client.end();
  });
});
