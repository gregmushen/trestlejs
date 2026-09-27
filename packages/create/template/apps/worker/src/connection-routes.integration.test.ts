import { createAuthorizationAttempt, createTenantDatabase, listIntegrationConnections } from "@__TRESTLE_PROJECT_NAME__/db";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { attemptTag, registerConnectionBackend } from "./connection-backend.js";
import { localConnectionBackend, localSignatureHeader, recordLocalConnection, resetLocalConnections, signLocalCallback } from "./connection-backend-local.js";
import { handleConnectionCallback } from "./connection-routes.js";
import type { WorkerEnvironment } from "./worker-environment.js";

const connectionString = process.env.TRESTLE_SYSTEM_TEST_DATABASE_URL ?? process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const run = `cbk${Date.now()}`;
const organizationId = `${run}-org`;
const environment = { DATABASE_URL: connectionString ?? "", DATABASE_DRIVER: "postgres-js", BETTER_AUTH_SECRET: "x".repeat(32), APP_ENV: "local", TRESTLE_CONNECTION_BACKEND: "local" } as WorkerEnvironment;
const log = createLogger({ correlationId: run });

async function callback(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return await handleConnectionCallback({ environment, backendName: "local", signatureHeader: localSignatureHeader, rawBody, headers: new Headers({ [localSignatureHeader]: await signLocalCallback(rawBody) }), correlationId: run, log });
}

suite("connection backend callbacks", () => {
  registerConnectionBackend(localConnectionBackend);

  afterAll(async () => {
    resetLocalConnections();
    await sql!`delete from audit_event where organization_id = ${organizationId}`;
    await sql!`delete from integration_authorization_attempt where organization_id = ${organizationId}`;
    await sql!`delete from integration_connection where organization_id = ${organizationId}`;
    await sql!`delete from integration_provider_event where backend_connection_id like ${`${run}-%`}`;
    await sql!.end();
  });

  it("quarantines callbacks without a known attempt and never trusts tag organizations", async () => {
    const base = { type: "auth", operation: "creation", success: true, connectionId: `${run}-c`, providerConfigKey: "github" };
    expect(await callback({ ...base, tags: { organization_id: organizationId } })).toEqual({ status: 202, body: { quarantined: true } });
    expect(await callback({ ...base, tags: { [attemptTag]: crypto.randomUUID(), organization_id: organizationId } })).toEqual({ status: 202, body: { quarantined: true } });
    expect(await callback({ type: "auth", operation: "refresh", success: false, connectionId: `${run}-unknown`, providerConfigKey: "github", error: { type: "refresh_failed" } })).toEqual({ status: 202, body: { quarantined: true } });
    expect(await sql!`select id from integration_connection where organization_id = ${organizationId}`).toHaveLength(0);
    // Each quarantined callback is recorded once, with safe metadata and no organization taken from tags.
    const events = await sql!`select kind, outcome, reason, organization_id from integration_provider_event where backend_connection_id like ${`${run}-%`} order by received_at`;
    expect(events.map((row) => row.reason)).toEqual(["unbound", "unknown_attempt", "unknown_connection"]);
    expect(events.every((row) => row.outcome === "quarantined" && row.organization_id === null)).toBe(true);
    expect(await callback({ ...base, tags: { organization_id: organizationId } })).toEqual({ status: 202, body: { quarantined: true } });
    expect(await sql!`select id from integration_provider_event where backend_connection_id like ${`${run}-%`}`).toHaveLength(3);
  });

  it("binds a verified connection to the attempt's tenant once, then flags a refresh failure once", async () => {
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    const attemptId = await createAuthorizationAttempt(tenant, { organizationId, environment: "local", backend: "local", providerConfigKey: "github", initiatedBy: "user:alice", now: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    const created = { type: "auth", operation: "creation", success: true, connectionId: `${run}-c`, providerConfigKey: "github", provider: "github", tags: { [attemptTag]: attemptId, organization_id: "someone-else" } };
    // The backend does not hold the reported connection: nothing is bound.
    expect(await callback(created)).toEqual({ status: 202, body: { quarantined: true } });
    recordLocalConnection({ providerConfigKey: "github", backendConnectionId: `${run}-c` }, "github");
    expect(await callback({ ...created, providerConfigKey: "slack" })).toEqual({ status: 202, body: { quarantined: true } });
    expect(await callback(created)).toEqual({ status: 202, body: { state: "connected" } });
    expect(await callback(created)).toEqual({ status: 200, body: { duplicate: true } });
    const [connection] = await listIntegrationConnections(tenant, { organizationId, environment: "local" });
    expect(connection).toMatchObject({ state: "connected", provider: "github", generation: 1 });
    const refresh = { type: "auth", operation: "refresh", success: false, connectionId: `${run}-c`, providerConfigKey: "github", error: { type: "refresh_token_external_error" } };
    expect(await callback(refresh)).toEqual({ status: 202, body: { state: "reauthorization_required" } });
    expect(await callback(refresh)).toEqual({ status: 200, body: { duplicate: true } });
    expect((await listIntegrationConnections(tenant, { organizationId, environment: "local" }))[0]).toMatchObject({ state: "reauthorization_required" });
    const audits = await sql!`select name, actor_type from audit_event where organization_id = ${organizationId} order by occurred_at`;
    expect(audits.map((row) => row.name)).toEqual(["integrations.connection.connected", "integrations.connection.reauthorization_required"]);
    const applied = await sql!`select outcome, organization_id from integration_provider_event where backend_connection_id = ${`${run}-c`} and outcome = 'applied'`;
    expect(applied).toEqual([{ outcome: "applied", organization_id: organizationId }, { outcome: "applied", organization_id: organizationId }]);
    await tenant.$client.end();
  });

  it("records a failed authorization against the attempt without creating a Connection", async () => {
    const tenant = createTenantDatabase(connectionString!, "postgres-js", organizationId);
    const attemptId = await createAuthorizationAttempt(tenant, { organizationId, environment: "local", backend: "local", providerConfigKey: "notion", initiatedBy: "user:alice", now: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    const failed = { type: "auth", operation: "creation", success: false, connectionId: `${run}-n`, providerConfigKey: "notion", tags: { [attemptTag]: attemptId }, error: { type: "access_denied" } };
    expect(await callback(failed)).toEqual({ status: 202, body: { state: "failed" } });
    expect(await callback(failed)).toEqual({ status: 200, body: { duplicate: true } });
    const [attempt] = await sql!`select status, failure_category from integration_authorization_attempt where id = ${attemptId}`;
    expect(attempt).toEqual({ status: "failed", failure_category: "access_denied" });
    await tenant.$client.end();
  });
});
