import { describe, expect, it, vi } from "vitest";

import { consumeNativeWebhookQueueMessages, looksLikeNativeWebhookWakeup } from "./webhook-native-queue.js";
import { runNativeWebhookWakeup } from "./webhook-native-runtime.js";

const wakeup = { sourceEventId: "9ed47bd2-0d04-4cac-9570-9f9c5721a1d0", deliveryId: `whd_${"a".repeat(64)}` };

describe("native webhook Queue routing", () => {
  it("recognizes ID-only work without misclassifying ordinary events", () => {
    expect(looksLikeNativeWebhookWakeup(wakeup)).toBe(true);
    expect(looksLikeNativeWebhookWakeup({ deliveryId: wakeup.deliveryId })).toBe(true);
    expect(looksLikeNativeWebhookWakeup({ id: wakeup.sourceEventId, name: "article.published" })).toBe(false);
    expect(looksLikeNativeWebhookWakeup(null)).toBe(false);
  });

  it("acknowledges settled and duplicate work and delays provider retries", async () => {
    const actions: string[] = [];
    const message = (body: unknown) => ({ body, ack: () => actions.push("ack"), retry: ({ delaySeconds }: { delaySeconds?: number } = {}) => actions.push(`retry:${delaySeconds}`) });
    const run = vi.fn()
      .mockResolvedValueOnce({ state: "succeeded" })
      .mockResolvedValueOnce({ state: "ignored" })
      .mockResolvedValueOnce({ state: "retry", delaySeconds: 42 })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const result = await consumeNativeWebhookQueueMessages({
      messages: [message(wakeup), message(wakeup), message(wakeup), message(wakeup), message({ ...wakeup, organizationId: "forged" })],
      environment: { DATABASE_URL: "unused", BETTER_AUTH_SECRET: "unused", APP_ENV: "preview", WEBHOOK_DELIVERY_MODE: "native" },
      outbox: { findCommitted: async () => null }, run,
    });
    expect(result).toEqual({ acknowledged: 2, retried: 3 });
    expect(actions).toEqual(["ack", "ack", "retry:42", "retry:30", "retry:30"]);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[0]?.[0].wakeup).toEqual(wakeup);
  });

  it("refuses native work before any database or network access in local mode", async () => {
    const outbox = { findCommitted: vi.fn(async () => null) };
    await expect(runNativeWebhookWakeup({
      wakeup,
      environment: { DATABASE_URL: "unused", BETTER_AUTH_SECRET: "unused", APP_ENV: "local", WEBHOOK_DELIVERY_MODE: "native", WEBHOOK_SECRET_KEY: "a".repeat(32) },
      outbox,
    })).rejects.toThrow("remote native environment");
    expect(outbox.findCommitted).not.toHaveBeenCalled();
  });
});
