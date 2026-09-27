import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger, loggerSecretsFromEnvironment, type Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import {
  clearConnectionCleanup, completeAuthorizationAttempt, createAuthorizationAttempt, createDatabase, createTenantDatabase, failAuthorizationAttempt, listIntegrationConnections,
  outboxApplicationConnectionString, recordProviderEvent, requireConnectionReauthorization, resolveAuthorizationAttempt, resolveIntegrationConnection, revokeIntegrationConnection, usableConnectionRef, type Database,
} from "@__TRESTLE_PROJECT_NAME__/db";
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  authorizationAttemptTtlMs, configuredConnectionBackend, connectionBackend, ConnectionBackendError, ConnectionBackendUnavailable,
  type BackendEvent, type ConnectionBackend, type ConnectionBackendName, type ProxyRequest, type ProxyResponse,
} from "./connection-backend.js";
import { localSignatureHeader } from "./connection-backend-local.js";
import { nangoSignatureHeader } from "./connection-backend-nango.js";
import { auditTenantAction } from "./audit.js";
import { requireExecutionContext, type AppVariables } from "./execution-context.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * Tenant Connections through the selected connection backend (§8.3 of the
 * integration spec). The organization comes from the authenticated execution
 * context or, for backend callbacks, from the persisted authorization attempt
 * or Connection, never from a callback's tags. Provider tokens never pass
 * through here: the browser receives only a short-lived connect session token.
 */
export const connectionRoutes = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();

const providerConfigKeySchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/u);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const worker = (environment: AuthEnvironment) => environment as WorkerEnvironment;
const appEnvironment = (environment: AuthEnvironment) => environment.APP_ENV ?? "local";
/** TRESTLE_CONNECTION_INTEGRATIONS: the comma-separated backend integration keys tenants may connect. */
export function allowedIntegrations(environment: WorkerEnvironment): string[] {
  return (environment.TRESTLE_CONNECTION_INTEGRATIONS ?? "").split(",").map((key) => key.trim()).filter((key) => providerConfigKeySchema.safeParse(key).success);
}
const expectedOrigin = (environment: AuthEnvironment) => environment.WEB_ORIGIN ?? environment.BETTER_AUTH_URL ?? "http://localhost:42069";

connectionRoutes.get("/api/tenant/integrations/connections", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.integrations.read" });
  const connections = await listIntegrationConnections(execution.data, { organizationId: execution.tenant.organizationId, environment: appEnvironment(context.env) });
  return context.json({ connections: connections.map(({ organizationId: _organization, ...connection }) => ({
    ...connection, connectedAt: connection.connectedAt?.toISOString() ?? null, revokedAt: connection.revokedAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(), updatedAt: connection.updatedAt.toISOString(),
  })) });
});

connectionRoutes.post("/api/tenant/integrations/connect-sessions", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.integrations.manage", rejectApiKeys: true });
  if (context.req.header("origin") !== expectedOrigin(context.env)) return context.json({ error: "Invalid request origin" }, 403);
  if (!context.req.header("content-type")?.toLowerCase().startsWith("application/json")) return context.json({ error: "JSON content type required" }, 415);
  const parsed = z.object({ providerConfigKey: providerConfigKeySchema }).strict().safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "Invalid connect session request" }, 400);
  // Only integrations the application declared may be connected; an empty list allows none.
  if (!allowedIntegrations(worker(context.env)).includes(parsed.data.providerConfigKey)) return context.json({ error: "integration_not_allowed", message: "This integration is not enabled for this application" }, 403);
  let backend: ConnectionBackend;
  try { backend = configuredConnectionBackend(worker(context.env)); }
  catch (error) { return context.json({ error: "Connections are not configured", detail: error instanceof ConnectionBackendUnavailable ? error.message : "unavailable" }, 503); }
  const now = execution.clock.now();
  // The durable attempt exists before the backend session, so every callback has a binding to check.
  const attemptId = await createAuthorizationAttempt(execution.data, {
    organizationId: execution.tenant.organizationId, environment: appEnvironment(context.env), backend: backend.name, providerConfigKey: parsed.data.providerConfigKey,
    initiatedBy: `${execution.principal.kind}:${execution.principal.id}`, now, expiresAt: new Date(now.getTime() + authorizationAttemptTtlMs),
  });
  let session: { token: string; expiresAt: Date };
  try { session = await backend.createAuthorizationSession(worker(context.env), { attemptId, providerConfigKey: parsed.data.providerConfigKey }); }
  catch (error) {
    await failAuthorizationAttempt(execution.data, { organizationId: execution.tenant.organizationId, attemptId, category: error instanceof ConnectionBackendError ? error.category : "session_failed", now });
    execution.log.warn("integrations.authorization.session_failed", { backend: backend.name, category: error instanceof ConnectionBackendError ? error.category : "unknown" });
    return context.json({ error: "The connection backend did not start a session", retryable: true }, 502);
  }
  execution.log.info("integrations.authorization.started", { backend: backend.name, attemptId });
  await auditTenantAction(execution, context.env.APP_ENV, { name: "integrations.authorization.started", target: { type: "integration_authorization_attempt", id: attemptId }, summary: { backend: backend.name, providerConfigKey: parsed.data.providerConfigKey } });
  context.header("Cache-Control", "no-store");
  return context.json({ sessionToken: session.token, expiresAt: session.expiresAt.toISOString() }, 201);
});

connectionRoutes.delete("/api/tenant/integrations/connections/:id", requireExecutionContext, async (context) => {
  const execution = context.get("execution");
  execution.access.require({ permission: "organization.integrations.disconnect" });
  if (context.req.header("origin") !== expectedOrigin(context.env)) return context.json({ error: "Invalid request origin" }, 403);
  const connectionId = context.req.param("id");
  if (!uuidPattern.test(connectionId)) return context.json({ error: "Invalid connection ID" }, 400);
  const now = execution.clock.now();
  // Local use stops first; deleting the backend credential follows and may be retried later.
  const ref = await revokeIntegrationConnection(execution.data, {
    organizationId: execution.tenant.organizationId, connectionId, actor: `${execution.principal.kind}:${execution.principal.id}`, now,
    audit: { actor: { type: execution.principal.kind, id: execution.principal.id }, environment: appEnvironment(context.env), correlationId: execution.correlation.correlationId },
  });
  if (!ref) return context.json({ error: "Connection not found" }, 404);
  let cleanupPending = true;
  try {
    const backend = connectionBackend(worker(context.env));
    if (backend && backend.name === ref.backend && backend.describe(worker(context.env)).configured) {
      await backend.revoke(worker(context.env), ref);
      await clearConnectionCleanup(execution.data, { organizationId: execution.tenant.organizationId, connectionId, now });
      cleanupPending = false;
    }
  } catch (error) {
    execution.log.warn("integrations.connection.cleanup_pending", { connectionId, category: error instanceof ConnectionBackendError ? error.category : "unavailable" });
  }
  execution.log.info("integrations.connection.revoked", { connectionId, cleanupPending });
  return context.json({ connection: { id: connectionId, state: "revoked", cleanupPending } });
});

type CallbackOutcome = Readonly<{ status: 200 | 202 | 400 | 503; body: Record<string, unknown> }>;

/**
 * One authenticated backend callback. Unknown attempts and Connections,
 * cross-environment or mismatched bindings are quarantined: acknowledged so
 * the backend stops retrying, logged, and never applied. A repeat of an
 * applied callback changes nothing and answers `duplicate`.
 */
export async function handleConnectionCallback(input: Readonly<{
  environment: WorkerEnvironment; backendName: Exclude<ConnectionBackendName, "none">; signatureHeader: string; rawBody: string; headers: Headers; correlationId: string; log: Logger; now?: () => Date;
  /** Replaceable in tests. */
  database?: { app: () => Database; tenant: (organizationId: string) => Database; close: (database: Database) => Promise<void> };
}>): Promise<CallbackOutcome> {
  let backend: ConnectionBackend | null;
  try { backend = connectionBackend(input.environment); } catch { backend = null; }
  if (!backend || backend.name !== input.backendName || !backend.describe(input.environment).inboundVerification) return { status: 503, body: { error: "Connection callbacks are not configured" } };
  if (!input.headers.get(input.signatureHeader)) return { status: 400, body: { error: "Missing signature" } };
  let event: BackendEvent | null;
  try { event = await backend.verifyInbound(input.environment, input.rawBody, input.headers); }
  catch (error) {
    if (error instanceof ConnectionBackendUnavailable) return { status: 503, body: { error: "Connection callbacks are not configured" } };
    throw error;
  }
  if (!event) {
    input.log.warn("integrations.callback.rejected", { backend: backend.name, reason: "invalid_signature_or_payload" });
    return { status: 400, body: { error: "Invalid callback" } };
  }
  const eventKey = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.rawBody)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const outcome = await applyConnectionCallback(input, backend, event);
  // Recorded only once the outcome is decided; a retryable failure leaves nothing, so the redelivery is processed again.
  if (outcome.record) {
    const recorder = input.database?.app() ?? createDatabase(outboxApplicationConnectionString(input.environment.DATABASE_URL), input.environment.DATABASE_DRIVER);
    try {
      await recordProviderEvent(recorder, { backend: backend.name, environment: input.environment.APP_ENV ?? "local", eventKey, kind: outcome.record.kind, outcome: outcome.record.outcome, reason: outcome.record.reason ?? null,
        providerConfigKey: "providerConfigKey" in event ? event.providerConfigKey : null, backendConnectionId: "backendConnectionId" in event ? event.backendConnectionId : null, organizationId: outcome.record.organizationId ?? null });
    } finally { await (input.database?.close ?? (async (database: Database) => { await (database.$client as { end?: () => Promise<void> }).end?.(); }))(recorder); }
  }
  return { status: outcome.status, body: outcome.body };
}

type AppliedCallback = CallbackOutcome & Readonly<{ record?: Readonly<{ kind: string; outcome: "applied" | "duplicate" | "quarantined" | "ignored"; reason?: string; organizationId?: string }> }>;

async function applyConnectionCallback(input: Parameters<typeof handleConnectionCallback>[0], backend: ConnectionBackend, event: BackendEvent): Promise<AppliedCallback> {
  if (event.kind === "ignored") {
    input.log.info("integrations.callback.ignored", { backend: backend.name, type: event.type });
    // Not recorded: a backend may forward many callbacks Trestle does not act on (syncs, forwarded webhooks).
    return { status: 200, body: { ignored: true } };
  }
  const environmentName = input.environment.APP_ENV ?? "local";
  const now = (input.now ?? (() => new Date()))();
  const databases = input.database ?? {
    app: () => createDatabase(outboxApplicationConnectionString(input.environment.DATABASE_URL), input.environment.DATABASE_DRIVER),
    tenant: (organizationId: string) => createTenantDatabase(input.environment.DATABASE_URL, input.environment.DATABASE_DRIVER, organizationId),
    close: async (database: Database) => { await (database.$client as { end?: () => Promise<void> }).end?.(); },
  };
  const audit = { actor: { type: "system" as const, id: `connection-backend:${backend.name}` }, environment: environmentName, correlationId: input.correlationId };
  const quarantine = (reason: string): AppliedCallback => {
    input.log.warn("integrations.callback.quarantined", { backend: backend.name, kind: event.kind, reason });
    return { status: 202, body: { quarantined: true }, record: { kind: event.kind, outcome: "quarantined", reason } };
  };
  const app = databases.app();
  try {
    if (event.kind === "credential_failed") {
      const bound = await resolveIntegrationConnection(app, { backend: backend.name, environment: environmentName, providerConfigKey: event.providerConfigKey, backendConnectionId: event.backendConnectionId });
      if (!bound) return quarantine("unknown_connection");
      const tenant = databases.tenant(bound.organizationId);
      try {
        const changed = await requireConnectionReauthorization(tenant, { organizationId: bound.organizationId, connectionId: bound.connectionId, category: event.errorCategory, now, audit });
        input.log.info(changed ? "integrations.connection.reauthorization_required" : "integrations.callback.duplicate", { backend: backend.name, connectionId: bound.connectionId });
        const record = { kind: event.kind, outcome: changed ? "applied" as const : "duplicate" as const, organizationId: bound.organizationId };
        return changed ? { status: 202, body: { state: "reauthorization_required" }, record } : { status: 200, body: { duplicate: true }, record };
      } finally { await databases.close(tenant); }
    }
    if (!event.attemptId) return quarantine("unbound");
    const attempt = await resolveAuthorizationAttempt(app, event.attemptId);
    if (!attempt) return quarantine("unknown_attempt");
    if (attempt.environment !== environmentName || attempt.backend !== backend.name || attempt.providerConfigKey !== event.providerConfigKey) return quarantine("binding_mismatch");
    const tenant = databases.tenant(attempt.organizationId);
    try {
      if (!event.success) {
        const failed = await failAuthorizationAttempt(tenant, { organizationId: attempt.organizationId, attemptId: event.attemptId, category: event.errorCategory ?? "unknown", now });
        input.log.info(failed ? "integrations.authorization.failed" : "integrations.callback.duplicate", { backend: backend.name, attemptId: event.attemptId, category: event.errorCategory });
        const record = { kind: event.kind, outcome: failed ? "applied" as const : "duplicate" as const, reason: "authorization_failed", organizationId: attempt.organizationId };
        return failed ? { status: 202, body: { state: "failed" }, record } : { status: 200, body: { duplicate: true }, record };
      }
      const ref = { providerConfigKey: event.providerConfigKey, backendConnectionId: event.backendConnectionId };
      let provider: string | null;
      // The callback's claim is checked against the backend itself before anything is bound.
      try { provider = (await backend.completeAuthorization(input.environment, ref)).provider ?? event.provider; }
      catch (error) {
        if (error instanceof ConnectionBackendError && error.category === "connection_not_found") return quarantine("backend_connection_missing");
        input.log.warn("integrations.callback.deferred", { backend: backend.name, category: error instanceof ConnectionBackendError ? error.category : "unavailable" });
        return { status: 503, body: { error: "connection_backend_unavailable", retryable: true } };
      }
      const result = await completeAuthorizationAttempt(tenant, { organizationId: attempt.organizationId, attemptId: event.attemptId, backend: backend.name, ...ref, provider, now, audit });
      if (result.state === "rejected") return quarantine(result.reason);
      if (result.state === "duplicate") {
        input.log.info("integrations.callback.duplicate", { backend: backend.name, connectionId: result.connectionId });
        return { status: 200, body: { duplicate: true }, record: { kind: event.kind, outcome: "duplicate", organizationId: attempt.organizationId } };
      }
      input.log.info("integrations.connection.connected", { backend: backend.name, connectionId: result.connectionId, generation: result.generation, reconnected: result.reconnected });
      return { status: 202, body: { state: "connected" }, record: { kind: event.kind, outcome: "applied", organizationId: attempt.organizationId } };
    } finally { await databases.close(tenant); }
  } finally { await databases.close(app); }
}

async function callbackRoute(context: Context<{ Bindings: AuthEnvironment; Variables: AppVariables }>, backendName: Exclude<ConnectionBackendName, "none">, signatureHeader: string) {
  const log = createLogger({ correlationId: context.get("correlationId"), provider: backendName }, undefined, { secretValues: loggerSecretsFromEnvironment(context.env) });
  const outcome = await handleConnectionCallback({ environment: worker(context.env), backendName, signatureHeader, rawBody: await context.req.text(), headers: context.req.raw.headers, correlationId: context.get("correlationId"), log });
  return context.json(outcome.body, outcome.status);
}

connectionRoutes.post("/webhooks/nango", async (context) => await callbackRoute(context, "nango", nangoSignatureHeader));

/** Local only (404 elsewhere): the local backend's signed stand-in for a hosted flow's callback. */
connectionRoutes.post("/api/dev/connections/callback", async (context) => {
  if (context.env.APP_ENV && context.env.APP_ENV !== "local") return context.notFound();
  return await callbackRoute(context, "local", localSignatureHeader);
});

/**
 * An authenticated provider call through a tenant Connection. Re-reads the
 * Connection's state and generation first; a provider 401 moves it to
 * `reauthorization_required`. Adapters never receive the credential.
 */
export async function proxyThroughConnection(input: Readonly<{ environment: WorkerEnvironment; database: Database; organizationId: string; connectionId: string; request: ProxyRequest; correlationId: string; now: Date }>): Promise<ProxyResponse & { generation: number }> {
  const backend = configuredConnectionBackend(input.environment);
  const ref = await usableConnectionRef(input.database, { organizationId: input.organizationId, connectionId: input.connectionId });
  if (!ref || ref.backend !== backend.name) throw new ConnectionBackendUnavailable("The Connection is not usable");
  const response = await backend.proxy(input.environment, ref, input.request);
  if (response.reauthorizationRequired) {
    await requireConnectionReauthorization(input.database, { organizationId: input.organizationId, connectionId: input.connectionId, category: "provider_unauthorized", now: input.now,
      audit: { actor: { type: "system", id: `connection-backend:${backend.name}` }, environment: input.environment.APP_ENV ?? "local", correlationId: input.correlationId } });
  }
  return { ...response, generation: ref.generation };
}
