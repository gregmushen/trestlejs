import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalEmailAdapter, LocalEmailStore } from "./adapters/local.js";
import { renderEmail } from "./render.js";
import { StagingRedirectEmailService } from "./staging.js";
import { EmailValidationError } from "./types.js";
import type { EmailMessage, EmailService, ScheduledEmail } from "./types.js";
import { verifyEmailTemplate } from "./templates/verify-email.js";

const message: EmailMessage = { to: "greg@example.test", subject: "Verify your email", template: verifyEmailTemplate({ verificationUrl: "http://localhost/verify?token=secret" }) };

describe("transactional email", () => {
  let now: Date;
  let store: LocalEmailStore;
  let local: LocalEmailAdapter;
  beforeEach(() => {
    now = new Date("2026-01-02T03:04:05.000Z");
    store = new LocalEmailStore();
    local = new LocalEmailAdapter(store, { now: () => now });
  });

  it("renders useful HTML and plain text", async () => {
    const rendered = await renderEmail(message.template);
    expect(rendered.html).toContain("Verify your email");
    expect(rendered.text).toContain("http://localhost/verify?token=secret");
  });

  it("captures immediate email and deduplicates a stable logical operation", async () => {
    const first = await local.send(message, { idempotencyKey: "verify:user-1" });
    const second = await local.send(message, { idempotencyKey: "verify:user-1" });
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for a different payload", async () => {
    await local.send(message, { idempotencyKey: "verify:user-1" });
    await expect(local.send({ ...message, subject: "Different" }, { idempotencyKey: "verify:user-1" })).rejects.toBeInstanceOf(EmailValidationError);
  });

  it("schedules, reschedules, cancels, and flushes against an advanceable clock", async () => {
    const scheduled = await local.schedule(message, new Date("2026-01-02T05:04:05.000Z"));
    await local.reschedule(scheduled.id, new Date("2026-01-02T04:04:05.000Z"));
    now = new Date("2026-01-02T04:04:05.000Z");
    expect(await local.flushScheduledEmail()).toBe(1);
    expect((await local.cancel(scheduled.id)).status).toBe("already_sent");
    const second = await local.schedule(message, new Date("2026-01-02T06:04:05.000Z"));
    expect((await local.cancel(second.id)).status).toBe("cancelled");
  });

  it("redirects every staging recipient and removes cc and bcc", async () => {
    const staging = new StagingRedirectEmailService(local, "staging@example.test");
    await staging.send({ ...message, cc: ["copy@example.test"], bcc: ["blind@example.test"] });
    expect(store.list()[0]).toMatchObject({ to: ["staging@example.test"], cc: [], bcc: [], subject: "[STAGING → greg@example.test] Verify your email" });
  });

  it("logs semantics without recipients, rendered content, or tokens", async () => {
    const events: unknown[] = [];
    const adapter = new LocalEmailAdapter(store, { now: () => now }, (event, fields) => events.push({ event, fields }));
    await adapter.send(message);
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("greg@example.test");
    expect(logged).not.toContain("token=secret");
    expect(logged).toContain("email.send.accepted");
  });
});
