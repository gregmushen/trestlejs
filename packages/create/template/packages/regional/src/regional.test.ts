import { describe, expect, it } from "vitest";

import {
  applicationRegionalConfig, selectableLanguages, canonicalCurrency, canonicalLanguage, canonicalLocale, canonicalTimeZone, currencyLabel, defineSchedules, formatMoney, formatOffset, localeLabel,
  money, nextOccurrence, regionalPreview, resolveRegionalContext, scheduleImpact, searchTimeZones, supportedTimeZones, timeZoneOptions, zonedTimeToInstant,
} from "./index.js";

const application = { language: "en", locale: "en-US", timeZone: "UTC", currency: "USD" } as const;

describe("canonical identifiers", () => {
  it("accepts canonical IANA zones and maps retired names to current ones", () => {
    expect(canonicalTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(supportedTimeZones()).toContain("Asia/Kolkata");
  });

  it("rejects offsets, legacy links, abbreviations, and junk as time zones", () => {
    for (const value of ["+07:00", "US/Pacific", "PST", "America/Nowhere", "", 7, null]) expect(canonicalTimeZone(value)).toBeNull();
  });

  it("canonicalizes supported locales and rejects invalid or unlisted ones", () => {
    expect(canonicalLocale("EN-us")).toBe("en-US");
    expect(canonicalLocale("not a locale")).toBeNull();
    expect(canonicalLocale("fr-FR", ["en-US"])).toBeNull();
  });

  it("limits languages to the application's supported set", () => {
    expect(canonicalLanguage("ES", ["en", "es"])).toBe("es");
    expect(canonicalLanguage("fr", ["en", "es"])).toBeNull();
    expect(canonicalLanguage("en-US", ["en"])).toBeNull();
  });

  it("accepts ISO 4217 codes and rejects unknown ones", () => {
    expect(canonicalCurrency("usd")).toBe("USD");
    expect(canonicalCurrency("XYZ")).toBeNull();
    expect(canonicalCurrency("EUR", ["USD"])).toBeNull();
    expect(currencyLabel("CAD")).toBe("CAD — Canadian Dollar");
    expect(localeLabel("en-US")).toBe("English (United States) — en-US");
  });
});

describe("resolution", () => {
  it("resolves application → organization → user with provenance per setting", () => {
    const context = resolveRegionalContext({ application, organization: { timeZone: "America/Los_Angeles", locale: null }, user: { language: "es", timeZone: "America/New_York", currency: "EUR" } });
    expect(context.timeZone).toEqual({ value: "America/New_York", source: "user" });
    expect(context.language).toEqual({ value: "es", source: "user" });
    expect(context.locale).toEqual({ value: "en-US", source: "application" });
    // Currency is not a user preference by default.
    expect(context.currency).toEqual({ value: "USD", source: "application" });
    expect(resolveRegionalContext({ application, user: { currency: "EUR" } }, { userCurrency: true }).currency.source).toBe("user");
  });

  it("lets an explicit operation override win", () => {
    expect(resolveRegionalContext({ application, organization: { timeZone: "Europe/Paris" }, operation: { timeZone: "Asia/Tokyo" } }).timeZone).toEqual({ value: "Asia/Tokyo", source: "operation" });
  });
});

describe("preview formatting", () => {
  const instant = new Date("2026-09-22T23:14:00.000Z");

  it("formats under the locale and zone", () => {
    const preview = regionalPreview({ locale: "en-US", timeZone: "America/Los_Angeles", currency: "USD" }, instant);
    // ICU versions differ on the space before the day period; compare it as whitespace.
    expect(preview.dateTime).toMatch(/^Sep 22, 2026, 4:14\sPM$/u);
    expect(preview).toMatchObject({ date: "September 22, 2026", number: "1,234,567.89", currency: "$12,345.67", percent: "12.5%" });
    const german = regionalPreview({ locale: "de-DE", timeZone: "Europe/Berlin", currency: "EUR" }, instant);
    expect(german.date).toBe("23. September 2026");
    expect(german.number).toBe("1.234.567,89");
  });

  it("shows an informational offset", () => {
    expect(formatOffset(instant, "America/Los_Angeles")).toBe("UTC−07:00");
    expect(formatOffset(new Date("2026-01-15T00:00:00Z"), "Asia/Kolkata")).toBe("UTC+05:30");
  });
});

describe("money", () => {
  it("formats exact minor units in the value's own currency, regardless of defaults", () => {
    const price = money(1234567n, "USD");
    expect(formatMoney(price, "en-US")).toBe("$12,345.67");
    expect(formatMoney(money(1500, "JPY"), "en-US")).toBe("¥1,500");
    expect(formatMoney(money("-5", "USD"), "en-US")).toBe("-$0.05");
    // Formatting under a different locale never changes the amount or currency.
    expect(price).toEqual({ amountMinor: "1234567", currency: "USD" });
    expect(formatMoney(money("900719925474099312", "USD"), "en-US")).toBe("$9,007,199,254,740,993.12");
  });
});

describe("zone search", () => {
  const options = timeZoneOptions(new Date("2026-09-22T12:00:00Z"));
  it.each(["Seattle", "Pacific", "Los Angeles", "America/Los_Angeles", "PST", "PDT"])("finds America/Los_Angeles for %s", (query) => {
    expect(searchTimeZones(query, options).map((option) => option.id)).toContain("America/Los_Angeles");
  });
  it("labels zones without requiring the identifier", () => {
    expect(options.find((option) => option.id === "America/Los_Angeles")).toMatchObject({ city: "Los Angeles", name: "Pacific Time", offset: "UTC−07:00" });
  });
});

describe("wall-clock schedules", () => {
  const schedules = defineSchedules([
    { key: "operations.digest", name: "Daily operations digest", time: "09:00", zone: { kind: "organization" } },
    { key: "report.new_york", name: "Monthly New York report", time: "09:00", zone: { kind: "zoned", timeZone: "America/New_York" } },
  ]);
  const now = new Date("2026-09-22T12:00:00Z");

  it("resolves organization-relative schedules under the new default", () => {
    expect(nextOccurrence(schedules[0], "America/Los_Angeles", now).toISOString()).toBe("2026-09-22T16:00:00.000Z");
    expect(nextOccurrence(schedules[0], "Europe/Paris", now).toISOString()).toBe("2026-09-23T07:00:00.000Z");
  });

  it("leaves explicitly zoned schedules unchanged when the organization default changes", () => {
    const [digest, report] = scheduleImpact(schedules, "America/Los_Angeles", "Europe/Paris", now);
    expect(digest).toMatchObject({ followsOrganization: true, description: "09:00 organization time" });
    expect(digest!.current).not.toBe(digest!.proposed);
    expect(report).toMatchObject({ followsOrganization: false, description: "09:00 America/New_York" });
    expect(report!.current).toBe(report!.proposed);
  });

  it("moves DST-gap times forward and picks the first occurrence of repeated times", () => {
    expect(zonedTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/Los_Angeles").toISOString()).toBe("2026-03-08T10:30:00.000Z");
    expect(zonedTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/Los_Angeles").toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });

  it("rejects malformed definitions", () => {
    expect(() => defineSchedules([{ key: "bad", name: "Bad", time: "25:00", zone: { kind: "organization" } }])).toThrow("HH:MM");
    expect(() => defineSchedules([{ key: "bad", name: "Bad", time: "09:00", zone: { kind: "zoned", timeZone: "US/Pacific" } }])).toThrow("unsupported");
  });
});

describe("application configuration", () => {
  it("reads declared defaults and supported languages", () => {
    const { config, issues } = applicationRegionalConfig({ language: "en", locale: "en-GB", timeZone: "Europe/London", currency: "GBP", i18n: { enabled: true, languages: ["en", "es", "FR"] } });
    expect(issues).toEqual([]);
    expect(config).toEqual({ defaults: { language: "en", locale: "en-GB", timeZone: "Europe/London", currency: "GBP" }, i18n: { enabled: true, languages: ["en", "es", "fr"] }, organizationSettings: true });
    expect(selectableLanguages(config)).toEqual(["en", "es", "fr"]);
  });

  it("fixes the language when i18n is disabled and falls back on invalid values with issues", () => {
    const { config, issues } = applicationRegionalConfig({ timeZone: "Mars/Olympus", currency: "ZZZ", organizationSettings: false });
    expect(config.defaults).toEqual({ language: "en", locale: "en-US", timeZone: "UTC", currency: "USD" });
    expect(selectableLanguages(config)).toEqual(["en"]);
    expect(config.organizationSettings).toBe(false);
    expect(issues).toEqual(["Application default time zone is invalid.", "Application default currency is invalid."]);
  });
});
