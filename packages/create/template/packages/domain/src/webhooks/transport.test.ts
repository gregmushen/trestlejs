import { describe, expect, it } from "vitest";

import { verifySignature } from "./signing.js";
import { NativeWebhookTransport, type TransportRequest } from "./transport.js";

const request: TransportRequest = {
  organizationId: "org_1", deliveryId: "delivery_1", eventId: "evt_1", eventName: "project.created",
  endpoint: { id: "endpoint_1", url: "https://example.com/hooks", events: ["project.created"] },
  secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], body: "{\"type\":\"project.created\"}", payload: { type: "project.created" }, timestamp: 1_790_000_000, timeoutMs: 1_000,
};

describe("native webhook transport", () => {
  it("posts a Standard Webhooks signed body without following redirects", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const transport = new NativeWebhookTransport(async (url, init) => { seen = { url, init }; return { status: 204 }; });
    expect(await transport.send(request)).toEqual({ responseCode: 204 });
    const headers = seen!.init.headers as Record<string, string>;
    expect(seen!.init.redirect).toBe("manual");
    expect(headers["webhook-id"]).toBe("evt_1");
    expect(await verifySignature(request.secrets[0]!, headers["webhook-id"]!, Number(headers["webhook-timestamp"]), request.body, headers["webhook-signature"]!)).toBe(true);
  });

  it("reports a network failure as no response instead of throwing", async () => {
    const failure = new TypeError("fetch failed");
    const transport = new NativeWebhookTransport(async () => { throw failure; });
    expect(await transport.send(request)).toEqual({ responseCode: null, error: failure });
  });
});
