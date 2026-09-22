import { describe, expect, it } from "vitest";

import { createLogger, type LogRecord } from "./index.js";

describe("semantic logger", () => {
  it("emits context and redacts sensitive values recursively", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ correlationId: "corr-1", authorization: "Bearer secret" }, (record) => records.push(record));
    log.info("resource.article.created", { organizationId: "org-1", nested: { resetToken: "token-value" } });
    expect(records[0]).toMatchObject({ level: "info", event: "resource.article.created", correlationId: "corr-1", authorization: "[REDACTED]", organizationId: "org-1", nested: { resetToken: "[REDACTED]" } });
  });
});
