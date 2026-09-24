import { describe, expect, it } from "vitest";

import { authErrorMessage, confirmStepUpIdentity, stepUpMethods, stepUpRequirement } from "./step-up";
import { beginStepUp, setSignInNotice, signInNotice, stepUpInProgress } from "./step-up-state";

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

  it("never continues as a different account after a step-up", async () => {
    let signedOut = 0;
    const as = (id: string | null) => ({ currentUserId: async () => id, signOut: async () => { signedOut += 1; } });
    expect(await confirmStepUpIdentity("op-1", "passkey", as("op-1"))).toEqual({ ok: true });
    expect(signedOut).toBe(0);
    const other = await confirmStepUpIdentity("op-1", "passkey", as("op-2"));
    expect(other.ok).toBe(false);
    expect(!other.ok && other.error).toMatch(/passkey belongs to a different account/u);
    expect(signedOut).toBe(1);
    // No session after the step-up also fails closed.
    expect((await confirmStepUpIdentity("op-1", "password", as(null))).ok).toBe(false);
    expect((await confirmStepUpIdentity("op-1", "password", { currentUserId: async () => { throw new Error("offline"); }, signOut: async () => undefined })).ok).toBe(false);
  });

  it("holds the shell while any step-up is in progress and ends each exactly once", () => {
    expect(stepUpInProgress()).toBe(false);
    const first = beginStepUp();
    const second = beginStepUp();
    first(); first();
    expect(stepUpInProgress()).toBe(true);
    second();
    expect(stepUpInProgress()).toBe(false);
    setSignInNotice("Verification cancelled. Sign in again to continue.");
    expect(signInNotice()).toMatch(/cancelled/u);
    setSignInNotice(null);
    expect(signInNotice()).toBeNull();
  });
});
