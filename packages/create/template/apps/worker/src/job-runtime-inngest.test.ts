import { describe, expect, it } from "vitest";

import { inngestRuntime, sendCommittedEventToInngest } from "./job-runtime-inngest.js";
import type { WorkerEnvironment } from "./worker-environment.js";

describe("Inngest job runtime", () => {
  it("sends only the event ID under a generation-keyed Inngest event ID", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => { requests.push({ url, init }); return new Response(JSON.stringify({ ids: ["01ABC"], status: 200 }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    expect(await sendCommittedEventToInngest({ environment: { INNGEST_EVENT_KEY: "evt key", INNGEST_BASE_URL: "https://inngest.example/" }, eventId: "00000000-0000-4000-8000-000000000001", generation: 1, fetch })).toEqual(["01ABC"]);
    expect(requests[0]!.url).toBe("https://inngest.example/e/evt%20key");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual([{ name: "trestle/event.committed", id: "trestle-event:00000000-0000-4000-8000-000000000001:1", data: { eventId: "00000000-0000-4000-8000-000000000001" } }]);
  });

  it("uses hosted Inngest by default and needs an event key outside the Dev Server", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => { urls.push(url); return new Response("{}", { status: 200 }); }) as unknown as typeof globalThis.fetch;
    await sendCommittedEventToInngest({ environment: { INNGEST_EVENT_KEY: "k" }, eventId: "e", fetch });
    expect(urls).toEqual(["https://inn.gs/e/k"]);
    await expect(sendCommittedEventToInngest({ environment: {}, eventId: "e", fetch })).rejects.toThrow("INNGEST_EVENT_KEY is not set");
    await expect(sendCommittedEventToInngest({ environment: { INNGEST_EVENT_KEY: "k" }, eventId: "e", fetch: (async () => new Response("secret body", { status: 401 })) as unknown as typeof globalThis.fetch })).rejects.toThrow(/^Inngest did not accept the event \(HTTP 401\)$/u);
  });

  it("describes configuration without secrets", () => {
    const base = { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "x".repeat(32) } as WorkerEnvironment;
    expect(inngestRuntime.publisher(base)).toBeUndefined();
    expect(inngestRuntime.describe({ ...base, INNGEST_EVENT_KEY: "k" } as WorkerEnvironment).detail).toContain("INNGEST_SIGNING_KEY missing");
    expect(inngestRuntime.describe({ ...base, INNGEST_DEV: "1", INNGEST_BASE_URL: "http://127.0.0.1:8288" } as WorkerEnvironment)).toEqual({ configured: true, detail: "the Inngest Dev Server at http://127.0.0.1:8288" });
  });
});
