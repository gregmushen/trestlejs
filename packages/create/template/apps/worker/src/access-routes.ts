import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { applicationRoles, organizationRoles, unknownApplicationRoles } from "@__TRESTLE_PROJECT_NAME__/authz";
import { applicationRoleHolders, createDatabase, listApplicationRoleGrants, listAuditEvents, member, replaceApplicationRoles } from "@__TRESTLE_PROJECT_NAME__/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { tenantAuditEvent } from "./audit.js";
import { requireExecutionContext, type AppVariables } from "./execution-context.js";

const administratorRole = "app_admin";
const rolesInput = z.object({ roles: z.array(z.string().min(1).max(40)).max(20) }).strict();

/**
 * Tenant access: each member's own effective access, and application-role
 * assignment. Route authority is declared in packages/authz/src/routes.ts and
 * enforced by requireExecutionContext before these handlers run.
 */
export const accessRoutes = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
accessRoutes.use("/api/tenant/*", requireExecutionContext);

accessRoutes.get("/api/tenant/access", (context) => {
  const execution = context.get("execution");
  return context.json({
    organizationId: execution.tenant.organizationId,
    principal: { id: execution.principal.id, type: execution.principal.kind },
    assignments: execution.assignments,
    permissions: [...execution.permissions].sort(),
    roles: { organization: organizationRoles.list(), application: applicationRoles.list() },
  });
});

accessRoutes.get("/api/tenant/application-role-assignments", async (context) => {
  const execution = context.get("execution");
  const grants = await listApplicationRoleGrants(execution.data, execution.tenant.organizationId);
  return context.json({ assignments: grants.map((grant) => ({ ...grant, grantedAt: grant.grantedAt.toISOString() })) });
});

accessRoutes.get("/api/tenant/audit", async (context) => {
  const execution = context.get("execution");
  const before = context.req.query("before");
  const beforeDate = before ? new Date(before) : undefined;
  if (beforeDate && Number.isNaN(beforeDate.getTime())) return context.json({ error: "invalid", message: "before must be an ISO timestamp" }, 422);
  const events = await listAuditEvents(execution.data, execution.tenant.organizationId, { limit: Number(context.req.query("limit") ?? 50), ...(beforeDate ? { before: beforeDate } : {}) });
  return context.json({ events: events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })) });
});

accessRoutes.put("/api/tenant/users/:userId/application-roles", async (context) => {
  const execution = context.get("execution");
  const organizationId = execution.tenant.organizationId;
  const userId = context.req.param("userId");
  const parsed = rolesInput.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) return context.json({ error: "invalid", message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ") }, 422);
  const unknown = unknownApplicationRoles(parsed.data.roles);
  if (unknown.length) return context.json({ error: "invalid", message: `Unknown application role ${unknown.join(", ")}` }, 422);
  // Membership lives in Better Auth; the explicit organization predicate keeps the check tenant-bound.
  const [target] = await createDatabase(context.env.DATABASE_URL, context.env.DATABASE_DRIVER).select({ userId: member.userId }).from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId))).limit(1);
  if (!target) return context.json({ error: "not_found", message: "That user is not a member of this organization" }, 404);
  const holders = await applicationRoleHolders(execution.data, organizationId, administratorRole);
  if (holders.length === 1 && holders[0] === userId && !parsed.data.roles.includes(administratorRole)) {
    return context.json({ error: "conflict", message: "The organization must keep at least one application administrator" }, 409);
  }
  const change = await replaceApplicationRoles(execution.data, {
    organizationId, userId, roles: parsed.data.roles, actor: `user:${execution.principal.id}`, now: execution.clock.now(),
    audit: tenantAuditEvent(execution, context.env.APP_ENV, { name: "access.application_roles.changed", target: { type: "user", id: userId } }),
  });
  execution.log.info("access.application_roles.changed", { targetUserId: userId, added: change.added, removed: change.removed });
  return context.json({ userId, roles: [...new Set(parsed.data.roles)].sort(), ...change });
});
