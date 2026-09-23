import type { RegionalValues } from "./identifiers.js";

export type RegionalPreview = Readonly<{ dateTime: string; date: string; number: string; currency: string; percent: string }>;

/** Sample values rendered under a candidate context, so settings never read as opaque codes. */
export function regionalPreview(context: Pick<RegionalValues, "locale" | "timeZone" | "currency">, instant: Date): RegionalPreview {
  const { locale, timeZone, currency } = context;
  return {
    dateTime: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(instant),
    date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone }).format(instant),
    number: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(1234567.89),
    currency: new Intl.NumberFormat(locale, { style: "currency", currency }).format(12345.67),
    percent: new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(0.125),
  };
}

/**
 * Exact money: an integer count of the currency's minor units plus its ISO
 * 4217 code. A value always keeps its own currency; changing a default never
 * converts or reinterprets it.
 */
export type Money = Readonly<{ amountMinor: string; currency: string }>;

export function currencyMinorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function money(amountMinor: bigint | number | string, currency: string): Money {
  const minor = BigInt(amountMinor);
  return { amountMinor: minor.toString(), currency };
}

/** Formats without floating-point conversion: the decimal string goes straight to Intl. */
export function formatMoney(value: Money, locale: string): string {
  const digits = currencyMinorDigits(value.currency);
  const minor = BigInt(value.amountMinor);
  const negative = minor < 0n;
  const absolute = (negative ? -minor : minor).toString().padStart(digits + 1, "0");
  const decimal = digits === 0 ? absolute : `${absolute.slice(0, -digits)}.${absolute.slice(-digits)}`;
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: value.currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
  return formatter.format(`${negative ? "-" : ""}${decimal}` as unknown as number);
}

const displayNames = new Map<string, Intl.DisplayNames>();
function names(locale: string, type: "language" | "currency"): Intl.DisplayNames {
  const key = `${locale}:${type}`;
  let value = displayNames.get(key);
  if (!value) { value = new Intl.DisplayNames([locale], { type, fallback: "code", languageDisplay: "standard" }); displayNames.set(key, value); }
  return value;
}

/** "English (United States) — en-US" */
export function localeLabel(tag: string, displayLocale = "en-US"): string {
  return `${names(displayLocale, "language").of(tag) ?? tag} — ${tag}`;
}

/** "English" */
export function languageLabel(language: string, displayLocale = "en-US"): string {
  return names(displayLocale, "language").of(language) ?? language;
}

/** "USD — US Dollar" */
export function currencyLabel(code: string, displayLocale = "en-US"): string {
  return `${code} — ${names(displayLocale, "currency").of(code) ?? code}`;
}
