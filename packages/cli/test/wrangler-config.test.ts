import { describe, expect, it } from "vitest";
import { wranglerCapabilityBinding, wranglerEnvironmentBlock, wranglerStringVariable } from "../src/wrangler-config.js";

describe("Wrangler environment inspection", () => {
  const source = '{"vars":{"MODE":"local"},"env":{"staging":{"vars":{"EMAIL_FROM":"CHANGE_ME","MODE":"test"}},"production":{"vars":{"EMAIL_FROM":"sender@example.com","MODE":"live"}}}}';
  it("does not borrow values from a later environment", () => {
    const staging = wranglerEnvironmentBlock(source, "staging");
    expect(wranglerStringVariable(staging, "EMAIL_FROM")).toBe("CHANGE_ME");
    expect(staging).not.toContain("sender@example.com");
  });
  it("extracts local and production independently", () => {
    expect(wranglerStringVariable(wranglerEnvironmentBlock(source, "local"), "MODE")).toBe("local");
    expect(wranglerStringVariable(wranglerEnvironmentBlock(source, "production"), "MODE")).toBe("live");
  });

  it("decodes JSON-valued string variables without truncating escaped quotes", () => {
    const config = JSON.stringify({ env: { staging: { vars: { STRIPE_PRICES: JSON.stringify({ starter: "price_123", pro: "price_456" }) } } } });
    expect(wranglerStringVariable(wranglerEnvironmentBlock(config, "staging"), "STRIPE_PRICES"))
      .toBe('{"starter":"price_123","pro":"price_456"}');
  });

  it("recognizes only the configured binding in the selected environment", () => {
    const bindings = JSON.stringify({ env: {
      preview: { queues: { producers: [{ binding: "TRESTLE_EVENTS", queue: "events-preview" }], consumers: [{ queue: "events-preview", dead_letter_queue: "events-dlq-preview" }] }, r2_buckets: [{ binding: "TRESTLE_ARTIFACTS", bucket_name: "artifacts-preview" }], workflows: [{ binding: "TRESTLE_WORKFLOW", name: "workflow-preview", class_name: "TrestleWorkflow" }], durable_objects: { bindings: [{ name: "TRESTLE_STATE", class_name: "TrestleState" }] } },
      staging: { vars: { MODE: "test" } },
    } });
    const preview = wranglerEnvironmentBlock(bindings, "preview");
    for (const capability of ["queues", "r2", "workflows", "durableObjects"] as const) expect(wranglerCapabilityBinding(preview, capability)).toBe(true);
    const staging = wranglerEnvironmentBlock(bindings, "staging");
    for (const capability of ["queues", "r2", "workflows", "durableObjects"] as const) expect(wranglerCapabilityBinding(staging, capability)).toBe(false);
  });

  it("does not accept a Queue producer without a consumer", () => {
    expect(wranglerCapabilityBinding('{"queues":{"producers":[{"binding":"TRESTLE_EVENTS","queue":"events"}]}}', "queues")).toBe(false);
    expect(wranglerCapabilityBinding('{"queues":{"producers":[{"binding":"TRESTLE_EVENTS","queue":"events"}],"consumers":[]}}', "queues")).toBe(false);
    expect(wranglerCapabilityBinding('{"queues":{"producers":[{"binding":"TRESTLE_EVENTS","queue":"events"}],"consumers":[{"queue":"events"}]}}', "queues")).toBe(false);
  });
});
