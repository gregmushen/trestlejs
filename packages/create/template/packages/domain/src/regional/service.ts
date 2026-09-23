import {
  canonicalCurrency, canonicalLanguage, canonicalLocale, canonicalTimeZone, resolveRegionalContext, scheduleImpact, selectableLanguages,
  type ApplicationRegionalConfig, type RegionalContext, type RegionalSetting, type RegionalValues, type ScheduleDefinition, type ScheduleImpact,
} from "@__TRESTLE_PROJECT_NAME__/regional";

import type { OperationContext } from "../access/ports.js";
import { emptyOrganizationRegional, emptyUserRegional, type OrganizationRegionalRecord, type RegionalRepository, type UserRegionalRecord } from "./ports.js";
import { applicationSchedules } from "./schedules.js";

export class RegionalError extends Error {
  constructor(readonly code: "invalid" | "not_enabled", message: string) {
    super(message);
    this.name = "RegionalError";
  }
}

/** Input from a settings form: a canonical value, or null to inherit. */
export type RegionalInput = Readonly<Partial<Record<RegionalSetting, string | null | undefined>>>;

export type OrganizationRegionalSettings = Readonly<{
  configured: OrganizationRegionalRecord;
  effective: RegionalContext;
  application: RegionalValues;
  /** Whether organizations may override application defaults. */
  organizationSettings: boolean;
  i18n: ApplicationRegionalConfig["i18n"];
  languages: readonly string[];
}>;

export type UserRegionalSettings = Readonly<{
  configured: UserRegionalRecord;
  effective: RegionalContext;
  /** The organization's effective defaults, shown beside "Use organization default". */
  organization: RegionalContext;
  languages: readonly string[];
}>;

export type RegionalChanges = Readonly<Partial<Record<RegionalSetting, Readonly<{ from: string | null; to: string | null }>>>>;

export type ScheduleImpactReport = Readonly<{ timeZone: string; proposedTimeZone: string; organizationRelative: readonly ScheduleImpact[]; zoned: readonly ScheduleImpact[] }>;

const organizationFields = ["language", "locale", "timeZone", "currency"] as const;
const userFields = ["language", "locale", "timeZone"] as const;

function changes<Record_ extends Readonly<Partial<Record<RegionalSetting, string | null>>>>(before: Record_, after: Record_, fields: readonly RegionalSetting[]): RegionalChanges {
  return Object.fromEntries(fields.filter((field) => (before[field] ?? null) !== (after[field] ?? null)).map((field) => [field, { from: before[field] ?? null, to: after[field] ?? null }]));
}

/**
 * Regional settings: organization defaults, user preferences, and their
 * resolution against application defaults. Settings configure defaults and
 * presentation; they never rewrite stored timestamps or monetary values.
 */
export class RegionalService {
  constructor(
    private readonly config: ApplicationRegionalConfig,
    private readonly repository: RegionalRepository,
    private readonly schedules: readonly ScheduleDefinition[] = applicationSchedules,
  ) {}

  private validate(input: RegionalInput, fields: readonly RegionalSetting[]): Record<RegionalSetting, string | null> {
    const unknown = Object.keys(input).filter((key) => !fields.includes(key as RegionalSetting));
    if (unknown.length) throw new RegionalError("invalid", `${unknown.join(", ")} cannot be set here`);
    const languages = selectableLanguages(this.config);
    const checks: Record<RegionalSetting, [(value: string) => string | null, string]> = {
      language: [(value) => canonicalLanguage(value, languages), `Language must be one of ${languages.join(", ")}`],
      locale: [(value) => canonicalLocale(value), "Locale must be a supported BCP 47 locale such as en-US"],
      timeZone: [canonicalTimeZone, "Time zone must be an IANA time zone such as America/Los_Angeles"],
      currency: [(value) => canonicalCurrency(value), "Currency must be a supported ISO 4217 code such as USD"],
    };
    const result = {} as Record<RegionalSetting, string | null>;
    for (const field of fields) {
      const value = input[field];
      if (value === undefined || value === null || value === "") { result[field] = null; continue; }
      const [canonical, message] = checks[field];
      const valid = canonical(value);
      if (!valid) throw new RegionalError("invalid", message);
      result[field] = valid;
    }
    return result;
  }

  async organization(): Promise<OrganizationRegionalSettings> {
    const configured = await this.repository.organizationSettings() ?? emptyOrganizationRegional;
    return {
      configured,
      effective: resolveRegionalContext({ application: this.config.defaults, organization: this.config.organizationSettings ? configured : null }),
      application: this.config.defaults,
      organizationSettings: this.config.organizationSettings,
      i18n: this.config.i18n,
      languages: selectableLanguages(this.config),
    };
  }

  /**
   * Saves organization defaults. Tenant administrators record
   * `organization.regional_settings.updated`; a platform recovery records
   * `platform.organization_regional_settings.recovered` with its reason.
   */
  async updateOrganization(context: OperationContext, input: RegionalInput, kind: "tenant" | "recovery" = "tenant"): Promise<{ settings: OrganizationRegionalSettings; changes: RegionalChanges }> {
    if (!this.config.organizationSettings) throw new RegionalError("not_enabled", "Organization regional settings are not enabled for this application");
    if (kind === "recovery" && !context.reason) throw new RegionalError("invalid", "A platform recovery requires a reason");
    const before = await this.repository.organizationSettings() ?? emptyOrganizationRegional;
    const after = this.validate(input, organizationFields);
    const changed = changes(before, after, organizationFields);
    if (Object.keys(changed).length) {
      const name = kind === "recovery" ? "platform.organization_regional_settings.recovered" : "organization.regional_settings.updated";
      await this.repository.saveOrganizationSettings(after, {
        context,
        audit: { name, targetType: "organization", targetId: context.organizationId, ...(context.reason ? { reason: context.reason } : {}), summary: changed, outcome: "succeeded" },
        // Future defaults only; nothing historical is rewritten.
        event: { name, resourceType: "organization", resourceId: context.organizationId, payload: { organizationId: context.organizationId, changed: Object.keys(changed) } },
      });
    }
    return { settings: await this.organization(), changes: changed };
  }

  async user(userId: string): Promise<UserRegionalSettings> {
    const [organization, configured] = await Promise.all([this.organization(), this.repository.userPreference(userId)]);
    const preference = configured ?? emptyUserRegional;
    return {
      configured: preference,
      effective: resolveRegionalContext({ application: this.config.defaults, organization: this.config.organizationSettings ? organization.configured : null, user: preference }),
      organization: organization.effective,
      languages: organization.languages,
    };
  }

  /** Saves the caller's own preferences. Currency is not a user preference. */
  async updateUser(context: OperationContext, userId: string, input: RegionalInput): Promise<{ settings: UserRegionalSettings; changes: RegionalChanges }> {
    const before = await this.repository.userPreference(userId) ?? emptyUserRegional;
    const after = this.validate(input, userFields) as UserRegionalRecord;
    const changed = changes(before, after, userFields);
    if (Object.keys(changed).length) {
      await this.repository.saveUserPreference(userId, { language: after.language, locale: after.locale, timeZone: after.timeZone }, {
        context,
        audit: { name: "user.regional_preferences.updated", targetType: "user", targetId: userId, summary: changed, outcome: "succeeded" },
        event: { name: "user.regional_preferences.updated", resourceType: "user", resourceId: userId, payload: { organizationId: context.organizationId, userId, changed: Object.keys(changed) } },
      });
    }
    return { settings: await this.user(userId), changes: changed };
  }

  /** Which schedules follow organization time, and when each would next run under a proposed zone. */
  async scheduleImpact(proposedTimeZone: string, now: Date): Promise<ScheduleImpactReport> {
    const proposed = canonicalTimeZone(proposedTimeZone);
    if (!proposed) throw new RegionalError("invalid", "Time zone must be an IANA time zone such as America/Los_Angeles");
    const current = (await this.organization()).effective.timeZone.value;
    const impact = scheduleImpact(this.schedules, current, proposed, now);
    return { timeZone: current, proposedTimeZone: proposed, organizationRelative: impact.filter((item) => item.followsOrganization), zoned: impact.filter((item) => !item.followsOrganization) };
  }
}
