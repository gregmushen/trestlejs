import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { AccessDeniedError, publicDenial, validateApiKeyScopes } from "@__TRESTLE_PROJECT_NAME__/authz";
import { evaluateQuota, features, PostgresCommercialRepository, resolveEffectiveEntitlements, tenantCapabilityDocument, type QuotaState } from "@__TRESTLE_PROJECT_NAME__/billing";
import { PostgresTenantAccessRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { AccessDomainError, ApplicationRoleService, NotificationError, OrganizationRoleService, ServiceAccountService, WebhookDomainError, type OperationContext, type TenantAccessRepository } from "@__TRESTLE_PROJECT_NAME__/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { requireExecutionContext, type AppExecutionContext, type AppVariables } from "./execution-context.js";
import { registerIdentityRoutes } from "./identity-routes.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { operationContext, registerWebhookRoutes } from "./webhook-routes.js";

type Environment = { Bindings: AuthEnvironment; Variables: AppVariables };

/** Replaceable for tests; production uses the forced-RLS Postgres repositories. */
export const tenantRepositories = {
  access: (environment: AuthEnvironment, organizationId: string): TenantAccessRepository => new PostgresTenantAccessRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
  commercial: (environment: AuthEnvironment, organizationId: string) => new PostgresCommercialRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
};

const roleKeys = z.array(z.string().min(1).max(40)).max(20);
const schemas = {
  organizationRoles: z.object({ roles: roleKeys }).strict(),
  applicationRoles: z.object({ roles: roleKeys }).strict(),
  customRole: z.object({ key: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/u), name: z.string().min(1).max(80), description: z.string().max(500).optional(), permissions: z.array(z.string()).min(1).max(100) }).strict(),
  customRoleUpdate: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional(), permissions: z.array(z.string()).min(1).max(100) }).strict(),
  serviceAccount: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional(), applicationRoles: roleKeys.min(1) }).strict(),
  reason: z.object({ reason: z.string().trim().min(1).max(500) }).strict(),
  mint: z.object({ name: z.string().trim().max(80).optional(), idempotencyKey: z.string().min(8).max(100).optional(), scopes: z.array(z.string()).min(1).max(50), scopeProfileId: z.string().optional(), expiresAt: z.iso.datetime().optional(), allowedCidrs: z.array(z.string()).max(20).optional(), rateLimitPerMinute: z.number().int().min(1).max(100_000).optional() }).strict(),
  rotate: z.object({ overlapHours: z.number().min(0).max(168).default(24) }).strict(),
  scopeProfile: z.object({ name: z.string().min(1).max(80), description: z.string().max(500).optional(), scopes: z.array(z.string()).min(1).max(50) }).strict(),
};

function operation(execution: AppExecutionContext): OperationContext {
  return operationContext(execution);
}

/** Access services bound to this tenant and to the runtime catalog loaded for the request. */
function accessServices(context: Context<Environment>) {
  const execution = context.get("execution");
  const repository = tenantRepositories.access(context.env, execution.tenant.organizationId);
  const roles = new ApplicationRoleService(repository, execution.accessCatalog);
  return { repository, organizationRoles: new OrganizationRoleService(repository, execution.accessCatalog), applicationRoles: roles, serviceAccounts: new ServiceAccountService(repository, roles) };
}

async function body<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new AccessDomainError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

const maxKeys = (execution: AppExecutionContext): number | null => {
  const value = execution.entitlements.value("api.access", "maxKeys");
  return typeof value === "number" ? value : null;
};

const serializeKey = <T extends { expiresAt: Date | null; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }>(key: T) => ({
  ...key, expiresAt: key.expiresAt?.toISOString() ?? null, createdAt: key.createdAt.toISOString(), lastUsedAt: key.lastUsedAt?.toISOString() ?? null, revokedAt: key.revokedAt?.toISOString() ?? null,
});

export const tenantRoutes = new Hono<Environment>();
tenantRoutes.use("/api/tenant/*", requireExecutionContext);

tenantRoutes.onError((error, context) => {
  if (error instanceof AccessDeniedError) return context.json(publicDenial(error.decision), error.status);
  if (error instanceof z.ZodError) return context.json({ error: "invalid", message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ") }, 422);
  if (error instanceof WebhookDomainError || error instanceof NotificationError) return context.json({ error: error.code, message: error.message }, error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 422);
  if (error instanceof AccessDomainError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : error.code === "limit_exceeded" ? 409 : 422;
    return context.json({ error: error.code, message: error.message }, status);
  }
  context.get("execution")?.log.error("tenant.admin.failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
  return context.json({ error: "internal_error", message: "The request could not be completed" }, 500);
});

async function capabilityDocument(context: Context<Environment>) {
  const execution = context.get("execution");
  const commercial = tenantRepositories.commercial(context.env, execution.tenant.organizationId);
  const now = execution.clock.now();
  const [{ summary, planVersion, startedAt }, overrides, scheduledChanges, offeredPlans] = await Promise.all([commercial.subscription(), commercial.overrides(), commercial.scheduledChanges(), commercial.activePlanVersions()]);
  const effective = resolveEffectiveEntitlements(features, summary ? { status: summary.status, planVersion, ...(startedAt ? { startedAt } : {}) } : null, overrides, now);
  const quotas: QuotaState[] = [];
  for (const entry of effective.filter((candidate) => candidate.enabled && features.get(candidate.code)?.metered)) {
    const usage = await commercial.usage(entry.code, now);
    if (usage) quotas.push(evaluateQuota(entry, usage.used, usage.period, 0));
  }
  return tenantCapabilityDocument({ catalog: features, subscription: summary, planVersion, effective, quotas, scheduledChanges, offeredPlans });
}

tenantRoutes.get("/api/tenant/access", async (context) => {
  const execution = context.get("execution");
  return context.json({
    organizationId: execution.tenant.organizationId,
    principal: { id: execution.principal.id, type: execution.principal.kind },
    permissions: execution.access.permitted(),
    capabilities: await capabilityDocument(context),
  });
});

tenantRoutes.get("/api/tenant/plan-usage", async (context) => context.json(await capabilityDocument(context)));

tenantRoutes.get("/api/tenant/members", async (context) => {
  const execution = context.get("execution");
  const repository = tenantRepositories.access(context.env, execution.tenant.organizationId);
  const [members, assignments] = await Promise.all([repository.listMembers(), execution.access.check({ permission: "application.roles.read" }) ? repository.listApplicationRoleAssignments() : Promise.resolve(null)]);
  return context.json({
    members: members.map((member) => ({ ...member, applicationRoles: assignments ? assignments.filter((assignment) => assignment.userId === member.userId).map((assignment) => assignment.role) : null })),
    organizationRoles: execution.accessCatalog.organization.list().map(({ key, name, description, permissions: granted }) => ({ key, name, description, permissions: granted })),
  });
});

tenantRoutes.put("/api/tenant/members/:memberId/organization-roles", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.organizationRoles);
  const actorRoles = (execution.tenant.role ?? "").split(",").map((role) => role.trim());
  await accessServices(context).organizationRoles.setMemberRoles(operation(execution), actorRoles, context.req.param("memberId"), input.roles);
  return context.body(null, 204);
});

tenantRoutes.get("/api/tenant/application-roles", async (context) => {
  const execution = context.get("execution");
  const catalog = await accessServices(context).applicationRoles.catalog();
  return context.json({
    roles: catalog.list().map(({ key, name, description, permissions: granted, custom }) => ({ key, name, description, permissions: granted, custom })),
    permissions: context.get("execution").accessCatalog.permissions.list("application").map(({ code, description, group, principals, entitlement }) => ({ code, description, group, principals, ...(entitlement ? { entitlement } : {}) })),
    customRolesEnabled: execution.entitlements.has("roles.custom"),
  });
});

tenantRoutes.post("/api/tenant/application-roles", async (context) => {
  const execution = context.get("execution");
  await accessServices(context).applicationRoles.saveCustomRole(operation(execution), await body(context, schemas.customRole), "create");
  return context.body(null, 201);
});

tenantRoutes.patch("/api/tenant/application-roles/:key", async (context) => {
  const execution = context.get("execution");
  await accessServices(context).applicationRoles.saveCustomRole(operation(execution), { key: context.req.param("key"), ...await body(context, schemas.customRoleUpdate) }, "update");
  return context.body(null, 204);
});

tenantRoutes.delete("/api/tenant/application-roles/:key", async (context) => {
  const execution = context.get("execution");
  await accessServices(context).applicationRoles.deleteCustomRole(operation(execution), context.req.param("key"));
  return context.body(null, 204);
});

tenantRoutes.get("/api/tenant/application-role-assignments", async (context) => {
  const execution = context.get("execution");
  const assignments = await tenantRepositories.access(context.env, execution.tenant.organizationId).listApplicationRoleAssignments();
  return context.json({ assignments: assignments.map((assignment) => ({ ...assignment, grantedAt: assignment.grantedAt.toISOString() })) });
});

tenantRoutes.put("/api/tenant/users/:userId/application-roles", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.applicationRoles);
  await accessServices(context).applicationRoles.assignUserRoles(operation(execution), context.req.param("userId"), input.roles);
  return context.body(null, 204);
});

tenantRoutes.get("/api/tenant/service-accounts", async (context) => {
  const execution = context.get("execution");
  const repository = tenantRepositories.access(context.env, execution.tenant.organizationId);
  const [accounts, keys] = await Promise.all([repository.listServiceAccounts().then((all) => all.filter((account) => !account.deletedAt)), repository.listApiKeys()]);
  const now = execution.clock.now();
  const active = (key: (typeof keys)[number]) => !key.revokedAt && (!key.expiresAt || key.expiresAt > now);
  return context.json({
    serviceAccounts: accounts.map((account) => ({ ...account, createdAt: account.createdAt.toISOString(), activeKeys: keys.filter((key) => key.serviceAccountId === account.id && active(key)).length })),
    scopes: context.get("execution").accessCatalog.permissions.list("application").filter(({ principals }) => principals.includes("api_key")).map(({ code }) => code),
    applicationRoles: (await accessServices(context).applicationRoles.catalog()).list().map(({ key, name }) => ({ key, name })),
    limits: { maxKeys: maxKeys(execution), activeKeys: keys.filter(active).length },
  });
});

tenantRoutes.post("/api/tenant/service-accounts", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.serviceAccount);
  // Granting application roles to a machine identity is an application-plane act as well.
  execution.access.require({ permission: "application.roles.assign" });
  const account = await accessServices(context).serviceAccounts.create(operation(execution), input);
  return context.json({ serviceAccount: { ...account, createdAt: account.createdAt.toISOString() } }, 201);
});

tenantRoutes.put("/api/tenant/service-accounts/:id/application-roles", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.applicationRoles);
  execution.access.require({ permission: "organization.service_accounts.manage" });
  await accessServices(context).serviceAccounts.setRoles(operation(execution), context.req.param("id"), input.roles);
  return context.body(null, 204);
});

for (const [path, status] of [["suspend", "suspended"], ["reactivate", "active"]] as const) {
  tenantRoutes.post(`/api/tenant/service-accounts/:id/${path}`, async (context) => {
    const execution = context.get("execution");
    const reason = status === "suspended" ? (await body(context, schemas.reason)).reason : null;
    await accessServices(context).serviceAccounts.setStatus(operation(execution), context.req.param("id"), status, reason);
    return context.body(null, 204);
  });
}

tenantRoutes.get("/api/tenant/service-accounts/:id/keys", async (context) => {
  const execution = context.get("execution");
  return context.json({ keys: (await tenantRepositories.access(context.env, execution.tenant.organizationId).listApiKeys(context.req.param("id"))).map(serializeKey) });
});

tenantRoutes.post("/api/tenant/service-accounts/:id/keys", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.mint);
  const repository = tenantRepositories.access(context.env, execution.tenant.organizationId);
  const scopes = input.scopes;
  if (input.scopeProfileId) {
    const profile = (await repository.listScopeProfiles()).find((candidate) => candidate.id === input.scopeProfileId);
    if (!profile) throw new AccessDomainError("not_found", "Scope profile not found");
    const outside = scopes.filter((scope) => !profile.scopes.includes(scope));
    if (outside.length) throw new AccessDomainError("invalid", `Scopes outside the selected profile: ${outside.join(", ")}`);
  }
  const minted = await accessServices(context).serviceAccounts.mintKey(operation(execution), context.req.param("id"), {
    scopes, ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}), ...(input.allowedCidrs ? { allowedCidrs: input.allowedCidrs } : {}), ...(input.rateLimitPerMinute ? { rateLimitPerMinute: input.rateLimitPerMinute } : {}),
    ...(input.name ? { name: input.name } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    // A tenant administrator can never mint authority they do not hold themselves.
    ...(execution.principal.kind === "user" ? { actorAuthority: execution.permissions } : {}),
  }, maxKeys(execution));
  context.header("cache-control", "no-store");
  return context.json({ key: serializeKey(minted.key), token: minted.token, replayed: minted.replayed ?? false }, minted.replayed ? 200 : 201);
});

tenantRoutes.post("/api/tenant/api-keys/:id/rotate", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.rotate);
  const rotated = await accessServices(context).serviceAccounts.rotateKey(operation(execution), context.req.param("id"), input.overlapHours, maxKeys(execution));
  context.header("cache-control", "no-store");
  return context.json({ key: serializeKey(rotated.key), token: rotated.token, previous: { id: rotated.previous.id, expiresAt: rotated.previous.expiresAt.toISOString() } }, 201);
});

tenantRoutes.post("/api/tenant/api-keys/:id/revoke", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.reason);
  await accessServices(context).serviceAccounts.revokeKey(operation(execution), context.req.param("id"), input.reason);
  return context.body(null, 204);
});

tenantRoutes.get("/api/tenant/api-keys/:id/usage", async (context) => {
  const execution = context.get("execution");
  return context.json({ usage: await tenantRepositories.access(context.env, execution.tenant.organizationId).apiKeyUsage(context.req.param("id")) });
});

tenantRoutes.get("/api/tenant/scope-profiles", async (context) => {
  const execution = context.get("execution");
  return context.json({ profiles: await tenantRepositories.access(context.env, execution.tenant.organizationId).listScopeProfiles() });
});

tenantRoutes.post("/api/tenant/scope-profiles", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, schemas.scopeProfile);
  const registry = context.get("execution").accessCatalog.permissions;
  const everyApplicationPermission = new Map(registry.list("application").map(({ code }) => [code, ["profile"]] as const));
  const problems = validateApiKeyScopes(registry, input.scopes, everyApplicationPermission);
  if (problems.length) throw new AccessDomainError("invalid", problems.join("; "));
  const profile = { id: crypto.randomUUID(), name: input.name, description: input.description ?? "", scopes: [...input.scopes].sort() };
  await tenantRepositories.access(context.env, execution.tenant.organizationId).createScopeProfile(profile, {
    context: operation(execution), audit: { name: "access.scope_profile.created", targetType: "scope_profile", targetId: profile.id, summary: { name: profile.name, scopes: profile.scopes }, outcome: "succeeded" },
    event: { name: "access.scope_profile.created", resourceType: "scope_profile", resourceId: profile.id, payload: { organizationId: execution.tenant.organizationId } },
  });
  return context.json({ profile }, 201);
});

tenantRoutes.delete("/api/tenant/scope-profiles/:id", async (context) => {
  const execution = context.get("execution");
  const id = context.req.param("id");
  await tenantRepositories.access(context.env, execution.tenant.organizationId).deleteScopeProfile(id, {
    context: operation(execution), audit: { name: "access.scope_profile.deleted", targetType: "scope_profile", targetId: id, summary: {}, outcome: "succeeded" },
    event: { name: "access.scope_profile.deleted", resourceType: "scope_profile", resourceId: id, payload: { organizationId: execution.tenant.organizationId } },
  });
  return context.body(null, 204);
});

tenantRoutes.get("/api/tenant/audit", async (context) => {
  const execution = context.get("execution");
  const events = await tenantRepositories.access(context.env, execution.tenant.organizationId).listAudit(Number(context.req.query("limit") ?? 100));
  return context.json({ events: events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })) });
});

registerWebhookRoutes(tenantRoutes);
registerNotificationRoutes(tenantRoutes);
registerIdentityRoutes(tenantRoutes);
