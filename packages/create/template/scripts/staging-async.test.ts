import { describe, expect, it } from "vitest";

import { waitForStagingAsyncEvent } from "./staging-async.js";

describe("staging async event gate", () => {
  it("waits for both Queue dispatch and consumer completion", async () => {
    const states = [
      null,
      { eventId: "event-1", outboxStatus: "pending", inboxStatus: null },
      { eventId: "event-1", outboxStatus: "succeeded", inboxStatus: null },
      { eventId: "event-1", outboxStatus: "succeeded", inboxStatus: "completed" },
    ];
    let clock = 0;
    let reads = 0;
    expect(await waitForStagingAsyncEvent(async () => states[reads++] ?? null, {
      timeoutMs: 100, pollMs: 10, now: () => clock, pause: async (ms) => { clock += ms; },
    })).toEqual(states[3]);
    expect(reads).toBe(4);
  });

  it("fails closed on dead-letter and on a missing consumer receipt", async () => {
    await expect(waitForStagingAsyncEvent(async () => ({ eventId: "event-1", outboxStatus: "dead", inboxStatus: null })))
      .rejects.toThrow("dead-letter");
    let clock = 0;
    await expect(waitForStagingAsyncEvent(async () => ({ eventId: "event-1", outboxStatus: "succeeded", inboxStatus: null }), {
      timeoutMs: 20, pollMs: 10, now: () => clock, pause: async (ms) => { clock += ms; },
    })).rejects.toThrow("did not complete");
    expect(clock).toBe(20);
  });

  it("rejects invalid polling settings", async () => {
    await expect(waitForStagingAsyncEvent(async () => null, { pollMs: 0 })).rejects.toThrow("Invalid staging async polling interval");
    await expect(waitForStagingAsyncEvent(async () => null, { timeoutMs: -1 })).rejects.toThrow("Invalid staging async polling interval");
  });
});
