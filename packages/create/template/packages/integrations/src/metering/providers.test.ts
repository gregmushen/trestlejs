import { describe, expect, it } from "vitest";

import { LagoMeteringProvider } from "./lago.js";
import { OpenMeterProvider } from "./openmeter.js";
import { MeteringProviderError } from "./types.js";

type Call = { url: string; init: RequestInit };
function stub(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  return { calls, fetcher: async (url: string, init: RequestInit) => { calls.push({ url, init }); return handler({ url, init }); } };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const event = { id: "usage:org_1:api.requests:2026-09-01T00:00:00.000Z:0-7", organizationId: "org_1", featureCode: "api.requests", quantity: 7, occurredAt: new Date("2026-09-01T00:00:00Z") };
const query = { organizationId: "org_1", featureCode: "api.requests", start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") };
const now = new Date("2026-09-22T12:00:00Z");

describe("OpenMeter adapter", () => {
  it("ingests mapped usage as CloudEvents with the organization as subject", async () => {
    const { calls, fetcher } = stub(() => new Response(null, { status: 204 }));
    const provider = new OpenMeterProvider({ apiKey: "om_key", fetcher, mappings: [{ featureCode: "api.requests", meter: "api_requests", eventType: "trestle.api_request" }] });
    await provider.ingest([event, { ...event, id: "other", featureCode: "unmapped" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openmeter.cloud/api/v1/events");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/cloudevents-batch+json");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual([{ specversion: "1.0", id: event.id, source: "trestle", type: "trestle.api_request", subject: "org_1", time: "2026-09-01T00:00:00.000Z", data: { quantity: 7 } }]);
  });

  it("reads the period's usage and entitlement balance for reconciliation", async () => {
    const { calls, fetcher } = stub(({ url }) => url.includes("/entitlements/") ? json({ hasAccess: false, balance: 0, usage: 12 }) : json({ data: [{ value: 5, subject: "org_1" }, { value: 7, subject: "org_1" }] }));
    const provider = new OpenMeterProvider({ apiKey: "om_key", baseUrl: "https://om.example/", fetcher, mappings: [{ featureCode: "api.requests", meter: "api_requests", entitlementFeature: "api" }] });
    expect(await provider.usage(query, now)).toEqual({ provider: "openmeter", organizationId: "org_1", featureCode: "api.requests", periodStart: query.start, periodEnd: query.end, quantity: 12, balance: 0, hasAccess: false, observedAt: now });
    expect(new URL(calls[0]!.url).searchParams.get("subject")).toBe("org_1");
    expect(await provider.usage({ ...query, featureCode: "unmapped" }, now)).toBeNull();
  });

  it("classifies failures as retryable or not, without response bodies", async () => {
    const provider = (status: number) => new OpenMeterProvider({ apiKey: "k", fetcher: stub(() => json({ detail: "secret" }, status)).fetcher, mappings: [{ featureCode: "api.requests", meter: "m" }] });
    const failed = await provider(503).ingest([event]).catch((error: unknown) => error) as MeteringProviderError;
    expect(failed).toMatchObject({ retryable: true, status: 503 });
    expect(failed.message).not.toContain("secret");
    expect(await provider(400).ingest([event]).catch((error: unknown) => error)).toMatchObject({ retryable: false });
  });
});

describe("Lago metering adapter", () => {
  it("sends batch events keyed by the organization's subscription and metric code", async () => {
    const { calls, fetcher } = stub(() => json({ events: [] }));
    await new LagoMeteringProvider({ apiKey: "lago_key", fetcher, mappings: [{ featureCode: "api.requests", meter: "api_requests" }] }).ingest([event]);
    expect(calls[0]!.url).toBe("https://api.getlago.com/api/v1/events/batch");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ events: [{ transaction_id: event.id, external_subscription_id: "org_1", code: "api_requests", timestamp: 1_788_220_800, properties: { quantity: 7 } }] });
  });

  it("reads current usage units for the mapped metric, and no subscription as zero", async () => {
    const { fetcher } = stub(({ url }) => url.includes("org_1") ? json({ customer_usage: { charges_usage: [{ units: "9.0", billable_metric: { code: "api_requests" } }, { units: "3", billable_metric: { code: "storage" } }] } }) : json({ error: "not found" }, 404));
    const provider = new LagoMeteringProvider({ apiKey: "lago_key", fetcher, mappings: [{ featureCode: "api.requests", meter: "api_requests" }] });
    expect((await provider.usage(query, now))?.quantity).toBe(9);
    expect((await provider.usage({ ...query, organizationId: "org_2" }, now))?.quantity).toBe(0);
  });
});
