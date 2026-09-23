import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { organizationRegionalOverrides, replaceOrganizationRegional } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationRegionalDefaults, resolveRegionalContext, selectableLocales, supportedCurrencies, supportedLanguages, supportedTimeZones, validateOrganizationRegional } from "@__TRESTLE_PROJECT_NAME__/domain";
import { Hono } from "hono";

import { tenantAuditEvent } from "./audit.js";
import { requireExecutionContext, type AppVariables } from "./execution-context.js";

/**
 * Organization regional defaults. Each setting resolves independently from the
 * organization's override or the application default, and reports its source.
 */
export const regionalRoutes = new Hono<{ Bindings: AuthEnvironment; Variables: AppVariables }>();
regionalRoutes.use("/api/tenant/regional", requireExecutionContext);

regionalRoutes.get("/api/tenant/regional", async (context) => {
  const execution = context.get("execution");
  const overrides = await organizationRegionalOverrides(execution.data, execution.tenant.organizationId);
  return context.json({
    effective: resolveRegionalContext({ application: applicationRegionalDefaults, organization: overrides }),
    overrides: overrides ?? { language: null, locale: null, timeZone: null, currency: null },
    options: { languages: supportedLanguages, locales: selectableLocales(overrides?.locale), timeZones: supportedTimeZones(), currencies: supportedCurrencies() },
  });
});

regionalRoutes.put("/api/tenant/regional", async (context) => {
  const execution = context.get("execution");
  const body = await context.req.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return context.json({ error: "invalid", message: "Send the regional settings as JSON" }, 422);
  const { values, problems } = validateOrganizationRegional(body);
  if (problems.length) return context.json({ error: "invalid", message: problems.join("; ") }, 422);
  const overrides = { language: values.language ?? null, locale: values.locale ?? null, timeZone: values.timeZone ?? null, currency: values.currency ?? null };
  const result = await replaceOrganizationRegional(execution.data, {
    organizationId: execution.tenant.organizationId, values: overrides, actor: `${execution.principal.kind}:${execution.principal.id}`, now: execution.clock.now(),
    audit: tenantAuditEvent(execution, context.env.APP_ENV, { name: "organization.regional_settings.changed", target: { type: "organization", id: execution.tenant.organizationId } }),
  });
  return context.json({ effective: resolveRegionalContext({ application: applicationRegionalDefaults, organization: overrides }), overrides, changed: result.changed });
});
