import { applicationEvents } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";

import { notifications } from "./definitions.js";
import { defineNotifications, resolvePreference } from "./model.js";

const definition = notifications.get("webhooks.endpoint_failing")!;

describe("notification definitions", () => {
  it("resolves mandatory, user, organization, and default preferences in that order", () => {
    expect(resolvePreference(definition, "in_app", { user: false })).toEqual({ enabled: true, source: "mandatory", mandatory: true });
    expect(resolvePreference(definition, "email", { user: false, organization: true })).toEqual({ enabled: false, source: "user", mandatory: false });
    expect(resolvePreference(definition, "email", { organization: false })).toEqual({ enabled: false, source: "organization", mandatory: false });
    expect(resolvePreference(definition, "email", {})).toEqual({ enabled: true, source: "default", mandatory: false });
  });

  it("rejects unsupported channels, mandatory channels that do not exist, and unregistered triggers", () => {
    const render = () => ({ title: "t", body: "b" });
    expect(() => defineNotifications(applicationEvents, { "a.b": { name: "x", description: "x", channels: {}, render } })).toThrow(/at least one channel/u);
    expect(() => defineNotifications(applicationEvents, { "a.b": { name: "x", description: "x", channels: { in_app: { default: true } }, mandatory: ["email"], render } })).toThrow(/unsupported channel/u);
    expect(() => defineNotifications(applicationEvents, { "a.b": { name: "x", description: "x", channels: { in_app: { default: true } }, trigger: { event: "nope.event", recipients: {} }, render } })).toThrow(/unregistered event/u);
  });

  it("connects every shipped definition to a registered event", () => {
    for (const entry of notifications.list()) expect(applicationEvents.has(entry.trigger!.event), entry.type).toBe(true);
  });
});
