import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { applicationRoles, mintApiKey, permissions, rotationExpiry, unknownApplicationRoles, validateApiKeyScopes, type ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { createServiceAccount, findServiceAccount, listServiceAccounts, MachineAccessError, revokeApiKey, rotateApiKey, storeApiKey, type MachineAccessAudit } from "@__TRESTLE_PROJECT_NAME__/db";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { requireExecutionContext, type AppExecutionContext, type AppVariables } from "./execution-context.js";

/**
 * Service accounts and their scoped API keys. A service account holds
 * application roles, so managing one is an application-plane power
 * (`application.service_accounts.manage`); organization roles grant none of it.
 * Tokens are returned exactly once, at mint or rotation.
 */
export const machineAccessRoutes = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
machineAccessRoutes.use("/api/tenant/service-accounts", requireExecutionContext);
machineAccessRoutes.use("/api/tenant/service-accounts/*", requireExecutionContext);
machineAccessRoutes.use("/api/tenant/api-keys/*", requireExecutionContext);

const createAccount = z.object({ name: z.string().min(1).max(100), applicationRoles: z.array(z.string().min(1).max(40)).min(1).max(10) }).strict();
const createKey = z.object({ name: z.string().min(1).max(100), scopes: z.array(z.string().min(1).max(80)).min(1).max(50), expiresAt: z.string().datetime().optional() }).strict();
const rotateKey = z.object({ overlapHours: z.number().int().min(0).max(168).optional() }).strict();
const revokeKey = z.object({ reason: z.string().min(1).max(500) }).strict();

type RouteContext = Context<{ Bindings: AuthEnvironment; Variables: AppVariables }>;

function environmentOf(context: RouteContext): ApplicationEnvironment {
  const value = context.env.APP_ENV ?? "local";
  return (["local", "preview", "staging", "production"] as const).includes(value as ApplicationEnvironment) ? value as ApplicationEnvironment : "local";
}

function audit(execution: AppExecutionContext, context: RouteContext): MachineAccessAudit {
  return { actor: { type: "user", id: execution.principal.id }, environment: environmentOf(context), correlationId: execution.correlation.correlationId, now: execution.clock.now() };
}

async function body<T>(context: RouteContext, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new MachineAccessError("invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

machineAccessRoutes.get("/api/tenant/service-accounts", async (context) => {
  const execution = context.get("execution");
  const accounts = await listServiceAccounts(execution.data, execution.tenant.organizationId);
  return context.json({
    serviceAccounts: accounts.map((account) => ({
      ...account, createdAt: account.createdAt.toISOString(),
      keys: account.keys.map((key) => ({ ...key, createdAt: key.createdAt.toISOString(), expiresAt: iso(key.expiresAt), revokedAt: iso(key.revokedAt) })),
    })),
  });
});

machineAccessRoutes.post("/api/tenant/service-accounts", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, createAccount);
  const unknown = unknownApplicationRoles(input.applicationRoles);
  if (unknown.length) throw new MachineAccessError("invalid", `Unknown application role ${unknown.join(", ")}`);
  const created = await createServiceAccount(execution.data, { organizationId: execution.tenant.organizationId, name: input.name, applicationRoles: input.applicationRoles }, audit(execution, context));
  return context.json(created, 201);
});

machineAccessRoutes.post("/api/tenant/service-accounts/:id/api-keys", async (context) => {
  const execution = context.get("execution");
  const organizationId = execution.tenant.organizationId;
  const input = await body(context, createKey);
  const account = await findServiceAccount(execution.data, organizationId, context.req.param("id"));
  if (!account) throw new MachineAccessError("not_found", "The service account does not exist");
  const problems = validateApiKeyScopes(permissions, input.scopes);
  // A key carries at most its service account's authority.
  const authority = applicationRoles.resolve(account.applicationRoles).permissions;
  for (const scope of input.scopes) if (!problems.length && !authority.has(scope)) problems.push(`${scope} exceeds the service account's application roles`);
  if (problems.length) throw new MachineAccessError("invalid", problems.join("; "));
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
  if (expiresAt && expiresAt <= execution.clock.now()) throw new MachineAccessError("invalid", "An API key must expire in the future");
  const environment = environmentOf(context);
  const minted = await mintApiKey(environment);
  await storeApiKey(execution.data, { organizationId, serviceAccountId: account.id, name: input.name, environment, key: minted, scopes: input.scopes, ...(expiresAt ? { expiresAt } : {}) }, audit(execution, context));
  return context.json({ id: minted.publicId, displayPrefix: minted.displayPrefix, token: minted.token, scopes: [...new Set(input.scopes)].sort(), expiresAt: iso(expiresAt ?? null) }, 201);
});

machineAccessRoutes.post("/api/tenant/api-keys/:id/rotate", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, rotateKey);
  const now = execution.clock.now();
  const minted = await mintApiKey(environmentOf(context));
  const oldKeyExpiresAt = rotationExpiry(now, input.overlapHours ?? 24);
  const rotated = await rotateApiKey(execution.data, { organizationId: execution.tenant.organizationId, keyId: context.req.param("id"), key: minted, oldKeyExpiresAt }, audit(execution, context));
  return context.json({ id: minted.publicId, displayPrefix: minted.displayPrefix, token: minted.token, scopes: rotated.scopes, previousKeyExpiresAt: rotated.previousKeyExpiresAt.toISOString() }, 201);
});

machineAccessRoutes.post("/api/tenant/api-keys/:id/revoke", async (context) => {
  const execution = context.get("execution");
  const input = await body(context, revokeKey);
  await revokeApiKey(execution.data, { organizationId: execution.tenant.organizationId, keyId: context.req.param("id"), reason: input.reason }, audit(execution, context));
  return context.json({ revoked: true });
});

const status = { invalid: 422, not_found: 404, conflict: 409 } as const;
machineAccessRoutes.onError((error, context) => {
  if (error instanceof MachineAccessError) return context.json({ error: error.code, message: error.message }, status[error.code]);
  throw error;
});
