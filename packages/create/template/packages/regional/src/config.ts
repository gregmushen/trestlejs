import { canonicalCurrency, canonicalLanguage, canonicalLocale, canonicalTimeZone, type RegionalValues } from "./identifiers.js";

/**
 * Application regional defaults, declared under `regional:` in
 * .trestle/project.yaml and edited with `trestle setup`. Deployed surfaces
 * read them; they never write them.
 */
export type ApplicationRegionalConfig = Readonly<{
  defaults: RegionalValues;
  /** Optional application translation; when disabled the application language is fixed. */
  i18n: Readonly<{ enabled: boolean; languages: readonly string[] }>;
  /** Whether organizations may override the defaults (Settings → Organization → Regional). */
  organizationSettings: boolean;
}>;

export type RegionalConfigResult = Readonly<{ config: ApplicationRegionalConfig; issues: readonly string[] }>;

export const fallbackRegionalDefaults: RegionalValues = { language: "en", locale: "en-US", timeZone: "UTC", currency: "USD" };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Validates a `regional:` declaration. Invalid values fall back to safe
 * defaults and are reported as issues, so deployed surfaces keep working and
 * can direct operators to `trestle setup`.
 */
export function applicationRegionalConfig(declaration: unknown): RegionalConfigResult {
  const raw = record(declaration);
  const i18n = record(raw.i18n);
  const issues: string[] = [];
  const i18nEnabled = i18n.enabled === true;
  const requestedLanguages = Array.isArray(i18n.languages) ? i18n.languages : [];
  const language = typeof raw.language === "string" ? raw.language.toLowerCase() : fallbackRegionalDefaults.language;
  const isLanguage = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z]{2,3}$/u.test(value);
  if (!requestedLanguages.every(isLanguage)) issues.push("Supported languages must be two- or three-letter language codes.");
  const languages = [...new Set([language, ...requestedLanguages.filter(isLanguage).map((value) => value.toLowerCase())])];
  const pick = (name: keyof RegionalValues, canonical: (value: unknown) => string | null, label: string): string => {
    if (raw[name] === undefined) return fallbackRegionalDefaults[name];
    const value = canonical(raw[name]);
    if (value) return value;
    issues.push(`Application default ${label} is invalid.`);
    return fallbackRegionalDefaults[name];
  };
  const defaults: RegionalValues = {
    language: pick("language", (value) => canonicalLanguage(value, languages), "language"),
    locale: pick("locale", (value) => canonicalLocale(value), "locale"),
    timeZone: pick("timeZone", canonicalTimeZone, "time zone"),
    currency: pick("currency", (value) => canonicalCurrency(value), "currency"),
  };
  return {
    config: { defaults, i18n: { enabled: i18nEnabled, languages: i18nEnabled ? languages : [defaults.language] }, organizationSettings: raw.organizationSettings !== false },
    issues,
  };
}

/** The languages an organization or user may choose. */
export function selectableLanguages(config: ApplicationRegionalConfig): readonly string[] {
  return config.i18n.enabled ? config.i18n.languages : [config.defaults.language];
}
