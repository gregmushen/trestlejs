import { describe, expect, it } from "vitest";

import { applicationRegionalDefaults, canonicalTimeZone, resolveRegionalContext, validateOrganizationRegional } from "./index.js";

describe("regional settings", () => {
  it("canonicalizes overrides, inherits nulls, and rejects unsupported values", () => {
    expect(validateOrganizationRegional({ locale: "en-gb", timeZone: "Europe/Kiev", currency: "eur", language: null })).toEqual({
      values: { language: null, locale: "en-GB", timeZone: "Europe/Kyiv", currency: "EUR" }, problems: [],
    });
    expect(validateOrganizationRegional({ timeZone: "Mars/Olympus", currency: "XYZ1", language: "fr" }).problems).toEqual(["Unsupported language", "Unsupported time zone", "Unsupported currency"]);
    expect(canonicalTimeZone("US/Pacific")).toBeNull();
  });

  it("resolves each setting independently and reports where it came from", () => {
    const context = resolveRegionalContext({ application: applicationRegionalDefaults, organization: { timeZone: "Asia/Tokyo", locale: null } });
    expect(context.timeZone).toEqual({ value: "Asia/Tokyo", source: "organization" });
    expect(context.locale).toEqual({ value: "en-US", source: "application" });
  });
});
