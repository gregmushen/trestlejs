import { describe, expect, it } from "vitest";

import { parseStagingProviderVariables, readStagingProviderVariables } from "./provider-staging-config.js";

describe("staging provider configuration", () => {
  it("reads the canonical staging Worker variables", async () => {
    const variables = await readStagingProviderVariables();
    expect(variables.APP_ENV).toBe("staging");
    expect(variables.EMAIL_DELIVERY_MODE).toBe("resend");
    expect(variables.STRIPE_MODE).toBe("test");
  });

  it("rejects absent and non-string staging variables", () => {
    expect(() => parseStagingProviderVariables("{}"))
      .toThrow("Staging Worker variables are missing or invalid");
    expect(() => parseStagingProviderVariables('{"env":{"staging":{"vars":{"STRIPE_MODE":42}}}}'))
      .toThrow("Staging Worker variables are missing or invalid");
  });

  it("does not accidentally use preview or production variables", () => {
    const source = JSON.stringify({ env: {
      preview: { vars: { STRIPE_MODE: "preview" } },
      staging: { vars: { STRIPE_MODE: "test" } },
      production: { vars: { STRIPE_MODE: "live" } },
    } });
    expect(parseStagingProviderVariables(source).STRIPE_MODE).toBe("test");
  });
});
