import { describe, expect, it } from "vitest";

import { authErrorMessage, stepUpMethods, stepUpRequirement } from "./step-up";

describe("step-up", () => {
  it("reads the required level from a Better Auth 428 and ignores other errors", () => {
    expect(stepUpRequirement({ status: 428, error: "step_up_required", required: "phishing_resistant", message: "x" })).toBe("phishing_resistant");
    expect(stepUpRequirement({ status: 428, required: "mfa" })).toBe("mfa");
    // An unknown or missing level still asks for step-up; the server re-checks after it.
    expect(stepUpRequirement({ status: 428, required: "retina" })).toBe("password");
    expect(stepUpRequirement({ status: 403, error: "forbidden", reason: "no_platform_roles" })).toBeNull();
    expect(stepUpRequirement(null)).toBeNull();
    expect(stepUpRequirement(undefined)).toBeNull();
  });

  it("offers only the re-authentication paths that can reach the required level", () => {
    expect(stepUpMethods("phishing_resistant")).toEqual({ password: false, passkey: true });
    expect(stepUpMethods("mfa")).toEqual({ password: true, passkey: true });
    expect(stepUpMethods("password")).toEqual({ password: true, passkey: false });
  });

  it("explains the Worker's operator-only refusals", () => {
    expect(authErrorMessage({ status: 403, reason: "no_platform_roles", message: "This account has no platform role" }, "failed")).toMatch(/no platform role/u);
    expect(authErrorMessage({ status: 403, reason: "local_account", message: "x" }, "failed")).toMatch(/local development/u);
    expect(authErrorMessage({ status: 400, message: "Invalid code" }, "failed")).toBe("Invalid code");
    expect(authErrorMessage({ status: 500 }, "Set up authenticator failed")).toBe("Set up authenticator failed");
  });
});
