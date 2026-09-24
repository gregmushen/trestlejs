import { describe, expect, it, vi } from "vitest";

import { configureStripeWebhook, STRIPE_BILLING_EVENTS } from "../src/stripe-webhook.js";

const url = "https://example.test/webhooks/stripe";
const old = { id: "we_old1", url, status: "enabled", livemode: false, enabled_events: [...STRIPE_BILLING_EVENTS] };
const created = { id: "we_new1", url, status: "enabled", livemode: false, enabled_events: [...STRIPE_BILLING_EVENTS], secret: "whsec_newsecret" };
const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }));

describe("Stripe webhook setup", () => {
  it("reviews an absent endpoint without creating resources or revealing a secret", async () => {
    const request = vi.fn(async () => list([])) as unknown as typeof fetch;
    const report = await configureStripeWebhook({ environment: "preview", url, apiKey: "sk_test_management", apply: false, request });
    expect(report).toMatchObject({ classification: "create", enabledEndpointIds: [] });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain("whsec_");
  });

  it("requires an explicit old endpoint ID because Stripe does not return its existing signing secret", async () => {
    const request = vi.fn(async () => list([old])) as unknown as typeof fetch;
    const review = await configureStripeWebhook({ environment: "staging", url, apiKey: "sk_test_management", apply: false, request });
    expect(review).toMatchObject({ classification: "needs_rotation", enabledEndpointIds: ["we_old1"] });
    await expect(configureStripeWebhook({ environment: "staging", url, apiKey: "sk_test_management", apply: true,
      operationId: "operation123", persistSecret: async () => undefined, request })).rejects.toThrow("remote signing secret cannot be retrieved");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stores the returned secret before disabling only the named old endpoint", async () => {
    const order: string[] = [];
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (pathname === "/v1/webhook_endpoints" && init?.method === "POST") {
        order.push("create");
        expect(init.headers).toMatchObject({ "idempotency-key": expect.stringContaining("operation123") });
        expect(String(init.body)).toContain("checkout.session.completed");
        return new Response(JSON.stringify(created));
      }
      if (pathname === "/v1/webhook_endpoints/we_old1" && init?.method === "POST") {
        order.push("disable");
        expect(String(init.body)).toBe("disabled=true");
        return new Response(JSON.stringify({ ...old, status: "disabled" }));
      }
      return list([old]);
    }) as unknown as typeof fetch;
    const report = await configureStripeWebhook({ environment: "staging", url, apiKey: "sk_test_management", apply: true,
      operationId: "operation123", replaceEndpointId: old.id, persistSecret: async (secret) => {
        expect(secret).toBe("whsec_newsecret"); order.push("persist");
      }, request });
    expect(order).toEqual(["create", "persist", "disable"]);
    expect(report).toMatchObject({ classification: "rotate", createdEndpointId: "we_new1", disabledEndpointId: "we_old1" });
    expect(JSON.stringify(report)).not.toContain("whsec_newsecret");
  });

  it("preserves the old endpoint when encrypted storage fails and supports the same-operation retry", async () => {
    let listed = [old];
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (pathname === "/v1/webhook_endpoints" && init?.method === "POST") {
        listed = [old, created];
        return new Response(JSON.stringify(created));
      }
      if (pathname === "/v1/webhook_endpoints/we_old1" && init?.method === "POST") return new Response(JSON.stringify({ ...old, status: "disabled" }));
      return list(listed);
    }) as unknown as typeof fetch;
    const input = { environment: "preview" as const, url, apiKey: "sk_test_management", apply: true,
      operationId: "operation123", replaceEndpointId: old.id, request };
    await expect(configureStripeWebhook({ ...input, persistSecret: async () => { throw new Error("disk error"); } }))
      .rejects.toThrow("same --operation-id and --resume");
    expect(request).toHaveBeenCalledTimes(2);
    const report = await configureStripeWebhook({ ...input, resume: true, persistSecret: async () => undefined });
    expect(report.disabledEndpointId).toBe(old.id);
  });

  it("converges when the prior disable succeeded but its response was lost", async () => {
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (pathname === "/v1/webhook_endpoints" && init?.method === "POST") return new Response(JSON.stringify(created));
      if (pathname === "/v1/webhook_endpoints/we_old1" && init?.method === "POST") return new Response(JSON.stringify({ ...old, status: "disabled" }));
      return list([{ ...old, status: "disabled" }, created]);
    }) as unknown as typeof fetch;
    const report = await configureStripeWebhook({ environment: "staging", url, apiKey: "sk_test_management", apply: true,
      operationId: "operation123", replaceEndpointId: old.id, resume: true,
      persistSecret: async () => undefined, request });
    expect(report.createdEndpointId).toBe(created.id);
    expect(report.disabledEndpointId).toBe(old.id);
  });

  it("rejects unsafe URLs, key modes, ambiguous old endpoints, and missing retry IDs before mutation", async () => {
    const request = vi.fn(async () => list([old, { ...old, id: "we_other1" }])) as unknown as typeof fetch;
    await expect(configureStripeWebhook({ environment: "production", url, apiKey: "sk_test_wrong", apply: false, request })).rejects.toThrow("mode");
    await expect(configureStripeWebhook({ environment: "preview", url: "http://localhost:8787/webhooks/stripe", apiKey: "sk_test_key", apply: false, request })).rejects.toThrow("HTTPS");
    await expect(configureStripeWebhook({ environment: "preview", url, apiKey: "sk_test_key", apply: true,
      persistSecret: async () => undefined, request })).rejects.toThrow("operation-id");
    expect((await configureStripeWebhook({ environment: "preview", url, apiKey: "sk_test_key", apply: false, request })).classification).toBe("blocked");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("checks every page before deciding an endpoint is absent", async () => {
    const request = vi.fn(async (target: string | URL | Request) => {
      const query = new URL(String(target)).searchParams;
      return new Response(JSON.stringify(query.has("starting_after")
        ? { data: [old], has_more: false }
        : { data: [{ ...old, id: "we_other1", url: "https://other.test/webhooks/stripe" }], has_more: true }));
    }) as unknown as typeof fetch;
    expect((await configureStripeWebhook({ environment: "preview", url, apiKey: "sk_test_key", apply: false, request })).classification).toBe("needs_rotation");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not store a secret from a mismatched provider response", async () => {
    const persistSecret = vi.fn(async () => undefined);
    const request = vi.fn(async (_target: string | URL | Request, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ ...created, url: "https://other.test/webhooks/stripe" })) : list([])) as unknown as typeof fetch;
    await expect(configureStripeWebhook({ environment: "preview", url, apiKey: "sk_test_key", apply: true,
      operationId: "operation123", persistSecret, request })).rejects.toThrow("matching enabled endpoint");
    expect(persistSecret).not.toHaveBeenCalled();
  });

  it("does not include provider error bodies or the management key in errors", async () => {
    const request = vi.fn(async () => new Response("private provider payload", { status: 403 })) as unknown as typeof fetch;
    await expect(configureStripeWebhook({ environment: "staging", url, apiKey: "sk_test_verysecret", apply: false, request }))
      .rejects.toThrow("Stripe webhook API returned HTTP 403");
  });
});
