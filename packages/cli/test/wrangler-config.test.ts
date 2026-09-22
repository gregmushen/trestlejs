import { describe, expect, it } from "vitest";
import { wranglerEnvironmentBlock, wranglerStringVariable } from "../src/wrangler-config.js";

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
});
