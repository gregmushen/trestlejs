import { describe, expect, it } from "vitest";

import { triggerCommittedEvent, triggerRuntime } from "./job-runtime-trigger.js";
import type { WorkerEnvironment } from "./worker-environment.js";

describe("trigger.dev job runtime", () => {
  it("sends only the event ID, keyed by event and generation", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => { requests.push({ url, init }); return new Response(JSON.stringify({ id: "run_1", isCached: true }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    expect(await triggerCommittedEvent({ apiUrl: "https://jobs.example/", secretKey: "tr_dev_x", eventId: "00000000-0000-4000-8000-000000000001", generation: 2, fetch })).toEqual({ runId: "run_1", cached: true });
    expect(requests[0]!.url).toBe("https://jobs.example/api/v1/tasks/trestle-event/trigger");
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer tr_dev_x");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ payload: { eventId: "00000000-0000-4000-8000-000000000001" }, options: { idempotencyKey: "trestle-event:00000000-0000-4000-8000-000000000001:2", idempotencyKeyTTL: "30d" } });
  });

  it("reports a rejected trigger without the response body", async () => {
    const fetch = (async () => new Response("internal details", { status: 500 })) as unknown as typeof globalThis.fetch;
    await expect(triggerCommittedEvent({ apiUrl: "https://jobs.example", secretKey: "tr_dev_x", eventId: "e", fetch })).rejects.toThrow(/^trigger\.dev did not accept the event \(HTTP 500\)$/u);
  });

  it("dispatches only with a secret key", () => {
    const base = { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "x".repeat(32) } as WorkerEnvironment;
    expect(triggerRuntime.publisher(base)).toBeUndefined();
    expect(triggerRuntime.describe(base)).toMatchObject({ configured: false });
    expect(triggerRuntime.describe({ ...base, TRIGGER_SECRET_KEY: "tr_prod_x", TRIGGER_API_URL: "https://jobs.example" } as WorkerEnvironment)).toEqual({ configured: true, detail: "trigger.dev at https://jobs.example" });
  });
});
