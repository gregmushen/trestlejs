import type { ApplicationEnvironment } from "@__TRESTLE_PROJECT_NAME__/authz";
import { PostgresRegionalRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationSchedules, RegionalError, RegionalService, type OperationContext, type RegionalRepository } from "@__TRESTLE_PROJECT_NAME__/domain";
import { declaredRegional, PlatformRequestError, type PlatformAuthority, type PostgresPlatformRepository } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Context, Hono } from "hono";
import { z } from "zod";

// Bundled as text (wrangler.jsonc rules); application defaults are read, never written, by the admin.
import manifestText from "../../../.trestle/project.yaml";

type Bindings = { DATABASE_URL: string; DATABASE_DRIVER?: "neon-http" | "neon-serverless" | "postgres-js"; APP_ENV?: ApplicationEnvironment };
type SupportState = { operation: OperationContext };
type Environment = { Bindings: Bindings; Variables: { authority: PlatformAuthority; correlationId: string; support: SupportState } };
type Dependencies = { repository: (environment: Bindings) => PostgresPlatformRepository; now: () => Date };

const declared = declaredRegional(manifestText);
const setting = z.string().trim().max(64).nullable().optional();
const settingsInput = { language: setting, locale: setting, timeZone: setting, currency: setting };

/** Reads through trestle_platform; the platform role can inspect regional state but never write it. */
class PlatformRegionalReader implements RegionalRepository {
  constructor(private readonly platform: PostgresPlatformRepository, private readonly organizationId: string) {}
  async organizationSettings() { return await this.platform.organizationRegional(this.organizationId); }
  async userPreference(userId: string) { return await this.platform.userRegional(userId); }
  async saveOrganizationSettings(): Promise<void> { throw new PlatformRequestError(403, "forbidden", "Regional settings are read-only on the platform connection"); }
  async saveUserPreference(): Promise<void> { throw new PlatformRequestError(403, "forbidden", "User preferences are never changed by the platform"); }
}

async function regional<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof RegionalError) throw new PlatformRequestError(error.code === "not_enabled" ? 404 : 422, error.code, error.message);
    throw error;
  }
}

async function body<T extends z.ZodType>(context: Context<Environment>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => undefined));
  if (!parsed.success) throw new PlatformRequestError(422, "invalid", parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "));
  return parsed.data;
}

/**
 * Regional configuration in the platform admin (docs/REGIONAL_SETTINGS_ADMIN_SPEC.md §9-§11).
 * Inspection and explanation are read-only. Selecting an organization grants
 * nothing: a change requires either platform recovery authority with step-up
 * and a reason, or a support session whose profile carries tenant authority.
 */
export function registerRegionalRoutes(admin: Hono<Environment>, dependencies: Dependencies) {
  const readService = (context: Context<Environment>, organizationId: string) => new RegionalService(declared.config, new PlatformRegionalReader(dependencies.repository(context.env), organizationId), applicationSchedules);
  const tenantService = (context: Context<Environment>, organizationId: string) => new RegionalService(declared.config, new PostgresRegionalRepository(context.env.DATABASE_URL, context.env.DATABASE_DRIVER, organizationId), applicationSchedules);
  const organizationOf = async (context: Context<Environment>) => {
    const found = await dependencies.repository(context.env).organization(context.req.param("organizationId") ?? "");
    if (!found) throw new PlatformRequestError(404, "not_found", "Organization not found");
    return found;
  };

  admin.get("/api/admin/organizations/:organizationId/regional", async (context) => {
    const authority = context.get("authority");
    authority.require("platform.organizations.regional.read");
    const { organization, members } = await organizationOf(context);
    return context.json({
      ...await readService(context, organization.id).organization(),
      applicationIssues: declared.issues.map((message) => ({ message, repair: "pnpm exec trestle setup" })),
      members: members.map(({ userId, name, email }) => ({ userId, name, email })),
      canRecover: authority.permissions.includes("platform.organizations.regional.recover"),
    });
  });

  admin.get("/api/admin/organizations/:organizationId/regional/resolve", async (context) => {
    context.get("authority").require("platform.organizations.regional.read");
    const { organization, members } = await organizationOf(context);
    const member = members.find(({ userId }) => userId === context.req.query("userId"));
    if (!member) throw new PlatformRequestError(404, "not_found", "That user is not a member of this organization");
    // Evaluates the real resolution policy; nothing is written.
    return context.json({ user: { userId: member.userId, name: member.name }, ...await readService(context, organization.id).user(member.userId) });
  });

  admin.put("/api/admin/organizations/:organizationId/regional", async (context) => {
    const authority = context.get("authority");
    const input = await body(context, z.object({ ...settingsInput, reason: z.unknown() }).strict());
    const why = authority.requireSensitive("platform.organizations.regional.recover", input.reason);
    const { organization } = await organizationOf(context);
    const { reason: _reason, ...values } = input;
    const operation: OperationContext = {
      organizationId: organization.id, actor: { type: "platform_operator", id: authority.operator.id }, correlationId: context.get("correlationId"),
      environment: context.env.APP_ENV ?? "local", now: dependencies.now(), reason: why,
    };
    // The write runs on the tenant's forced-RLS connection so tenant audit records the operator and reason.
    const result = await regional(async () => await tenantService(context, organization.id).updateOrganization(operation, values, "recovery"));
    return context.json({ ...result.settings, changes: result.changes, canRecover: true, applicationIssues: [], members: [] });
  });

  // ---- Inside a support session: tenant authority from the session's frozen profile ----

  admin.get("/api/admin/support/tenant/regional", async (context) => {
    const organizationId = context.get("support").operation.organizationId;
    return context.json(await tenantService(context, organizationId).organization());
  });

  admin.put("/api/admin/support/tenant/regional", async (context) => {
    const operation = context.get("support").operation;
    const values = await body(context, z.object(settingsInput).strict());
    const result = await regional(async () => await tenantService(context, operation.organizationId).updateOrganization(operation, values));
    return context.json({ ...result.settings, changes: result.changes });
  });
}
