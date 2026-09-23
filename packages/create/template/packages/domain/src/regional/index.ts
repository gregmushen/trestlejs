import { canonicalCurrency, canonicalLanguage, canonicalLocale, canonicalTimeZone, regionalSettings, type RegionalLayer, type RegionalSetting, type RegionalValues } from "./identifiers.js";

export * from "./identifiers.js";
export * from "./resolve.js";

/**
 * The application's regional defaults and supported languages. Organizations
 * may override each setting; a null override inherits this default. Edit these
 * to match the product. Translation is not built in, so by default only the
 * application language is selectable.
 */
export const applicationRegionalDefaults: RegionalValues = { language: "en", locale: "en-US", timeZone: "UTC", currency: "USD" };
export const supportedLanguages: readonly string[] = [applicationRegionalDefaults.language];

export type RegionalValidation = Readonly<{ values: RegionalLayer; problems: readonly string[] }>;

/**
 * Canonicalizes an organization's requested overrides. Null or absent means
 * inherit; anything else must be a supported canonical identifier.
 */
export function validateOrganizationRegional(input: Readonly<Partial<Record<RegionalSetting, unknown>>>): RegionalValidation {
  const canonical: Record<RegionalSetting, (value: unknown) => string | null> = {
    language: (value) => canonicalLanguage(value, supportedLanguages),
    locale: (value) => canonicalLocale(value),
    timeZone: canonicalTimeZone,
    currency: (value) => canonicalCurrency(value),
  };
  const labels: Record<RegionalSetting, string> = { language: "language", locale: "locale", timeZone: "time zone", currency: "currency" };
  const values: Partial<Record<RegionalSetting, string | null>> = {};
  const problems: string[] = [];
  for (const setting of regionalSettings) {
    const requested = input[setting];
    if (requested === undefined || requested === null || requested === "") { values[setting] = null; continue; }
    const value = canonical[setting](requested);
    if (value) values[setting] = value;
    else problems.push(`Unsupported ${labels[setting]}`);
  }
  return { values, problems };
}
