import { describe, expect, it } from "vitest";

import { AuditEventError, recordAuditEvent, redactAuditSummary } from "./audit.js";

describe("audit redaction", () => {
  it("redacts sensitive keys at any depth and bounds strings", () => {
    const summary = redactAuditSummary({
      name: "CRM", signingSecret: "whsec_live_123", destinationUrl: "https://crm.example.test/hook?token=abc",
      nested: { apiKey: "tr_live_abc", headers: { Authorization: "Bearer x" }, note: "x".repeat(600) },
    }) as Record<string, any>;
    expect(summary).toMatchObject({ name: "CRM", signingSecret: "[REDACTED]", destinationUrl: "[REDACTED]", nested: { apiKey: "[REDACTED]", headers: { Authorization: "[REDACTED]" } } });
    expect(summary.nested.note).toHaveLength(501);
    expect(JSON.stringify(summary)).not.toMatch(/whsec_|tr_live_|Bearer|token=abc/u);
  });

  it("rejects unnamed or uncorrelated events before writing", async () => {
    const database = { insert: () => { throw new Error("must not write"); } } as never;
    const event = { actor: { type: "user" as const, id: "u" }, organizationId: "o", target: { type: "t", id: "1" }, environment: "local", correlationId: "c" };
    await expect(recordAuditEvent(database, { ...event, name: "rolesChanged" })).rejects.toBeInstanceOf(AuditEventError);
    await expect(recordAuditEvent(database, { ...event, name: "access.roles.changed", correlationId: " " })).rejects.toThrow("correlation ID");
  });
});
