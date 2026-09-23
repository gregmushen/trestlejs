import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { PostgresRegionalRepository } from "@__TRESTLE_PROJECT_NAME__/data";
import { applicationSchedules, RegionalService, type OrganizationRegionalSettings, type RegionalRepository } from "@__TRESTLE_PROJECT_NAME__/domain";
import { declaredRegional } from "@__TRESTLE_PROJECT_NAME__/platform";
import type { Hono } from "hono";
import { z } from "zod";

// The project manifest is bundled as text (see wrangler.jsonc rules); it is the only source of application defaults.
import manifestText from "../../../.trestle/project.yaml";
import type { AppVariables } from "./execution-context.js";
import { operationContext } from "./webhook-routes.js";

type Environment = { Bindings: AuthEnvironment; Variables: AppVariables };

const declared = declaredRegional(manifestText);

export const regionalDependencies = {
  config: declared.config,
  issues: declared.issues,
  schedules: applicationSchedules,
  repository: (environment: AuthEnvironment, organizationId: string): RegionalRepository => new PostgresRegionalRepository(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId),
};

export function regionalService(environment: AuthEnvironment, organizationId: string): RegionalService {
  return new RegionalService(regionalDependencies.config, regionalDependencies.repository(environment, organizationId), regionalDependencies.schedules);
}

const setting = z.string().trim().max(64).nullable().optional();
const organizationInput = z.object({ language: setting, locale: setting, timeZone: setting, currency: setting }).strict();
const userInput = z.object({ language: setting, locale: setting, timeZone: setting }).strict();

function organizationDocument(settings: OrganizationRegionalSettings, canManage: boolean) {
  return {
    ...settings,
    canManage: canManage && settings.organizationSettings,
    // Invalid application defaults are repaired in the setup console, never here.
    applicationIssues: regionalDependencies.issues.map((message) => ({ message, repair: "pnpm exec trestle setup" })),
    schedulesFollowingOrganization: regionalDependencies.schedules.filter((schedule) => schedule.zone.kind === "organization").length,
  };
}

/** Organization regional settings and each member's language and region (docs/REGIONAL_SETTINGS_ADMIN_SPEC.md). */
export function registerRegionalRoutes(routes: Hono<Environment>) {
  routes.use("/api/tenant/regional-preferences", async (context, next) => {
    // Preferences belong to a human account; machine principals and support sessions have none.
    if (context.get("execution").principal.kind !== "user" || context.get("execution").support) return context.json({ error: "forbidden", message: "Only members have language and region preferences" }, 403);
    await next();
  });

  routes.get("/api/tenant/regional", async (context) => {
    const execution = context.get("execution");
    const settings = await regionalService(context.env, execution.tenant.organizationId).organization();
    return context.json(organizationDocument(settings, execution.access.check({ permission: "organization.settings.regional.manage" })));
  });

  routes.put("/api/tenant/regional", async (context) => {
    const execution = context.get("execution");
    const input = organizationInput.parse(await context.req.json().catch(() => ({})));
    const { settings, changes } = await regionalService(context.env, execution.tenant.organizationId).updateOrganization(operationContext(execution), input);
    execution.log.info("regional.organization.updated", { changed: Object.keys(changes) });
    return context.json({ ...organizationDocument(settings, true), changes });
  });

  routes.get("/api/tenant/regional/schedules", async (context) => {
    const execution = context.get("execution");
    const service = regionalService(context.env, execution.tenant.organizationId);
    const proposed = context.req.query("timeZone") ?? (await service.organization()).effective.timeZone.value;
    return context.json(await service.scheduleImpact(proposed, execution.clock.now()));
  });

  routes.get("/api/tenant/regional-preferences", async (context) => {
    const execution = context.get("execution");
    return context.json(await regionalService(context.env, execution.tenant.organizationId).user(execution.principal.id));
  });

  routes.put("/api/tenant/regional-preferences", async (context) => {
    const execution = context.get("execution");
    const input = userInput.parse(await context.req.json().catch(() => ({})));
    const { settings, changes } = await regionalService(context.env, execution.tenant.organizationId).updateUser(operationContext(execution), execution.principal.id, input);
    return context.json({ ...settings, changes });
  });
}
