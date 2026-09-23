import { describe, expect, it } from "vitest";

import { runWebhookRetentionMaintenance } from "./webhook-retention.js";

describe("webhook payload maintenance", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  it("uses bounded class policies and continues after one tenant fails", async () => {
    const visited: string[] = [];
    const result = await runWebhookRetentionMaintenance(async () => ["org-a", "org-b", "org-c"], async (organizationId, cutoffs) => {
      visited.push(organizationId);
      expect(cutoffs.standard.toISOString()).toBe("2026-08-24T12:00:00.000Z");
      expect(cutoffs.short.toISOString()).toBe("2026-09-16T12:00:00.000Z");
      if (organizationId === "org-b") throw new Error("Database unavailable");
      return { redacted: 2, skippedActiveLeases: 1, stoppedDeliveries: 1, clearedAttempts: 1 };
    }, now);
    expect(visited).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, redacted: 4, skippedActiveLeases: 2, stoppedDeliveries: 2, clearedAttempts: 2, failed: 1 });
  });

  it("rejects an invalid clock before scanning organizations", async () => {
    await expect(runWebhookRetentionMaintenance(async () => { throw new Error("should not scan"); }, async () => ({ redacted: 0, skippedActiveLeases: 0, stoppedDeliveries: 0, clearedAttempts: 0 }), new Date(NaN))).rejects.toThrow("Invalid webhook retention clock");
  });
});
