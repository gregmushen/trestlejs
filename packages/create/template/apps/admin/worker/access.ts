import {
  catalogRoleProblems,
  roleKeyPattern,
  runtimePermissionProblems,
  type AccessCatalog,
  type ApplicationEnvironment,
  type CatalogRole,
  type RuntimePermission,
} from "@__TRESTLE_PROJECT_NAME__/authz";
import { loadAccessCatalog, PostgresTenantAccessRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { AccessDomainError, ApplicationRoleService, OrganizationRoleService, ServiceAccountService, type OperationContext } from "@__TRESTLE_PROJECT_NAME__/domain";
import { PlatformRequestError, type PlatformAudit, type PostgresPlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

/**
 * Roles, permissions, service accounts, and API keys as usable workflows
 * (docs/ADMIN_REQUIRED_CHANGES.md §5-§6). Catalog changes are platform-role
 * writes with audit. Tenant changes (assignments, machine access) run through
 * the tenant's own domain services on its forced-RLS connection, with the
 * operator as the attributed actor, so they commit with tenant audit and
 * outbox exactly as a tenant administrator's change would.
 */

type Bindings = { DATABASE_URL: string; DATABASE_DRIVER?: "neon-http" | "postgres-js"; APP_ENV?: ApplicationEnvironment };
type Authority = {
  operator: { id: string };
  require(permission: string): void;
  requireSensitive(permission: string, reason: unknown): string;
};
type Environment = { Bindings: Bindings; Variables: { authority: Authority; correlationId: string } };
type AuditInput = Omit<PlatformAudit, "actorId" | "environment" | "correlationId" | "now">;
type Dependencies = {
  repository: (environment: Bindings) => PostgresPlatformRepository;
  audit: (context: Context<Environment>, entry: AuditInput) => PlatformAudit;
  now: () => Date;
  /** Route policies per surface, for discovered enforcement. */
  enforcement: () => Array<{ surface: string; method: string; path: string; permission?: string }>;
};

const planeSchema = z.enum(["organization", "application"]);
const reason = z.string().trim().min(1).max(500);
const permissionInput = z.object({
  code: z.string().trim().min(3).max(100), name: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(500), plane: planeSchema,
  principals: z.array(z.enum(["user", "api_key"])).min(1).max(2), entitlement: z.string().trim().max(100).nullable().optional(), reason,
}).strict();
const permissionUpdate = permissionInput.omit({ code: true, plane: true });
const roleInput = z.object({ plane: planeSchema, key: z.string().trim(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(""), permissions: z.array(z.string()).max(200), basedOn: z.string().optional(), reason }).strict();
const roleUpdate = roleInput.pick({ name: true, description: true, permissions: true, reason: true });
const reasonOnly = z.object({ reason }).strict();

async function json<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new PlatformRequestError(422, "invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

const environmentOf = (context: Context<Environment>): ApplicationEnvironment => context.env.APP_ENV ?? "local";

/** Tenant domain errors become the same safe, specific responses tenants see. */
async function tenant<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccessDomainError) throw new PlatformRequestError(error.code === "not_found" ? 404 : error.code === "conflict" || error.code === "limit_exceeded" ? 409 : 422, error.code, error.message);
    throw error;
  }
}

export function registerAccessRoutes(admin: Hono<Environment>, dependencies: Dependencies) {
  const catalogOf = async (context: Context<Environment>): Promise<AccessCatalog> => await loadAccessCatalog(dependencies.repository(context.env).runner);
  const operation = (context: Context<Environment>, organizationId: string, why: string): OperationContext => ({
    organizationId, actor: { type: "platform_operator", id: context.get("authority").operator.id }, correlationId: context.get("correlationId"), environment: environmentOf(context), now: dependencies.now(),
    // Direct platform actions in a tenant carry the operator's reason into tenant audit.
    reason: why,
  });
  const services = async (context: Context<Environment>, organizationId: string) => {
    const catalog = await catalogOf(context);
    const repository = new PostgresTenantAccessRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, organizationId);
    const roles = new ApplicationRoleService(repository, catalog);
    return { catalog, repository, organizationRoles: new OrganizationRoleService(repository, catalog), applicationRoles: roles, serviceAccounts: new ServiceAccountService(repository, roles) };
  };

  // ---- Catalog: permissions and roles in every plane, with impact ----

  admin.get("/api/admin/catalog", async (context) => {
    context.get("authority").require("platform.roles.read");
    const repository = dependencies.repository(context.env);
    const [catalog, permissionRows, roleRows, counts] = await Promise.all([catalogOf(context), repository.catalogPermissionRows(), repository.catalogRoleRows(), repository.roleAssignmentCounts()]);
    const enforcement = dependencies.enforcement();
    const runtime = new Map(permissionRows.map((row) => [row.code, row]));
    const archived = roleRows.filter((row) => row.archivedAt);
    const roleList = (plane: "organization" | "application") => [
      ...(plane === "organization" ? catalog.organization : catalog.application).list().map((role) => ({ ...role, source: role.source ?? (role.custom ? "catalog" : "builtin"), archived: false, basedOn: roleRows.find((row) => row.plane === plane && row.key === role.key)?.basedOn ?? null, assignments: counts[plane][role.key] ?? 0 })),
      ...archived.filter((row) => row.plane === plane).map((row) => ({ key: row.key, name: row.name, description: row.description, plane, permissions: row.permissions, custom: true, source: "catalog", archived: true, basedOn: row.basedOn, assignments: counts[plane][row.key] ?? 0 })),
    ];
    const allRoles = [...roleList("organization"), ...roleList("application")];
    return context.json({
      permissions: catalog.permissions.list().map((permission) => {
        const row = runtime.get(permission.code);
        const enforcedBy = enforcement.filter((route) => route.permission === permission.code).map((route) => `${route.surface} ${route.method} ${route.path}`);
        return {
          code: permission.code, name: permission.name ?? permission.description, description: permission.description, plane: permission.plane, principals: permission.principals, entitlement: permission.entitlement ?? null,
          origin: row ? "runtime" : "code", state: row?.state ?? (permission.deprecated ? "deprecated" : "active"), secret: Boolean(permission.secret), protected: !row,
          roles: allRoles.filter((role) => role.permissions.includes(permission.code)).map((role) => ({ plane: role.plane, key: role.key, name: role.name })),
          enforcedBy, createdAt: row?.createdAt ?? null, createdBy: row?.createdBy ?? null,
        };
      }).concat(permissionRows.filter((row) => !catalog.permissions.get(row.code)).map((row) => ({
        // A runtime definition the registry refused (for example a later code collision) stays visible.
        code: row.code, name: row.name, description: row.description, plane: row.plane, principals: row.principals, entitlement: row.entitlement, origin: "runtime", state: "invalid", secret: false, protected: false, roles: [], enforcedBy: [], createdAt: row.createdAt, createdBy: row.createdBy,
      }) as never)),
      roles: { organization: roleList("organization"), application: roleList("application") },
    });
  });

  admin.get("/api/admin/catalog/roles/:plane/:key/assignments", async (context) => {
    context.get("authority").require("platform.roles.read");
    const plane = planeSchema.parse(context.req.param("plane"));
    return context.json({ assignments: await dependencies.repository(context.env).roleAssignments(plane, context.req.param("key")) });
  });

  admin.get("/api/admin/catalog/permissions/:code/references", async (context) => {
    context.get("authority").require("platform.roles.read");
    return context.json(await dependencies.repository(context.env).permissionReferences(context.req.param("code")));
  });

  admin.post("/api/admin/catalog/permissions", async (context) => {
    const input = await json(context, permissionInput);
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
    const catalog = await catalogOf(context);
    const permission: RuntimePermission = { code: input.code, name: input.name, description: input.description, plane: input.plane, principals: input.principals, entitlement: input.entitlement || null };
    const problems = runtimePermissionProblems(catalog.permissions, permission);
    if (catalog.permissions.get(input.code)) problems.push(`${input.code} already exists`);
    if (problems.length) throw new PlatformRequestError(422, "invalid", problems.join("; "));
    const repository = dependencies.repository(context.env);
    await repository.mutate(repository.insertCatalogPermission({ ...permission, entitlement: permission.entitlement ?? null }, authority.operator.id), dependencies.audit(context, { name: "access.permission.created", organizationId: null, targetType: "permission", targetId: input.code, reason: why, summary: { plane: input.plane, principals: input.principals, entitlement: input.entitlement ?? null } }));
    return context.json({ code: input.code }, 201);
  });

  admin.patch("/api/admin/catalog/permissions/:code", async (context) => {
    const input = await json(context, permissionUpdate);
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
    const code = context.req.param("code");
    const repository = dependencies.repository(context.env);
    const row = (await repository.catalogPermissionRows()).find((candidate) => candidate.code === code);
    if (!row) throw new PlatformRequestError((await catalogOf(context)).permissions.get(code) ? 409 : 404, "protected", `${code} is defined in code and cannot be edited here`);
    if (row.plane === "organization" && input.principals.includes("api_key")) throw new PlatformRequestError(422, "invalid", "Only application permissions can be granted to API keys");
    await repository.mutate(repository.updateCatalogPermission(code, { name: input.name, description: input.description, principals: input.principals, entitlement: input.entitlement || null }), dependencies.audit(context, { name: "access.permission.updated", organizationId: null, targetType: "permission", targetId: code, reason: why, summary: { before: { name: row.name, principals: row.principals, entitlement: row.entitlement }, after: { name: input.name, principals: input.principals, entitlement: input.entitlement ?? null } } }));
    return context.body(null, 204);
  });

  for (const [action, state] of [["deprecate", "deprecated"], ["restore", "active"]] as const) {
    admin.post(`/api/admin/catalog/permissions/:code/${action}`, async (context) => {
      const input = await json(context, reasonOnly);
      const authority = context.get("authority");
      const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
      const code = context.req.param("code");
      const repository = dependencies.repository(context.env);
      if (!(await repository.catalogPermissionRows()).some((row) => row.code === code)) throw new PlatformRequestError(404, "not_found", "Only runtime permissions can be deprecated here");
      await repository.mutate(repository.setCatalogPermissionState(code, state), dependencies.audit(context, { name: `access.permission.${state === "deprecated" ? "deprecated" : "restored"}`, organizationId: null, targetType: "permission", targetId: code, reason: why, summary: { state } }));
      return context.body(null, 204);
    });
  }

  admin.delete("/api/admin/catalog/permissions/:code", async (context) => {
    const input = await json(context, reasonOnly);
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
    const code = context.req.param("code");
    const repository = dependencies.repository(context.env);
    const row = (await repository.catalogPermissionRows()).find((candidate) => candidate.code === code);
    if (!row) throw new PlatformRequestError(409, "protected", "Protected permissions are defined in code and cannot be deleted");
    if (row.state !== "deprecated") throw new PlatformRequestError(409, "conflict", "Deprecate the permission before deleting it");
    const catalogRoles = (await repository.catalogRoleRows()).filter((role) => role.permissions.includes(code));
    const references = await repository.permissionReferences(code);
    if (catalogRoles.length || references.tenantRoles.length || references.activeKeys) {
      throw new PlatformRequestError(409, "referenced", `Still referenced by ${catalogRoles.length} catalog roles, ${references.tenantRoles.length} tenant roles, and ${references.activeKeys} active API keys`);
    }
    await repository.mutate(repository.deleteCatalogPermission(code), dependencies.audit(context, { name: "access.permission.deleted", organizationId: null, targetType: "permission", targetId: code, reason: why, summary: { plane: row.plane } }));
    return context.body(null, 204);
  });

  admin.post("/api/admin/catalog/roles", async (context) => {
    const input = await json(context, roleInput);
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
    const catalog = await catalogOf(context);
    const repository = dependencies.repository(context.env);
    const role: CatalogRole = { plane: input.plane, key: input.key, name: input.name, description: input.description, permissions: [...new Set(input.permissions)].sort() };
    const problems = catalogRoleProblems(catalog, role, { creating: true });
    if ((await repository.catalogRoleRows()).some((row) => row.plane === input.plane && row.key === input.key)) problems.push(`${input.key} already exists (it may be archived)`);
    if (input.plane === "application" && await repository.tenantRoleKeyTaken(input.key)) problems.push(`${input.key} is already used by an organization's own role`);
    if (problems.length) throw new PlatformRequestError(422, "invalid", [...new Set(problems)].join("; "));
    await repository.mutate(repository.insertCatalogRole({ ...role, basedOn: input.basedOn ?? null }, authority.operator.id), dependencies.audit(context, { name: "access.catalog_role.created", organizationId: null, targetType: "role", targetId: `${input.plane}:${input.key}`, reason: why, summary: { permissions: role.permissions, basedOn: input.basedOn ?? null } }));
    return context.json({ plane: input.plane, key: input.key }, 201);
  });

  admin.patch("/api/admin/catalog/roles/:plane/:key", async (context) => {
    const input = await json(context, roleUpdate);
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
    const plane = planeSchema.parse(context.req.param("plane"));
    const key = context.req.param("key");
    const repository = dependencies.repository(context.env);
    const row = (await repository.catalogRoleRows()).find((candidate) => candidate.plane === plane && candidate.key === key);
    if (!row) throw new PlatformRequestError(409, "protected", `${key} is a built-in role; clone it to customize`);
    const permissionsNext = [...new Set(input.permissions)].sort();
    const problems = catalogRoleProblems(await catalogOf(context), { plane, key, name: input.name, description: input.description, permissions: permissionsNext }, { creating: false });
    if (problems.length) throw new PlatformRequestError(422, "invalid", problems.join("; "));
    const holders = (await repository.roleAssignmentCounts())[plane][key] ?? 0;
    await repository.mutate(repository.updateCatalogRole(plane, key, { name: input.name, description: input.description, permissions: permissionsNext }), dependencies.audit(context, {
      name: "access.catalog_role.updated", organizationId: null, targetType: "role", targetId: `${plane}:${key}`, reason: why,
      summary: { added: permissionsNext.filter((code) => !row.permissions.includes(code)), removed: row.permissions.filter((code) => !permissionsNext.includes(code)), affectedPrincipals: holders },
    }));
    return context.body(null, 204);
  });

  for (const [action, archived] of [["archive", true], ["restore", false]] as const) {
    admin.post(`/api/admin/catalog/roles/:plane/:key/${action}`, async (context) => {
      const input = await json(context, reasonOnly);
      const authority = context.get("authority");
      const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
      const plane = planeSchema.parse(context.req.param("plane"));
      const key = context.req.param("key");
      const repository = dependencies.repository(context.env);
      if (!(await repository.catalogRoleRows()).some((row) => row.plane === plane && row.key === key)) throw new PlatformRequestError(409, "protected", "Built-in roles cannot be archived");
      const holders = (await repository.roleAssignmentCounts())[plane][key] ?? 0;
      await repository.mutate(repository.setCatalogRoleArchived(plane, key, archived), dependencies.audit(context, { name: `access.catalog_role.${archived ? "archived" : "restored"}`, organizationId: null, targetType: "role", targetId: `${plane}:${key}`, reason: why, summary: { affectedPrincipals: holders } }));
      return context.body(null, 204);
    });
  }

  admin.delete("/api/admin/catalog/roles/:plane/:key", async (context) => {
    const input = await json(context, reasonOnly);
    const authority = context.get("authority");
    const why = authority.requireSensitive("platform.access_catalog.manage", input.reason);
    const plane = planeSchema.parse(context.req.param("plane"));
    const key = context.req.param("key");
    const repository = dependencies.repository(context.env);
    if (!(await repository.catalogRoleRows()).some((row) => row.plane === plane && row.key === key)) throw new PlatformRequestError(409, "protected", "Built-in roles cannot be deleted");
    const holders = (await repository.roleAssignmentCounts())[plane][key] ?? 0;
    if (holders) throw new PlatformRequestError(409, "referenced", `${holders} principals still hold this role; archive it instead, or remove the assignments first`);
    await repository.mutate(repository.deleteCatalogRole(plane, key), dependencies.audit(context, { name: "access.catalog_role.deleted", organizationId: null, targetType: "role", targetId: `${plane}:${key}`, reason: why, summary: {} }));
    return context.body(null, 204);
  });

  // ---- Tenant role assignments by operators ----

  admin.post("/api/admin/organizations/:organizationId/members/:memberId/organization-roles", async (context) => {
    const input = await json(context, z.object({ roles: z.array(z.string()).min(1).max(20), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.tenant_access.assign", input.reason);
    const organizationId = context.req.param("organizationId");
    // Operators are not members: ownership can be neither granted nor removed from the platform.
    await tenant(async () => (await services(context, organizationId)).organizationRoles.setMemberRoles(operation(context, organizationId, why), [], context.req.param("memberId"), input.roles));
    return context.body(null, 204);
  });

  admin.post("/api/admin/organizations/:organizationId/users/:userId/application-roles", async (context) => {
    const input = await json(context, z.object({ roles: z.array(z.string()).max(20), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.tenant_access.assign", input.reason);
    const organizationId = context.req.param("organizationId");
    await tenant(async () => (await services(context, organizationId)).applicationRoles.assignUserRoles(operation(context, organizationId, why), context.req.param("userId"), input.roles));
    return context.body(null, 204);
  });

  // ---- Service accounts ----

  const accountOrganization = async (context: Context<Environment>, id: string) => {
    const account = await dependencies.repository(context.env).serviceAccountById(id);
    if (!account) throw new PlatformRequestError(404, "not_found", "Service account not found");
    return account;
  };

  admin.get("/api/admin/service-accounts/:id", async (context) => {
    context.get("authority").require("platform.machine_access.read");
    const repository = dependencies.repository(context.env);
    const account = await accountOrganization(context, context.req.param("id"));
    const [catalog, keys] = await Promise.all([catalogOf(context), repository.apiKeys(account.organizationId)]);
    const own = keys.filter((key) => key.serviceAccountId === account.id);
    const tenantRoles = await new PostgresTenantAccessRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, account.organizationId).listApplicationRoles();
    const effective = catalog.application.withCustomRoles(tenantRoles).resolve(account.applicationRoles);
    const [usage, audit] = await Promise.all([repository.apiKeyUsageDays(own.map((key) => key.id)), repository.auditFor("service_account", [account.id])]);
    const keyAudit = await repository.auditFor("api_key", own.map((key) => key.id));
    return context.json({
      account, keys: own,
      effectivePermissions: [...effective.permissions.entries()].map(([code, via]) => ({ code, via })).sort((a, b) => a.code.localeCompare(b.code)),
      unknownRoles: effective.unknownRoles,
      usage: usage.reduce<Record<string, { requests: number; denied: number }>>((days, entry) => { const day = days[entry.day] ?? { requests: 0, denied: 0 }; days[entry.day] = { requests: day.requests + entry.requests, denied: day.denied + entry.denied }; return days; }, {}),
      audit: [...audit, ...keyAudit].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 50),
      availableRoles: catalog.application.withCustomRoles(tenantRoles).list().map((role) => ({ key: role.key, name: role.name, source: role.source ?? (role.custom ? "tenant" : "builtin") })),
    });
  });

  admin.post("/api/admin/service-accounts", async (context) => {
    const input = await json(context, z.object({ organizationId: z.string().min(1), name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional(), applicationRoles: z.array(z.string()).min(1).max(20), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const created = await tenant(async () => (await services(context, input.organizationId)).serviceAccounts.create(operation(context, input.organizationId, why), { name: input.name, description: input.description, applicationRoles: input.applicationRoles }));
    return context.json({ id: created.id }, 201);
  });

  admin.patch("/api/admin/service-accounts/:id", async (context) => {
    const input = await json(context, z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500), applicationRoles: z.array(z.string()).min(1).max(20).optional(), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const account = await accountOrganization(context, context.req.param("id"));
    const { serviceAccounts } = await services(context, account.organizationId);
    await tenant(() => serviceAccounts.update(operation(context, account.organizationId, why), account.id, { name: input.name, description: input.description }));
    if (input.applicationRoles) await tenant(() => serviceAccounts.setRoles(operation(context, account.organizationId, why), account.id, input.applicationRoles!));
    return context.body(null, 204);
  });

  admin.post("/api/admin/service-accounts/:id/reactivate", async (context) => {
    const input = await json(context, reasonOnly);
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const account = await accountOrganization(context, context.req.param("id"));
    await tenant(async () => (await services(context, account.organizationId)).serviceAccounts.setStatus(operation(context, account.organizationId, why), account.id, "active", why));
    return context.body(null, 204);
  });

  admin.delete("/api/admin/service-accounts/:id", async (context) => {
    const input = await json(context, reasonOnly);
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const account = await accountOrganization(context, context.req.param("id"));
    const result = await tenant(async () => (await services(context, account.organizationId)).serviceAccounts.delete(operation(context, account.organizationId, why), account.id, why));
    return context.json(result);
  });

  // ---- API keys ----

  const keyScopeInput = { scopes: z.array(z.string()).min(1).max(50), reason };
  admin.post("/api/admin/api-keys", async (context) => {
    const input = await json(context, z.object({
      serviceAccountId: z.string().min(1), name: z.string().trim().min(1).max(80), expiresAt: z.iso.datetime().optional(), allowedCidrs: z.array(z.string()).max(20).optional(), idempotencyKey: z.string().min(8).max(100), ...keyScopeInput,
    }).strict());
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const account = await accountOrganization(context, input.serviceAccountId);
    const minted = await tenant(async () => (await services(context, account.organizationId)).serviceAccounts.mintKey(operation(context, account.organizationId, why), account.id, {
      scopes: input.scopes, name: input.name, idempotencyKey: `platform:${input.idempotencyKey}`,
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}), ...(input.allowedCidrs?.length ? { allowedCidrs: input.allowedCidrs } : {}),
    }, null));
    context.header("cache-control", "no-store");
    return context.json({ id: minted.key.id, displayPrefix: minted.key.displayPrefix, token: minted.token, replayed: minted.replayed ?? false }, minted.replayed ? 200 : 201);
  });

  const keyOrganization = async (context: Context<Environment>, id: string) => {
    const key = await dependencies.repository(context.env).apiKey(id);
    if (!key) throw new PlatformRequestError(404, "not_found", "API key not found");
    return key;
  };

  admin.get("/api/admin/api-keys/:id", async (context) => {
    context.get("authority").require("platform.machine_access.read");
    const repository = dependencies.repository(context.env);
    const key = await keyOrganization(context, context.req.param("id"));
    const all = await repository.apiKeys(key.organizationId);
    const detail = all.find((candidate) => candidate.id === key.id)!;
    const lineage = all.filter((candidate) => candidate.id === detail.rotatedFrom || candidate.id === detail.rotatedTo || candidate.rotatedFrom === detail.id);
    const [usage, audit, account] = await Promise.all([repository.apiKeyUsageDays([key.id]), repository.auditFor("api_key", [key.id]), repository.serviceAccountById(key.serviceAccountId)]);
    return context.json({ key: detail, lineage, usage, audit, serviceAccount: account });
  });

  admin.post("/api/admin/api-keys/:id/rotate", async (context) => {
    const input = await json(context, z.object({ overlapHours: z.number().min(0).max(168), reason }).strict());
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const key = await keyOrganization(context, context.req.param("id"));
    const rotated = await tenant(async () => (await services(context, key.organizationId)).serviceAccounts.rotateKey(operation(context, key.organizationId, why), key.id, input.overlapHours, null));
    context.header("cache-control", "no-store");
    return context.json({ id: rotated.key.id, displayPrefix: rotated.key.displayPrefix, token: rotated.token, previous: { id: rotated.previous.id, expiresAt: rotated.previous.expiresAt.toISOString() } });
  });

  admin.post("/api/admin/api-keys/:id/replace", async (context) => {
    const input = await json(context, z.object({ overlapHours: z.number().min(0).max(168), ...keyScopeInput }).strict());
    const why = context.get("authority").requireSensitive("platform.machine_access.manage", input.reason);
    const key = await keyOrganization(context, context.req.param("id"));
    const replaced = await tenant(async () => (await services(context, key.organizationId)).serviceAccounts.replaceKey(operation(context, key.organizationId, why), key.id, { scopes: input.scopes, overlapHours: input.overlapHours }, null));
    context.header("cache-control", "no-store");
    return context.json({ id: replaced.key.id, displayPrefix: replaced.key.displayPrefix, token: replaced.token, previous: { id: replaced.previous.id, expiresAt: replaced.previous.expiresAt.toISOString() } });
  });

  /** Application permissions an API key may carry, for the key forms. */
  admin.get("/api/admin/api-key-scopes", async (context) => {
    context.get("authority").require("platform.machine_access.read");
    const catalog = await catalogOf(context);
    return context.json({ scopes: catalog.permissions.list("application").filter((permission) => permission.principals.includes("api_key") && !permission.deprecated).map((permission) => ({ code: permission.code, name: permission.name ?? permission.description, description: permission.description, entitlement: permission.entitlement ?? null })) });
  });

  // Keep the role-key pattern visible to clients that derive keys from names.
  admin.get("/api/admin/catalog/key-rules", (context) => {
    context.get("authority").require("platform.roles.read");
    return context.json({ rolePattern: roleKeyPattern.source });
  });
}
