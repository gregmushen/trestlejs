import { scimManagement, supportsNativeTransactions, type AuthEnvironment, type ScimScope } from "@__TRESTLE_PROJECT_NAME__/auth";
import { applicationRoles, organizationRoles } from "@__TRESTLE_PROJECT_NAME__/authz";
import { PostgresIdentityRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { createSqlRunner, applicationConnectionString } from "@__TRESTLE_PROJECT_NAME__/db";
import { AccessDomainError, type Mutation } from "@__TRESTLE_PROJECT_NAME__/domain";
import { IdentityVerificationError, MappingError, reconcileExternalAssignments, validateMapping, WorkOSClient, WorkOSDirectoryEvents, WorkOSError, type DirectoryEvent } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { sql } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";

import { authCapabilities, workerAuth } from "./auth.js";
import type { AppExecutionContext, AppVariables } from "./execution-context.js";
import { operationContext } from "./webhook-routes.js";

type Environment = { Bindings: AuthEnvironment; Variables: AppVariables };

/** Replaceable for tests. */
export const identityDependencies = {
  repository: (environment: AuthEnvironment, organizationId: string) => new PostgresIdentityRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
  workos: (environment: AuthEnvironment): WorkOSClient | null => environment.WORKOS_API_KEY && environment.WORKOS_CLIENT_ID
    ? new WorkOSClient({ apiKey: environment.WORKOS_API_KEY, clientId: environment.WORKOS_CLIENT_ID, ...(environment.WORKOS_API_URL ? { baseUrl: environment.WORKOS_API_URL } : {}) })
    : null,
};

const allScopes: readonly ScimScope[] = ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"];
const credentialLifetimeMs = 365 * 24 * 3_600_000;

const schemas = {
  sso: z.object({
    providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/u, "use 3-40 lowercase letters, digits, and hyphens"),
    issuer: z.url(),
    domain: z.string().regex(/^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/u, "enter a domain such as example.com"),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2_000),
    discoveryEndpoint: z.url().optional(),
  }).strict(),
  workosOrganization: z.object({ organizationId: z.string().regex(/^org_[A-Za-z0-9]+$/u) }).strict(),
  workosDirectory: z.object({ directoryId: z.string().regex(/^directory_[A-Za-z0-9]+$/u) }).strict(),
  mapping: z.object({ provider: z.enum(["better_auth_scim", "workos"]), connectionId: z.string().min(1).max(200), externalGroupId: z.string().min(1).max(200), targetPlane: z.string(), targetRole: z.string() }).strict(),
};

const knownRoles = { organization: organizationRoles.list().map((role) => role.key), application: applicationRoles.list().map((role) => role.key) };

function mutation(execution: AppExecutionContext, name: string, targetType: string, targetId: string, summary: Record<string, unknown>): Mutation {
  return {
    context: operationContext(execution),
    audit: { name, targetType, targetId, summary, outcome: "succeeded" },
    event: { name, resourceType: targetType, resourceId: targetId, payload: { organizationId: execution.tenant.organizationId, ...summary } },
  };
}

/** Better Auth API errors carry safe, user-facing messages; anything else stays generic. */
async function viaAuth<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkOSError) throw new AccessDomainError(error.status === 404 ? "not_found" : "invalid", error.status === 401 || error.status === 403 ? "WorkOS rejected the configured credentials" : error.status ? `WorkOS responded ${error.status}` : "WorkOS could not be reached");
    const apiError = error as { status?: string | number; statusCode?: number; body?: { message?: string; code?: string }; message?: string };
    if (apiError && (apiError.body?.message || apiError.statusCode)) {
      const status = String(apiError.status ?? "");
      throw new AccessDomainError(status === "NOT_FOUND" ? "not_found" : status === "CONFLICT" ? "conflict" : "invalid", apiError.body?.message ?? "The identity provider request was rejected");
    }
    throw error;
  }
}

/** Which organization, if any, already owns a provider connection (resolved without cross-tenant reads). */
async function boundOrganization(environment: AuthEnvironment, provider: string, kind: "sso" | "directory", externalId: string): Promise<string | null> {
  const [row] = await createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER).query(sql`select trestle_resolve_identity_connection(${provider}, ${kind}, ${externalId}) as organization_id`);
  return row?.organization_id ? String(row.organization_id) : null;
}

async function assertBindable(environment: AuthEnvironment, organizationId: string, provider: string, kind: "sso" | "directory", externalId: string): Promise<void> {
  const owner = await boundOrganization(environment, provider, kind, externalId);
  if (owner && owner !== organizationId) throw new AccessDomainError("conflict", "That connection is already bound to another organization");
}

function owner(environment: AuthEnvironment) {
  return createSqlRunner(environment.DATABASE_URL, environment.DATABASE_DRIVER);
}

type SsoApi = {
  registerSSOProvider(input: { body: Record<string, unknown>; headers: Headers }): Promise<unknown>;
  requestDomainVerification(input: { body: { providerId: string }; headers: Headers }): Promise<{ domainVerificationToken: string }>;
  verifyDomain(input: { body: { providerId: string }; headers: Headers }): Promise<unknown>;
  deleteSSOProvider(input: { body: { providerId: string }; headers: Headers }): Promise<unknown>;
};
const ssoApi = (environment: AuthEnvironment) => workerAuth(environment).api as unknown as SsoApi;

/** Why an enabled capability cannot run in this deployment, if it cannot. */
export function identityReadiness(environment: AuthEnvironment) {
  const scim = authCapabilities.directory === "better-auth-scim";
  const workos = authCapabilities.sso === "workos";
  return {
    sso: authCapabilities.sso === "better-auth" && !supportsNativeTransactions(environment)
      ? "Better Auth SSO needs interactive transactions; set DATABASE_DRIVER=postgres-js."
      : workos && !(environment.WORKOS_API_KEY && environment.WORKOS_CLIENT_ID) ? "WorkOS credentials are not configured; run trestle setup." : null,
    directory: scim && !supportsNativeTransactions(environment) ? "SCIM needs interactive transactions; set DATABASE_DRIVER=postgres-js and run trestle identity verify-scim."
      : scim && !scimManagement(workerAuth(environment)) ? "SCIM is not available: SCIM_CREDENTIAL_SECRET is not configured."
        : authCapabilities.directory === "workos" && !environment.WORKOS_WEBHOOK_SECRET ? "WORKOS_WEBHOOK_SECRET is not configured; run trestle setup." : null,
  };
}

/** Settings -> Identity (docs/INTEGRATION_STRATEGY.md §5). Route policies live in packages/authz/src/routes.ts. */
export function registerIdentityRoutes(routes: Hono<Environment>) {
  for (const path of ["/api/tenant/identity", "/api/tenant/identity/*"]) {
    routes.use(path, async (context, next) => {
      if (authCapabilities.sso === "disabled" && authCapabilities.directory === "disabled") return context.json({ error: "not_enabled", message: "Enterprise identity is not enabled for this application" }, 404);
      await next();
    });
  }

  routes.get("/api/tenant/identity", async (context) => {
    const execution = context.get("execution");
    const organizationId = execution.tenant.organizationId;
    const repository = identityDependencies.repository(context.env, organizationId);
    const [connections, mappings, events] = await Promise.all([repository.connections(), repository.mappings(), repository.directoryEvents()]);
    const ssoProviders = authCapabilities.sso === "better-auth"
      ? (await owner(context.env).query(sql`select provider_id, issuer, domain, domain_verified from sso_provider where organization_id = ${organizationId} order by provider_id`))
        .map((row) => ({ providerId: String(row.provider_id), issuer: String(row.issuer), domain: String(row.domain), domainVerified: row.domain_verified === true || (context.env.APP_ENV ?? "local") === "local" }))
      : [];
    const management = authCapabilities.directory === "better-auth-scim" ? scimManagement(workerAuth(context.env)) : null;
    const scim = management ? await Promise.all((await management.listSCIMManagedConnections({ body: { provisioningDomainId: organizationId } })).connections.map(async (connection) => {
      const detail = await management.getSCIMManagedConnection({ body: { connectionId: connection.connectionId, provisioningDomainId: organizationId } });
      return {
        connectionId: connection.connectionId, status: connection.status, createdAt: new Date(connection.createdAt).toISOString(),
        credentials: detail.credentials.map((credential) => ({ credentialId: credential.credentialId, status: credential.status, expiresAt: new Date(credential.expiresAt).toISOString(), lastUsedAt: credential.lastUsedAt ? new Date(credential.lastUsedAt).toISOString() : null })),
      };
    })) : [];
    const groups = management
      ? (await owner(context.env).query(sql`select id, connection_id, display_name from scim_group where provisioning_domain_id = ${organizationId} order by display_name limit 200`))
        .map((row) => ({ id: String(row.id), connectionId: String(row.connection_id), name: String(row.display_name) }))
      : [];
    return context.json({
      capabilities: { sso: authCapabilities.sso, directory: authCapabilities.directory },
      readiness: identityReadiness(context.env),
      scimBaseUrl: `${context.env.BETTER_AUTH_URL ?? "http://localhost:42069"}/api/auth/scim/v2`,
      ssoCallbackUrl: authCapabilities.sso === "workos" ? `${context.env.BETTER_AUTH_URL ?? "http://localhost:42069"}/api/auth/workos/callback` : null,
      ssoProviders, scim, groups,
      connections: connections.map((connection) => ({ ...connection, lastEventAt: connection.lastEventAt?.toISOString() ?? null, createdAt: connection.createdAt.toISOString() })),
      mappings: mappings.map((mapping) => ({ ...mapping, createdAt: mapping.createdAt.toISOString() })),
      events: events.map((event) => ({ ...event, receivedAt: event.receivedAt.toISOString() })),
      roles: { organization: knownRoles.organization.filter((role) => role !== "owner"), application: knownRoles.application },
    });
  });

  // Better Auth SSO: register an OIDC provider for this organization, then prove its domain.
  routes.post("/api/tenant/identity/sso", async (context) => {
    if (authCapabilities.sso !== "better-auth") throw new AccessDomainError("invalid", "Better Auth SSO is not the declared SSO provider");
    const execution = context.get("execution");
    const input = schemas.sso.parse(await context.req.json().catch(() => ({})));
    const organizationId = execution.tenant.organizationId;
    const headers = context.req.raw.headers;
    await viaAuth(() => ssoApi(context.env).registerSSOProvider({ headers, body: {
      providerId: input.providerId, issuer: input.issuer, domain: input.domain, organizationId,
      oidcConfig: { clientId: input.clientId, clientSecret: input.clientSecret, pkce: true, mapping: { email: "email", emailVerified: "email_verified", name: "name" }, ...(input.discoveryEndpoint ? { discoveryEndpoint: input.discoveryEndpoint } : {}) },
    } }));
    const local = (context.env.APP_ENV ?? "local") === "local";
    try {
      await identityDependencies.repository(context.env, organizationId).bindConnection({ provider: "better_auth", kind: "sso", externalId: input.providerId, domain: input.domain, state: local ? "active" : "pending", createdBy: execution.principal.id },
        mutation(execution, "identity.sso.provider_registered", "sso_provider", input.providerId, { providerId: input.providerId, issuer: input.issuer, domain: input.domain }));
    } catch (error) {
      // Keep Better Auth and the Trestle binding consistent: no binding, no provider.
      await ssoApi(context.env).deleteSSOProvider({ headers, body: { providerId: input.providerId } }).catch(() => undefined);
      throw error;
    }
    const verification = local ? null : await viaAuth(() => ssoApi(context.env).requestDomainVerification({ headers, body: { providerId: input.providerId } }));
    return context.json({
      providerId: input.providerId,
      callbackUrl: `${context.env.BETTER_AUTH_URL ?? "http://localhost:42069"}/api/auth/sso/callback/${input.providerId}`,
      domainVerification: verification ? { recordName: `_better-auth-token-${input.providerId}.${input.domain}`, recordValue: verification.domainVerificationToken } : null,
    }, 201);
  });

  routes.post("/api/tenant/identity/sso/:providerId/verify-domain", async (context) => {
    const execution = context.get("execution");
    const providerId = context.req.param("providerId");
    await viaAuth(() => ssoApi(context.env).verifyDomain({ headers: context.req.raw.headers, body: { providerId } }));
    await identityDependencies.repository(context.env, execution.tenant.organizationId).setConnectionState("better_auth", "sso", providerId, "active", mutation(execution, "identity.sso.domain_verified", "sso_provider", providerId, { providerId }));
    return context.body(null, 204);
  });

  routes.delete("/api/tenant/identity/sso/:providerId", async (context) => {
    const execution = context.get("execution");
    const providerId = context.req.param("providerId");
    await viaAuth(() => ssoApi(context.env).deleteSSOProvider({ headers: context.req.raw.headers, body: { providerId } }));
    await identityDependencies.repository(context.env, execution.tenant.organizationId).removeConnection("better_auth", "sso", providerId, mutation(execution, "identity.sso.provider_removed", "sso_provider", providerId, { providerId }));
    return context.body(null, 204);
  });

  // WorkOS: bind a WorkOS organization; only domains WorkOS has verified route sign-in.
  routes.post("/api/tenant/identity/workos/organization", async (context) => {
    if (authCapabilities.sso !== "workos") throw new AccessDomainError("invalid", "WorkOS is not the declared SSO provider");
    const client = identityDependencies.workos(context.env);
    if (!client) throw new AccessDomainError("invalid", "WorkOS credentials are not configured for this environment");
    const execution = context.get("execution");
    const input = schemas.workosOrganization.parse(await context.req.json().catch(() => ({})));
    const organization = await viaAuth(() => client.organization(input.organizationId));
    await assertBindable(context.env, execution.tenant.organizationId, "workos", "sso", organization.id);
    const verified = organization.domains.filter((domain) => domain.state === "verified").map((domain) => domain.domain);
    if (!verified.length) throw new AccessDomainError("invalid", "The WorkOS organization has no verified domains; verify a domain in WorkOS first");
    const repository = identityDependencies.repository(context.env, execution.tenant.organizationId);
    for (const domain of verified) {
      await repository.bindConnection({ provider: "workos", kind: "sso", externalId: organization.id, domain, state: "active", createdBy: execution.principal.id },
        mutation(execution, "identity.sso.organization_bound", "workos_organization", organization.id, { provider: "workos", workosOrganizationId: organization.id, domain }));
    }
    return context.json({ organizationId: organization.id, domains: verified }, 201);
  });

  routes.post("/api/tenant/identity/workos/directory", async (context) => {
    if (authCapabilities.directory !== "workos") throw new AccessDomainError("invalid", "WorkOS Directory Sync is not the declared directory provider");
    const client = identityDependencies.workos(context.env);
    if (!client) throw new AccessDomainError("invalid", "WorkOS credentials are not configured for this environment");
    const execution = context.get("execution");
    const input = schemas.workosDirectory.parse(await context.req.json().catch(() => ({})));
    const repository = identityDependencies.repository(context.env, execution.tenant.organizationId);
    const directory = await viaAuth(() => client.directory(input.directoryId));
    await assertBindable(context.env, execution.tenant.organizationId, "workos", "directory", directory.id);
    const bound = (await repository.connections()).some((connection) => connection.provider === "workos" && connection.kind === "sso" && connection.externalId === directory.organizationId);
    if (!bound) throw new AccessDomainError("invalid", "That directory belongs to a WorkOS organization not bound to this organization");
    await repository.bindConnection({ provider: "workos", kind: "directory", externalId: directory.id, domain: null, state: "active", createdBy: execution.principal.id },
      mutation(execution, "identity.directory.bound", "workos_directory", directory.id, { provider: "workos", directoryId: directory.id, type: directory.type }));
    return context.json({ directoryId: directory.id }, 201);
  });

  routes.delete("/api/tenant/identity/workos/:kind/:externalId", async (context) => {
    const execution = context.get("execution");
    const kind = context.req.param("kind") === "directory" ? "directory" : "sso";
    const externalId = context.req.param("externalId");
    await identityDependencies.repository(context.env, execution.tenant.organizationId).removeConnection("workos", kind, externalId, mutation(execution, `identity.${kind}.unbound`, kind === "sso" ? "workos_organization" : "workos_directory", externalId, { provider: "workos", externalId }));
    return context.body(null, 204);
  });

  // Better Auth SCIM: connections and credentials are shown once and managed only here.
  routes.post("/api/tenant/identity/scim", async (context) => {
    const execution = context.get("execution");
    const management = scimManagement(workerAuth(context.env));
    if (!management) throw new AccessDomainError("invalid", identityReadiness(context.env).directory ?? "SCIM is not enabled");
    const organizationId = execution.tenant.organizationId;
    const created = await viaAuth(() => management.createSCIMManagedConnection({ body: { scopes: allScopes, expiresAt: new Date(execution.clock.now().getTime() + credentialLifetimeMs), creationRequestId: crypto.randomUUID(), provisioningDomainId: organizationId, actorId: execution.principal.id } }));
    await identityDependencies.repository(context.env, organizationId).bindConnection({ provider: "better_auth", kind: "directory", externalId: created.connection.connectionId, domain: null, state: "active", createdBy: execution.principal.id },
      mutation(execution, "identity.directory.scim_connection_created", "scim_connection", created.connection.connectionId, { connectionId: created.connection.connectionId, credentialId: created.credential.credentialId }));
    context.header("cache-control", "no-store");
    return context.json({ connectionId: created.connection.connectionId, credentialId: created.credential.credentialId, token: created.token, expiresAt: new Date(created.credential.expiresAt).toISOString(), baseUrl: `${context.env.BETTER_AUTH_URL ?? "http://localhost:42069"}/api/auth/scim/v2` }, 201);
  });

  routes.post("/api/tenant/identity/scim/:connectionId/rotate", async (context) => {
    const execution = context.get("execution");
    const management = scimManagement(workerAuth(context.env));
    if (!management) throw new AccessDomainError("invalid", "SCIM is not enabled");
    const connectionId = context.req.param("connectionId");
    const rotated = await viaAuth(() => management.rotateSCIMManagedCredential({ body: { scopes: allScopes, expiresAt: new Date(execution.clock.now().getTime() + credentialLifetimeMs), connectionId, provisioningDomainId: execution.tenant.organizationId, actorId: execution.principal.id } }));
    await identityDependencies.repository(context.env, execution.tenant.organizationId).setConnectionState("better_auth", "directory", connectionId, "active",
      mutation(execution, "identity.directory.scim_credential_rotated", "scim_connection", connectionId, { connectionId, credentialId: rotated.credential.credentialId }));
    context.header("cache-control", "no-store");
    return context.json({ credentialId: rotated.credential.credentialId, token: rotated.token, expiresAt: new Date(rotated.credential.expiresAt).toISOString() });
  });

  routes.post("/api/tenant/identity/scim/:connectionId/decommission", async (context) => {
    const execution = context.get("execution");
    const management = scimManagement(workerAuth(context.env));
    if (!management) throw new AccessDomainError("invalid", "SCIM is not enabled");
    const connectionId = context.req.param("connectionId");
    await viaAuth(() => management.decommissionSCIMManagedConnection({ body: { connectionId, provisioningDomainId: execution.tenant.organizationId, actorId: execution.principal.id } }));
    await identityDependencies.repository(context.env, execution.tenant.organizationId).setConnectionState("better_auth", "directory", connectionId, "disabled",
      mutation(execution, "identity.directory.scim_connection_decommissioned", "scim_connection", connectionId, { connectionId }));
    return context.body(null, 204);
  });

  // Group mappings: one external group to one organization- or application-plane role, never the platform plane.
  routes.post("/api/tenant/identity/mappings", async (context) => {
    const execution = context.get("execution");
    const input = schemas.mapping.parse(await context.req.json().catch(() => ({})));
    let mapping;
    try { mapping = validateMapping(input, knownRoles); } catch (error) { throw error instanceof MappingError ? new AccessDomainError("invalid", error.message) : error; }
    const repository = identityDependencies.repository(context.env, execution.tenant.organizationId);
    const connection = (await repository.connections()).find((candidate) => candidate.kind === "directory" && candidate.externalId === mapping.connectionId && candidate.provider === (mapping.provider === "workos" ? "workos" : "better_auth"));
    if (!connection) throw new AccessDomainError("invalid", "That directory connection does not belong to this organization");
    const id = await repository.createMapping(mapping, execution.principal.id, mutation(execution, "identity.mapping.created", "external_role_mapping", `${mapping.connectionId}:${mapping.externalGroupId}`, { ...mapping }))
      .catch((error: unknown) => { throw /duplicate key/u.test(String(error)) ? new AccessDomainError("conflict", "That group already maps to this role") : error; });
    return context.json({ id }, 201);
  });

  routes.delete("/api/tenant/identity/mappings/:id", async (context) => {
    const execution = context.get("execution");
    const id = context.req.param("id");
    const removed = await identityDependencies.repository(context.env, execution.tenant.organizationId).deleteMapping(id, mutation(execution, "identity.mapping.removed", "external_role_mapping", id, { id }));
    if (!removed) throw new AccessDomainError("not_found", "Mapping not found");
    return context.body(null, 204);
  });
}

/**
 * Applies one verified WorkOS directory event: the user and their current
 * groups are read back from WorkOS, membership is ensured or removed, and the
 * application roles this directory owns are reconciled with their audit and
 * outbox records in one tenant transaction. Redelivery is a no-op.
 */
export async function applyWorkOSDirectoryEvent(environment: AuthEnvironment, event: DirectoryEvent, client: WorkOSClient, now = new Date()): Promise<"applied" | "duplicate" | "unbound"> {
  const organizationId = String((await createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER)
    .query(sql`select trestle_resolve_identity_connection('workos', 'directory', ${event.directoryId}) as organization_id`))[0]?.organization_id ?? "");
  if (!organizationId || organizationId === "null") return "unbound";
  const repository = identityDependencies.repository(environment, organizationId);
  if (await repository.hasDirectoryEvent(event.id)) return "duplicate";
  const connectionId = event.directoryId;
  const context = await workerAuth(environment).$context;
  const groups = event.type === "user.deleted" ? [] : await client.directoryUserGroups(event.user.externalId);
  const active = event.type !== "user.deleted" && event.type !== "user.deactivated" && event.user.active;
  const mappings = await repository.mappings("workos", connectionId);
  const orgRank: Record<string, number> = { member: 1, billing_admin: 2, admin: 3 };
  const memberOf = new Set(groups.map((group) => group.externalGroupId));
  const organizationGrant = mappings.filter((mapping) => mapping.targetPlane === "organization" && memberOf.has(mapping.externalGroupId)).sort((a, b) => (orgRank[b.targetRole] ?? 0) - (orgRank[a.targetRole] ?? 0))[0];
  const extraAudit: Array<{ name: string; summary: Record<string, unknown> }> = [];

  const found = await context.internalAdapter.findUserByEmail(event.user.email);
  let userId = found?.user.id ?? null;
  if (!userId && active) {
    const created = await context.internalAdapter.createUser({ email: event.user.email, name: event.user.name ?? event.user.email, emailVerified: true }, { method: "sso-oidc", sso: { providerId: `workos:${connectionId}` } });
    userId = created.id;
    extraAudit.push({ name: "directory.user.provisioned", summary: { provider: "workos" } });
  }
  if (userId) {
    const source = `workos:${connectionId}`;
    const member = await context.adapter.findOne<{ id: string; role: string; roleSource: string | null }>({ model: "member", where: [{ field: "organizationId", value: organizationId }, { field: "userId", value: userId }] });
    const desiredRole = organizationGrant?.targetRole ?? "member";
    const roleSource = organizationGrant ? `${source}:${organizationGrant.externalGroupId}` : source;
    if (active && !member) {
      await context.adapter.create({ model: "member", data: { organizationId, userId, role: desiredRole, roleSource, createdAt: now } });
      extraAudit.push({ name: "directory.member.added", summary: { role: desiredRole } });
    } else if (active && member?.roleSource && (member.role !== desiredRole || member.roleSource !== roleSource)) {
      await context.adapter.update({ model: "member", where: [{ field: "id", value: member.id }], update: { role: desiredRole, roleSource } });
      extraAudit.push({ name: "directory.member.role_changed", summary: { from: member.role, to: desiredRole } });
    } else if (!active && member?.roleSource?.startsWith(source)) {
      await context.adapter.delete({ model: "member", where: [{ field: "id", value: member.id }] });
      extraAudit.push({ name: "directory.member.removed", summary: { reason: event.type } });
    }
  }
  const owned = userId ? await repository.sourcedAssignments(userId, "workos", connectionId) : [];
  const plan = reconcileExternalAssignments(owned, mappings.filter((mapping) => mapping.targetPlane === "application"), { provider: "workos", connectionId }, groups, active);
  const existing = new Set(userId ? await repository.activeRoles(userId) : []);
  await repository.applyDirectoryChanges({
    eventId: event.id, provider: "workos", type: event.type, userId, connectionId, now, correlationId: crypto.randomUUID(), environment: environment.APP_ENV ?? "local",
    grant: plan.grant.filter((assignment) => !existing.has(assignment.role)),
    revoke: owned.filter((assignment) => plan.revoke.some((candidate) => candidate.role === assignment.role && candidate.source?.externalGroupId === assignment.source?.externalGroupId)),
    revokeReason: active ? "directory group mapping no longer applies" : "directory user deactivated", outcome: "applied", extraAudit,
  });
  await repository.recordConnectionOutcome("workos", "directory", connectionId, null);
  return "applied";
}

/** Public, signature-verified provider webhooks for enterprise identity. */
export function registerIdentityWebhooks(app: Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>) {
  const log = createLogger({ component: "identity" });
  app.post("/webhooks/workos", async (context: Context<{ Bindings: AuthEnvironment; Variables: AppVariables }>) => {
    if (authCapabilities.directory !== "workos" || !context.env.WORKOS_WEBHOOK_SECRET) return context.notFound();
    const client = identityDependencies.workos(context.env);
    if (!client) return context.json({ error: "not_configured" }, 503);
    const body = await context.req.text();
    let events: DirectoryEvent[];
    try {
      events = await new WorkOSDirectoryEvents(context.env.WORKOS_WEBHOOK_SECRET).verify({ body, headers: { "workos-signature": context.req.header("workos-signature") } }, new Date());
    } catch (error) {
      if (error instanceof IdentityVerificationError) return context.json({ error: "invalid_signature" }, 400);
      throw error;
    }
    for (const event of events) {
      try {
        const outcome = await applyWorkOSDirectoryEvent(context.env, event, client);
        log.info("identity.directory.event", { provider: "workos", type: event.type, outcome });
      } catch (error) {
        // A 5xx makes WorkOS retry; the event ID keeps the retry idempotent.
        log.warn("identity.directory.event_failed", { provider: "workos", type: event.type, errorName: error instanceof Error ? error.name : "UnknownError" });
        return context.json({ error: "retry" }, 503);
      }
    }
    return context.json({ received: events.length });
  });
}
