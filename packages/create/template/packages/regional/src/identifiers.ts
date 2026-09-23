/**
 * Canonical regional identifiers. Persisted values are always the canonical
 * identifier (IANA zone, BCP 47 locale, ISO 4217 code); friendly labels are a
 * presentation concern computed from them.
 */
export type RegionalSetting = "language" | "locale" | "timeZone" | "currency";
export const regionalSettings: readonly RegionalSetting[] = ["language", "locale", "timeZone", "currency"];

export type RegionalValues = Readonly<Record<RegionalSetting, string>>;
/** A layer that may leave any setting unset (null or absent) to inherit. */
export type RegionalLayer = Readonly<Partial<Record<RegionalSetting, string | null>>>;

/**
 * ICU still reports some zones under retired IANA names. Trestle persists the
 * current IANA identifier; either spelling is accepted on input.
 */
const retiredZoneNames: Readonly<Record<string, string>> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

function acceptedByRuntime(timeZone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

let zoneCache: readonly string[] | undefined;
/** Canonical IANA zones this runtime can format, sorted. Offsets and legacy links (US/Pacific) are excluded. */
export function supportedTimeZones(): readonly string[] {
  if (zoneCache) return zoneCache;
  const zones = new Set<string>(["UTC"]);
  for (const zone of Intl.supportedValuesOf("timeZone")) {
    const current = retiredZoneNames[zone] ?? zone;
    zones.add(acceptedByRuntime(current) ? current : zone);
  }
  zoneCache = [...zones].sort();
  return zoneCache;
}

/** Returns the canonical IANA identifier, or null when the value is not a supported zone. */
export function canonicalTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const candidate = retiredZoneNames[value] ?? value;
  return supportedTimeZones().includes(candidate) ? candidate : null;
}

/**
 * Returns the canonical BCP 47 tag when the runtime can format it, else null.
 * `allowed`, when given, is the application's supported locale list.
 */
export function canonicalLocale(value: unknown, allowed?: readonly string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 35) return null;
  let canonical: string;
  try { [canonical = ""] = Intl.getCanonicalLocales(value); } catch { return null; }
  if (!canonical || Intl.DateTimeFormat.supportedLocalesOf([canonical]).length === 0 || Intl.NumberFormat.supportedLocalesOf([canonical]).length === 0) return null;
  if (allowed && !allowed.includes(canonical)) return null;
  return canonical;
}

/** Languages are bare BCP 47 language subtags ("en", "es") drawn from the application's supported set. */
export function canonicalLanguage(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{2,3}$/u.test(value)) return null;
  const language = value.toLowerCase();
  return allowed.includes(language) ? language : null;
}

let currencyCache: readonly string[] | undefined;
export function supportedCurrencies(): readonly string[] {
  currencyCache ??= Intl.supportedValuesOf("currency").filter((code) => /^[A-Z]{3}$/u.test(code));
  return currencyCache;
}

/** Returns the ISO 4217 code, or null. `allowed`, when given, narrows to the application's currencies. */
export function canonicalCurrency(value: unknown, allowed?: readonly string[]): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/u.test(value)) return null;
  const code = value.toUpperCase();
  if (!supportedCurrencies().includes(code)) return null;
  if (allowed && !allowed.includes(code)) return null;
  return code;
}

/** Locales offered by default in settings forms; the stored value may be any supported locale. */
const commonLocaleTags = ["en-US", "en-GB", "en-CA", "en-AU", "en-IN", "es-ES", "es-MX", "fr-FR", "fr-CA", "de-DE", "it-IT", "pt-BR", "pt-PT", "nl-NL", "sv-SE", "da-DK", "nb-NO", "fi-FI", "pl-PL", "tr-TR", "ja-JP", "ko-KR", "zh-CN", "zh-TW", "hi-IN", "ar-SA", "he-IL"];

export function selectableLocales(current?: string | null): readonly string[] {
  const supported = commonLocaleTags.filter((tag) => canonicalLocale(tag) === tag);
  return current && !supported.includes(current) ? [current, ...supported] : supported;
}
