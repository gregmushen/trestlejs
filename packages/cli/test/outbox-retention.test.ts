import { describe, expect, it } from "vitest";

import { assertOutboxRetentionCutoff, formatOutboxRetentionSummary } from "../src/outbox-retention.js";

const now = new Date("2026-09-24T12:00:00.000Z");

describe("queue prune output", () => {
  it("reports the eligible count and the age of the oldest retained record on a dry run", () => {
    expect(formatOutboxRetentionSummary({ environment: "staging", before: "2026-08-01T00:00:00Z", limit: 1_000, apply: false, now },
      { count: 12, oldestRetainedAt: "2026-07-20T06:00:00.000Z" })).toBe([
      "Eligible 12 succeeded outbox record(s) in staging before 2026-08-01T00:00:00Z (dry run)",
      "Oldest retained succeeded record: 2026-07-20T06:00:00.000Z (66.3 days old)",
      "",
    ].join("\n"));
  });

  it("reports the pruned count, the limit, and an empty outbox", () => {
    expect(formatOutboxRetentionSummary({ environment: "production", before: "2026-08-01T00:00:00Z", limit: 500, apply: true, now },
      { count: 3, oldestRetainedAt: null })).toBe([
      "Pruned 3 succeeded outbox record(s) in production before 2026-08-01T00:00:00Z (limit 500)",
      "Oldest retained succeeded record: none",
      "",
    ].join("\n"));
  });

  it("refuses a cutoff inside the 30-day provenance window with the latest allowed cutoff", () => {
    expect(() => assertOutboxRetentionCutoff("2026-08-25T12:00:00.001Z", now)).toThrow("inside the 30-day provenance window; use a cutoff at or before 2026-08-25T12:00:00.000Z");
    expect(() => assertOutboxRetentionCutoff("2026-08-25T12:00:00.000Z", now)).not.toThrow();
  });
});
