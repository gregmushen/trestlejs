import { supportedTimeZones } from "./identifiers.js";
import { formatOffset } from "./zones.js";

export type TimeZoneOption = Readonly<{
  id: string;
  /** "Los Angeles" */
  city: string;
  /** "Pacific Time" */
  name: string;
  /** "UTC−07:00" at the reference instant; informational only. */
  offset: string;
  /** Alphabetic abbreviations such as PST and PDT, when the display locale has them. */
  abbreviations: readonly string[];
}>;

/**
 * Well-known cities that are not themselves IANA location names. Search
 * matches them; the persisted value is always the zone identifier.
 */
const cityAliases: Readonly<Record<string, string>> = {
  "America/Los_Angeles": "Seattle San Francisco San Diego Portland Las Vegas",
  "America/Denver": "Salt Lake City Albuquerque Boise",
  "America/Chicago": "Dallas Houston Austin Minneapolis Saint Louis Kansas City New Orleans",
  "America/New_York": "Boston Washington Philadelphia Atlanta Miami Pittsburgh",
  "America/Toronto": "Ottawa Montreal Quebec",
  "America/Sao_Paulo": "Rio de Janeiro",
  "Asia/Kolkata": "Mumbai Delhi Bangalore Bengaluru Chennai",
  "Asia/Shanghai": "Beijing Shenzhen Guangzhou",
  "Asia/Tokyo": "Osaka Kyoto",
  "Europe/Berlin": "Munich Frankfurt Hamburg",
  "Europe/Zurich": "Geneva Basel",
  "Australia/Sydney": "Canberra",
};

function part(formatter: Intl.DateTimeFormat, instant: Date): string {
  return formatter.formatToParts(instant).find((item) => item.type === "timeZoneName")?.value ?? "";
}

const optionCache = new Map<string, readonly TimeZoneOption[]>();

/** Every supported zone with friendly labels in the display locale. */
export function timeZoneOptions(reference: Date, displayLocale = "en-US"): readonly TimeZoneOption[] {
  const key = `${displayLocale}:${reference.toISOString().slice(0, 10)}`;
  const cached = optionCache.get(key);
  if (cached) return cached;
  const year = reference.getUTCFullYear();
  const january = new Date(Date.UTC(year, 0, 15));
  const july = new Date(Date.UTC(year, 6, 15));
  const options = supportedTimeZones().map((id): TimeZoneOption => {
    const generic = new Intl.DateTimeFormat(displayLocale, { timeZone: id, timeZoneName: "longGeneric" });
    const short = new Intl.DateTimeFormat(displayLocale, { timeZone: id, timeZoneName: "short" });
    const abbreviations = [...new Set([part(short, january), part(short, july)])].filter((value) => /^[A-Z]{2,5}$/u.test(value));
    return { id, city: (id.split("/").at(-1) ?? id).replaceAll("_", " "), name: part(generic, reference), offset: formatOffset(reference, id), abbreviations };
  });
  optionCache.set(key, options);
  return options;
}

const normalize = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase().replaceAll("_", " ").trim();

/**
 * Matches identifiers, cities, well-known city aliases, zone names, and
 * abbreviations: "Seattle", "Pacific", "Los Angeles", "America/Los_Angeles",
 * "PST", and "PDT" all find America/Los_Angeles.
 */
export function searchTimeZones(query: string, options: readonly TimeZoneOption[], limit = 20): TimeZoneOption[] {
  const needle = normalize(query);
  if (!needle) return options.slice(0, limit);
  const scored: Array<[number, TimeZoneOption]> = [];
  for (const option of options) {
    const abbreviation = option.abbreviations.some((value) => value.toLowerCase() === needle);
    const fields = [option.id, option.city, option.name, cityAliases[option.id] ?? ""].map(normalize);
    const score = abbreviation || fields[0] === needle || fields[1] === needle ? 0
      : fields.some((field) => field.startsWith(needle) || field.includes(` ${needle}`)) ? 1
        : fields.some((field) => field.includes(needle)) ? 2 : -1;
    if (score >= 0) scored.push([score, option]);
  }
  return scored.sort((left, right) => left[0] - right[0] || left[1].id.localeCompare(right[1].id)).slice(0, limit).map(([, option]) => option);
}
