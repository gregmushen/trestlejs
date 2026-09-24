import { describe, expect, it } from "vitest";

import { authErrorMessage, confirmStepUpIdentity, stepUpMethods, stepUpRequirement } from "./step-up";

describe("step-up", () => {
  it("reads the required level from a Better Auth 428 and ignores other errors", () => {
    expect(stepUpRequirement({ status: 428, error: "step_up_required", required: "phishing_resistant", message: "x" })).toBe("phishing_resistant");
    expect(stepUpRequirement({ status: 428, required: "mfa" })).toBe("mfa");
    // An unknown or missing level asks for the strongest, so the UI never offers a weaker path.
    expect(stepUpRequirement({ status: 428, required: "retina" })).toBe("phishing_resistant");
    expect(stepUpRequirement({ status: 428 })).toBe("phishing_resistant");
    expect(stepUpRequirement({ status: 403, error: "forbidden", reason: "no_platform_roles" })).toBeNull();
    expect(stepUpRequirement(null)).toBeNull();
    expect(stepUpRequirement(undefined)).toBeNull();
  });

  it("offers only the re-authentication paths that can reach the required level", () => {
    // A passkey satisfies every level, so it is always offered.
    expect(stepUpMethods("phishing_resistant")).toEqual({ password: false, passkey: true });
    expect(stepUpMethods("mfa")).toEqual({ password: true, passkey: true });
    expect(stepUpMethods("password")).toEqual({ password: true, passkey: true });
    expect(stepUpMethods("password", { totp: true, passkeys: 0 })).toEqual({ password: true, passkey: true });
    expect(stepUpMethods("password", { totp: false, passkeys: 0 })).toEqual({ password: true, passkey: true });
  });

  it("hides the password path from a passkey-only account, whose password sign-in would fall below the minimum sign-in level", () => {
    expect(stepUpMethods("password", { totp: false, passkeys: 2 })).toEqual({ password: false, passkey: true });
    expect(stepUpMethods("mfa", { totp: false, passkeys: 1 })).toEqual({ password: false, passkey: true });
    // With TOTP the password path continues with a code, which keeps the session at mfa.
    expect(stepUpMethods("mfa", { totp: true, passkeys: 1 })).toEqual({ password: true, passkey: true });
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
    const unreadable = await confirmStepUpIdentity("op-1", "password", { currentUserId: async () => { throw new Error("offline"); }, signOut: async () => undefined });
    expect(!unreadable.ok && unreadable.error).toMatch(/Could not confirm which account/u);
    // A sign-out that fails says so, rather than claiming the account is gone.
    const stuck = await confirmStepUpIdentity("op-1", "passkey", { currentUserId: async () => "op-2", signOut: async () => { throw new Error("offline"); } });
    expect(stuck).toEqual({ ok: false, signedOut: false, error: "Could not sign that account out; close this browser tab." });
    // Every other refusal reports the session as gone, so the dialog can send the operator to sign-in.
    expect(other).toMatchObject({ ok: false, signedOut: true });
    expect(unreadable).toMatchObject({ ok: false, signedOut: true });
  });
});
