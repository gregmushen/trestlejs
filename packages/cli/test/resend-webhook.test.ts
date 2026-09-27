import { describe, expect, it, vi } from "vitest";

import { configureResendWebhook, inspectResendWebhook, RESEND_DELIVERY_EVENTS } from "../src/resend-webhook.js";

const url = "https://example.test/api/webhooks/resend";
const oldId = "11111111-1111-4111-8111-111111111111";
const newId = "22222222-2222-4222-8222-222222222222";
const old = { id: oldId, endpoint: url, status: "enabled", events: [...RESEND_DELIVERY_EVENTS] };
const created = { id: newId, endpoint: url, status: "enabled", events: [...RESEND_DELIVERY_EVENTS], signing_secret: "whsec_newsecret" };
const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));

describe("Resend webhook setup", () => {
  it("reviews an absent webhook without creating resources or revealing a secret", async () => {
    const request = vi.fn(async () => list([])) as unknown as typeof fetch;
    const report = await configureResendWebhook({ environment: "preview", url, apiKey: "re_management", apply: false, request });
    expect(report).toMatchObject({ classification: "create", enabledWebhookIds: [] });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain("whsec_");
  });

  it("creates the webhook with delivery events and stores the retrieved secret", async () => {
    const order: string[] = [];
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (pathname === "/webhooks" && init?.method === "POST") {
        order.push("create");
        expect(JSON.parse(String(init.body))).toEqual({ endpoint: url, events: [...RESEND_DELIVERY_EVENTS] });
        return new Response(JSON.stringify({ object: "webhook", id: newId, signing_secret: created.signing_secret }));
      }
      if (pathname === `/webhooks/${newId}`) { order.push("retrieve"); return new Response(JSON.stringify(created)); }
      return list([]);
    }) as unknown as typeof fetch;
    const report = await configureResendWebhook({ environment: "staging", url, apiKey: "re_management", apply: true,
      persistSecret: async (secret) => { expect(secret).toBe("whsec_newsecret"); order.push("persist"); }, request });
    expect(order).toEqual(["create", "retrieve", "persist"]);
    expect(report).toMatchObject({ classification: "create", createdWebhookId: newId });
    expect(JSON.stringify(report)).not.toContain("whsec_newsecret");
  });

  it("requires an explicit old webhook ID before replacing an existing destination", async () => {
    const request = vi.fn(async () => list([old])) as unknown as typeof fetch;
    expect(await configureResendWebhook({ environment: "staging", url, apiKey: "re_management", apply: false, request }))
      .toMatchObject({ classification: "needs_rotation", enabledWebhookIds: [oldId] });
    await expect(configureResendWebhook({ environment: "staging", url, apiKey: "re_management", apply: true,
      persistSecret: async () => undefined, request })).rejects.toThrow("--replace-webhook-id");
  });

  it("stores the new secret before disabling only the named old webhook", async () => {
    const order: string[] = [];
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (pathname === "/webhooks" && init?.method === "POST") { order.push("create"); return new Response(JSON.stringify({ id: newId, signing_secret: created.signing_secret })); }
      if (pathname === `/webhooks/${newId}`) return new Response(JSON.stringify(created));
      if (pathname === `/webhooks/${oldId}` && init?.method === "PATCH") {
        order.push("disable");
        expect(JSON.parse(String(init.body))).toEqual({ status: "disabled" });
        return new Response(JSON.stringify({ object: "webhook", id: oldId }));
      }
      return list([old]);
    }) as unknown as typeof fetch;
    const report = await configureResendWebhook({ environment: "staging", url, apiKey: "re_management", apply: true,
      replaceWebhookId: oldId, persistSecret: async () => { order.push("persist"); }, request });
    expect(order).toEqual(["create", "persist", "disable"]);
    expect(report).toMatchObject({ classification: "rotate", createdWebhookId: newId, disabledWebhookId: oldId });
  });

  it("resumes after failed secret storage by adopting the created webhook instead of creating another", async () => {
    let listed: unknown[] = [old];
    const creates = vi.fn();
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (pathname === "/webhooks" && init?.method === "POST") { creates(); listed = [old, created]; return new Response(JSON.stringify({ id: newId, signing_secret: created.signing_secret })); }
      if (pathname === `/webhooks/${newId}`) return new Response(JSON.stringify(created));
      if (pathname === `/webhooks/${oldId}` && init?.method === "PATCH") return new Response(JSON.stringify({ id: oldId }));
      return list(listed);
    }) as unknown as typeof fetch;
    const input = { environment: "preview" as const, url, apiKey: "re_management", apply: true, replaceWebhookId: oldId, request };
    await expect(configureResendWebhook({ ...input, persistSecret: async () => { throw new Error("disk error"); } })).rejects.toThrow("--resume");
    const persisted: string[] = [];
    const report = await configureResendWebhook({ ...input, resume: true, persistSecret: async (secret) => { persisted.push(secret); } });
    expect(creates).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual(["whsec_newsecret"]);
    expect(report).toMatchObject({ createdWebhookId: newId, disabledWebhookId: oldId });
  });

  it("does not store a secret from a mismatched provider webhook", async () => {
    const persistSecret = vi.fn(async () => undefined);
    const request = vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(target)).pathname;
      if (init?.method === "POST") return new Response(JSON.stringify({ id: newId, signing_secret: created.signing_secret }));
      if (pathname === `/webhooks/${newId}`) return new Response(JSON.stringify({ ...created, endpoint: "https://other.test/api/webhooks/resend" }));
      return list([]);
    }) as unknown as typeof fetch;
    await expect(configureResendWebhook({ environment: "preview", url, apiKey: "re_management", apply: true, persistSecret, request })).rejects.toThrow("target URL");
    expect(persistSecret).not.toHaveBeenCalled();
  });

  it("rejects unsafe URLs, keys, and ambiguous destinations before mutation", async () => {
    const request = vi.fn(async () => list([old, { ...old, id: newId }])) as unknown as typeof fetch;
    await expect(configureResendWebhook({ environment: "preview", url, apiKey: "sk_test_wrong", apply: false, request })).rejects.toThrow("re_");
    await expect(configureResendWebhook({ environment: "preview", url: "http://localhost:8787/api/webhooks/resend", apiKey: "re_key", apply: false, request })).rejects.toThrow("HTTPS");
    await expect(configureResendWebhook({ environment: "preview", url, apiKey: "re_key", apply: true, request })).rejects.toThrow("persistence");
    expect((await configureResendWebhook({ environment: "preview", url, apiKey: "re_key", apply: false, request })).classification).toBe("blocked");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("checks every page and never includes provider error bodies", async () => {
    const request = vi.fn(async (target: string | URL | Request) => new Response(JSON.stringify(new URL(String(target)).searchParams.has("after")
      ? { data: [old], has_more: false } : { data: [{ ...old, id: newId, endpoint: "https://other.test/api/webhooks/resend" }], has_more: true }))) as unknown as typeof fetch;
    expect((await configureResendWebhook({ environment: "preview", url, apiKey: "re_key", apply: false, request })).classification).toBe("needs_rotation");
    const denied = vi.fn(async () => new Response("private provider payload", { status: 403 })) as unknown as typeof fetch;
    await expect(configureResendWebhook({ environment: "staging", url, apiKey: "re_verysecret", apply: false, request: denied })).rejects.toThrow("Resend webhook API returned HTTP 403");
  });

  it("reports whether the remote webhook matches the stored secret without returning it", async () => {
    const request = vi.fn(async (target: string | URL | Request) => new URL(String(target)).pathname === `/webhooks/${newId}`
      ? new Response(JSON.stringify(created)) : list([created])) as unknown as typeof fetch;
    expect(await inspectResendWebhook("re_key", url, "whsec_newsecret", request)).toEqual({ url, found: true, enabled: true, eventsMatch: true, secretMatches: true });
    const status = await inspectResendWebhook("re_key", url, "whsec_stale", request);
    expect(status.secretMatches).toBe(false);
    expect(JSON.stringify(status)).not.toContain("whsec_");
  });
});
