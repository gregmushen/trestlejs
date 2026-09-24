import { describe, expect, it } from "vitest";

import { createLogger, createMetrics, loggerSecretsFromEnvironment, type LogRecord } from "./index.js";

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

  it("redacts registered secret values even inside safe-named strings and errors", () => {
    const records: LogRecord[] = [];
    const credential = "test-secret-value-123";
    const log = createLogger({}, (record) => records.push(record), { secretValues: [credential] });
    log.error("provider.failed", { message: `connection rejected ${credential}`, error: new Error(`failure: ${credential}`), url: `https://host.test/?key=${credential}` });
    expect(JSON.stringify(records)).not.toContain(credential);
    expect(records[0]).toMatchObject({ message: "connection rejected [REDACTED]", error: { message: "failure: [REDACTED]" } });
    expect(loggerSecretsFromEnvironment({ DATABASE_URL: credential, EMAIL_FROM: "safe", STRIPE_SECRET_KEY: "stripe-test" })).toEqual([credential, "stripe-test"]);
  });

  it("bounds circular, deep, wide, long, bigint and accessor values", () => {
    const records: LogRecord[] = [];
    const circular: Record<string, unknown> = { id: 123n, text: "x".repeat(20_000) };
    circular.self = circular;
    Object.defineProperty(circular, "danger", { enumerable: true, get: () => { throw new Error("getter was invoked"); } });
    const log = createLogger({}, (record) => records.push(record));
    expect(() => log.info("object.logged", { circular, huge: Array.from({ length: 1000 }, (_, index) => index) })).not.toThrow();
    expect(JSON.stringify(records)).toContain("[CIRCULAR]");
    expect(JSON.stringify(records)).toContain("[ACCESSOR]");
    expect(JSON.stringify(records).length).toBeLessThan(16_384);
  });

  it("keeps reserved and parent fields immutable and never lets the sink fail the application", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ correlationId: "parent", organizationId: "tenant-1" }, (record) => records.push(record));
    log.child({ correlationId: "forged", requestId: "req-1" }).debug("request.started", { timestamp: "forged", level: "error", event: "forged", organizationId: "tenant-2", requestId: "req-2" });
    expect(records[0]).toMatchObject({ correlationId: "parent", organizationId: "tenant-1", requestId: "req-1", level: "debug", event: "request.started", schemaVersion: 1 });
    expect(records[0]?.timestamp).not.toBe("forged");
    expect(() => createLogger({}, () => { throw new Error("sink unavailable"); }).info("still.works")).not.toThrow();
  });

  it("replaces an oversized record with a bounded semantic marker", () => {
    const records: LogRecord[] = [];
    const log = createLogger({}, (record) => records.push(record));
    log.info("large.payload", Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, "x".repeat(900)])));
    expect(records[0]).toMatchObject({ event: "large.payload", truncated: true });
    expect(JSON.stringify(records[0]).length).toBeLessThan(500);
  });
});
