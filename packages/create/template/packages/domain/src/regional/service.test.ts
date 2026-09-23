import { applicationRegionalConfig, defineSchedules, money } from "@__TRESTLE_PROJECT_NAME__/regional";
import { describe, expect, it } from "vitest";

import type { OperationContext } from "../access/ports.js";
import { InMemoryRegionalRepository } from "./in-memory.js";
import { RegionalError, RegionalService } from "./service.js";

const now = new Date("2026-09-22T12:00:00.000Z");
const context: OperationContext = { organizationId: "org-1", actor: { type: "user", id: "admin-1" }, correlationId: "corr-1", environment: "local", now };
const configured = (declaration: Record<string, unknown> = {}) => applicationRegionalConfig({ language: "en", locale: "en-US", timeZone: "UTC", currency: "USD", ...declaration }).config;

describe("organization regional settings", () => {
  it("persists canonical values and reports organization or application provenance", async () => {
    const repository = new InMemoryRegionalRepository();
    const service = new RegionalService(configured(), repository);
    expect((await service.organization()).effective.timeZone).toEqual({ value: "UTC", source: "application" });
    const { settings, changes } = await service.updateOrganization(context, { timeZone: "America/Los_Angeles", locale: "en-GB", currency: "cad" });
    expect(repository.organization).toEqual({ language: null, locale: "en-GB", timeZone: "America/Los_Angeles", currency: "CAD" });
    expect(settings.effective).toMatchObject({ timeZone: { value: "America/Los_Angeles", source: "organization" }, language: { value: "en", source: "application" }, currency: { value: "CAD", source: "organization" } });
    expect(changes).toEqual({ locale: { from: null, to: "en-GB" }, timeZone: { from: null, to: "America/Los_Angeles" }, currency: { from: null, to: "CAD" } });
  });

  it("records one semantic audit event with safe before/after values", async () => {
    const repository = new InMemoryRegionalRepository();
    repository.organization = { language: null, locale: "en-US", timeZone: "America/New_York", currency: null };
    await new RegionalService(configured(), repository).updateOrganization(context, { locale: "en-US", timeZone: "America/Los_Angeles" });
    expect(repository.mutations).toHaveLength(1);
    expect(repository.mutations[0]!.audit).toEqual({ name: "organization.regional_settings.updated", targetType: "organization", targetId: "org-1", summary: { timeZone: { from: "America/New_York", to: "America/Los_Angeles" } }, outcome: "succeeded" });
    expect(repository.mutations[0]!.event).toMatchObject({ name: "organization.regional_settings.updated", payload: { organizationId: "org-1", changed: ["timeZone"] } });
  });

  it("does not write or audit an unchanged save", async () => {
    const repository = new InMemoryRegionalRepository();
    const service = new RegionalService(configured(), repository);
    await service.updateOrganization(context, {});
    expect(repository.mutations).toEqual([]);
  });

  it.each([
    [{ timeZone: "US/Pacific" }, "IANA"], [{ timeZone: "+07:00" }, "IANA"], [{ locale: "not a locale" }, "BCP 47"],
    [{ currency: "ZZZ" }, "ISO 4217"], [{ language: "fr" }, "Language must be one of en"], [{ region: "US" }, "cannot be set here"],
  ])("rejects %j", async (input, message) => {
    const repository = new InMemoryRegionalRepository();
    await expect(new RegionalService(configured(), repository).updateOrganization(context, input as never)).rejects.toThrow(message);
    expect(repository.mutations).toEqual([]);
  });

  it("offers only the application language when i18n is disabled and any declared language when enabled", async () => {
    expect((await new RegionalService(configured(), new InMemoryRegionalRepository()).organization()).languages).toEqual(["en"]);
    const i18n = new RegionalService(configured({ i18n: { enabled: true, languages: ["en", "es"] } }), new InMemoryRegionalRepository());
    await expect(i18n.updateOrganization(context, { language: "es" })).resolves.toMatchObject({ settings: { effective: { language: { value: "es", source: "organization" } } } });
  });

  it("refuses organization changes when organization settings are disabled", async () => {
    await expect(new RegionalService(configured({ organizationSettings: false }), new InMemoryRegionalRepository()).updateOrganization(context, { timeZone: "Europe/Paris" })).rejects.toBeInstanceOf(RegionalError);
  });

  it("names platform recovery separately and requires its reason", async () => {
    const repository = new InMemoryRegionalRepository();
    const service = new RegionalService(configured(), repository);
    const operator: OperationContext = { ...context, actor: { type: "platform_operator", id: "operator-1" } };
    await expect(service.updateOrganization(operator, { timeZone: "Europe/Paris" }, "recovery")).rejects.toThrow("reason");
    await service.updateOrganization({ ...operator, reason: "Customer locked out after invalid legacy zone" }, { timeZone: "Europe/Paris" }, "recovery");
    expect(repository.mutations[0]!.audit).toMatchObject({ name: "platform.organization_regional_settings.recovered", reason: "Customer locked out after invalid legacy zone" });
  });

  it("changing the default currency leaves existing monetary values in their own currency", async () => {
    const invoice = money(125000, "USD");
    await new RegionalService(configured(), new InMemoryRegionalRepository()).updateOrganization(context, { currency: "EUR" });
    expect(invoice).toEqual({ amountMinor: "125000", currency: "USD" });
  });
});

describe("user regional preferences", () => {
  it("resolves user → organization → application and keeps the organization default visible", async () => {
    const repository = new InMemoryRegionalRepository();
    repository.organization = { language: null, locale: "en-US", timeZone: "America/Los_Angeles", currency: "USD" };
    const service = new RegionalService(configured(), repository);
    const { settings } = await service.updateUser(context, "user-1", { timeZone: "America/New_York" });
    expect(settings.effective).toMatchObject({ timeZone: { value: "America/New_York", source: "user" }, locale: { value: "en-US", source: "organization" }, language: { value: "en", source: "application" } });
    expect(settings.organization.timeZone).toEqual({ value: "America/Los_Angeles", source: "organization" });
    expect(repository.mutations[0]!.audit).toMatchObject({ name: "user.regional_preferences.updated", targetId: "user-1", summary: { timeZone: { from: null, to: "America/New_York" } } });
  });

  it("returns to the organization default when a preference is cleared, and never accepts currency", async () => {
    const repository = new InMemoryRegionalRepository();
    repository.users.set("user-1", { language: null, locale: null, timeZone: "Asia/Tokyo" });
    const service = new RegionalService(configured(), repository);
    expect((await service.updateUser(context, "user-1", { timeZone: null })).settings.effective.timeZone.source).toBe("application");
    await expect(service.updateUser(context, "user-1", { currency: "EUR" })).rejects.toThrow("cannot be set here");
  });
});

describe("schedule impact", () => {
  const schedules = defineSchedules([
    { key: "operations.digest", name: "Daily operations digest", time: "09:00", zone: { kind: "organization" } },
    { key: "billing.summary", name: "Weekly billing summary", time: "08:00", weekdays: [1], zone: { kind: "organization" } },
    { key: "report.new_york", name: "Monthly New York report", time: "09:00", zone: { kind: "zoned", timeZone: "America/New_York" } },
  ]);

  it("lists organization-relative schedules and proves zoned schedules do not move", async () => {
    const repository = new InMemoryRegionalRepository();
    repository.organization = { language: null, locale: null, timeZone: "America/Los_Angeles", currency: null };
    const report = await new RegionalService(configured(), repository, schedules).scheduleImpact("Europe/Paris", now);
    expect(report.organizationRelative.map((item) => item.key)).toEqual(["operations.digest", "billing.summary"]);
    expect(report.organizationRelative[0]).toMatchObject({ current: "2026-09-22T16:00:00.000Z", proposed: "2026-09-23T07:00:00.000Z" });
    expect(report.zoned).toEqual([expect.objectContaining({ key: "report.new_york", current: "2026-09-22T13:00:00.000Z", proposed: "2026-09-22T13:00:00.000Z" })]);
  });
});
