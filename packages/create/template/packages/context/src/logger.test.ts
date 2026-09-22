import { describe, expect, it } from "vitest";

import { createLogger, createMetrics, type LogRecord } from "./index.js";

describe("semantic logger", () => {
  it("emits context and redacts sensitive values recursively", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ correlationId: "corr-1", authorization: "Bearer secret" }, (record) => records.push(record));
    log.info("resource.article.created", { organizationId: "org-1", nested: { resetToken: "token-value" } });
    expect(records[0]).toMatchObject({ level: "info", event: "resource.article.created", correlationId: "corr-1", authorization: "[REDACTED]", organizationId: "org-1", nested: { resetToken: "[REDACTED]" } });
  });

  it("emits provider-neutral counter and histogram records", () => {
    const records: LogRecord[] = [];
    const metrics = createMetrics(createLogger({ correlationId: "corr-2" }, (record) => records.push(record)));
    metrics.increment("billing.checkout.created", 1, { plan: "pro" });
    metrics.observe("http.request.duration_ms", 12, { status: "200" });
    expect(records).toEqual([expect.objectContaining({ event: "metric.counter", metric: "billing.checkout.created", value: 1 }), expect.objectContaining({ event: "metric.histogram", metric: "http.request.duration_ms", value: 12 })]);
  });
});
