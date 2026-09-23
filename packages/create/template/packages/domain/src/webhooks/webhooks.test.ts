import { describe, expect, it } from "vitest";

import { afterAttempt, assertTransition, endpointHealth, failureCategory, maxAttempts, replayProblem, sanitizeEndpointUrl, validateEndpointUrl } from "./model.js";
import { generateSigningSecret, secretCipher, secretFingerprint, signPayload, verifySignature } from "./signing.js";

describe("webhook endpoint rules", () => {
  it("accepts public HTTPS URLs and localhost only in local development", () => {
    expect(validateEndpointUrl("https://hooks.example.com/in", "production").host).toBe("hooks.example.com");
    expect(validateEndpointUrl("http://localhost:8787/api/dev/webhook-receiver", "local").port).toBe("8787");
    for (const [url, environment] of [["http://hooks.example.com", "production"], ["http://localhost:8787", "staging"], ["https://10.0.0.5/x", "production"], ["https://user:pw@example.com", "production"], ["https://example.com/#frag", "production"], ["not a url", "local"]] as const) {
      expect(() => validateEndpointUrl(url, environment), url).toThrow();
    }
  });

  it("shows operators the origin and path but never the query string", () => {
    expect(sanitizeEndpointUrl(new URL("https://example.com/in?token=secret"))).toBe("https://example.com/in?…");
    expect(sanitizeEndpointUrl(new URL("https://example.com/in"))).toBe("https://example.com/in");
  });

  it("allows only defined state transitions", () => {
    expect(() => assertTransition("active", "paused")).not.toThrow();
    expect(() => assertTransition("disabled", "active")).not.toThrow();
    expect(() => assertTransition("disabled", "paused")).toThrow();
    expect(() => assertTransition("active", "active")).toThrow();
  });

  it("classifies attempts without response bodies and schedules bounded retries", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(failureCategory(204)).toBeNull();
    expect(failureCategory(503)).toBe("endpoint_error");
    expect(failureCategory(410)).toBe("endpoint_gone");
    expect(failureCategory(null, Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(afterAttempt(1, { responseCode: 500, failureCategory: "endpoint_error", durationMs: 5 }, now)).toEqual({ status: "pending", nextAttemptAt: new Date("2026-01-01T00:00:30Z") });
    expect(afterAttempt(maxAttempts, { responseCode: 500, failureCategory: "endpoint_error", durationMs: 5 }, now).status).toBe("failed");
    expect(afterAttempt(1, { responseCode: 410, failureCategory: "endpoint_gone", durationMs: 5 }, now).status).toBe("failed");
  });

  it("reports health and replay eligibility", () => {
    expect(endpointHealth({ consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null })).toBe("untested");
    expect(endpointHealth({ consecutiveFailures: 5, lastSuccessAt: new Date(), lastFailureAt: new Date() })).toBe("failing");
    expect(replayProblem({ status: "failed", test: false }, "active")).toBeNull();
    expect(replayProblem({ status: "pending", test: false }, "active")).toMatch(/completed/u);
    expect(replayProblem({ status: "failed", test: true }, "active")).toMatch(/Test/u);
    expect(replayProblem({ status: "failed", test: false }, "paused")).toMatch(/paused/u);
  });
});

describe("webhook signing", () => {
  it("signs with Standard Webhooks HMAC and verifies with any active secret", async () => {
    const current = generateSigningSecret();
    const previous = generateSigningSecret();
    const header = await signPayload([current, previous], "evt_1", 1_700_000_000, "{\"a\":1}");
    expect(header.split(" ")).toHaveLength(2);
    expect(await verifySignature(current, "evt_1", 1_700_000_000, "{\"a\":1}", header)).toBe(true);
    expect(await verifySignature(previous, "evt_1", 1_700_000_000, "{\"a\":1}", header)).toBe(true);
    expect(await verifySignature(current, "evt_1", 1_700_000_000, "{\"a\":2}", header)).toBe(false);
    expect(await secretFingerprint(current)).toMatch(/^[0-9a-f]{8}$/u);
  });

  it("stores secrets encrypted and refuses weak key material", async () => {
    const cipher = await secretCipher("k".repeat(40));
    const secret = generateSigningSecret();
    const ciphertext = await cipher.encrypt(secret);
    expect(ciphertext).not.toContain(secret.slice(6));
    expect(await cipher.decrypt(ciphertext)).toBe(secret);
    await expect((await secretCipher("x".repeat(40))).decrypt(ciphertext)).rejects.toThrow();
    await expect(secretCipher("short")).rejects.toThrow(/32/u);
  });
});
