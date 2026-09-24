import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger, loggerSecretsFromEnvironment } from "@__TRESTLE_PROJECT_NAME__/context";
import { parseNativeWebhookWakeup } from "@__TRESTLE_PROJECT_NAME__/db";
import { safeErrorCategory, type OutboxEntry, type QueueBatchMessage } from "@__TRESTLE_PROJECT_NAME__/events";

import { runNativeWebhookWakeup, type NativeWebhookRunResult } from "./webhook-native-runtime.js";

export function looksLikeNativeWebhookWakeup(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && ("sourceEventId" in body || "deliveryId" in body));
}

/** Queue transports IDs, not tenant authority. Invalid or failed wake-ups
 * retry to the configured DLQ; successful/irrelevant duplicates acknowledge. */
export async function consumeNativeWebhookQueueMessages(input: {
  messages: QueueBatchMessage[];
  environment: AuthEnvironment;
  outbox: { findCommitted(id: string): Promise<OutboxEntry | null> };
  run?: typeof runNativeWebhookWakeup;
}): Promise<{ acknowledged: number; retried: number }> {
  let acknowledged = 0;
  let retried = 0;
  for (const item of input.messages) {
    try {
      const wakeup = parseNativeWebhookWakeup(item.body);
      const result: NativeWebhookRunResult = await (input.run ?? runNativeWebhookWakeup)({ wakeup, environment: input.environment, outbox: input.outbox });
      if (result.state === "retry") { item.retry({ delaySeconds: result.delaySeconds }); retried++; }
      else { item.ack(); acknowledged++; }
    } catch (error) {
      createLogger({ environment: input.environment.APP_ENV ?? "local" }, undefined, { secretValues: loggerSecretsFromEnvironment(input.environment) }).warn("webhook.native.wakeup.retrying", { errorCategory: safeErrorCategory(error) });
      item.retry({ delaySeconds: 30 });
      retried++;
    }
  }
  return { acknowledged, retried };
}
