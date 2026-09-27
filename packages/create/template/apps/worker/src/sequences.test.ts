import { sequenceMessageTemplate } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { describe, expect, it } from "vitest";

import { trialNurture } from "./email-sequences.js";
import { app } from "./index.js";
import { signUnsubscribeToken, SequenceRegistry, verifyUnsubscribeToken, type SequenceDependencies } from "./sequence-runtime.js";
import { nextAllowedSendTime, parseSequenceWait, sequenceWaitEnd, zonedInstant } from "./sequence-timing.js";
import { defineSequence, SequenceDefinitionError, type SequenceConfig } from "./sequences.js";

const template = () => ({ subject: "Hello", template: sequenceMessageTemplate("hello", { heading: "Hello", paragraphs: [] }) });
const base: SequenceConfig = {
  id: "welcome", kind: "marketing", authority: "tenant", trigger: "user.signed_up", recipient: () => null,
  exitOn: ["billing.subscription.activated"], steps: [{ send: "hello" }, { wait: "3d" }, { send: "again" }], templates: { hello: template, again: template },
};
const at = (iso: string) => new Date(iso);

describe("defineSequence", () => {
  it("compiles steps, waits, and default quiet hours, and ships a valid example", () => {
    const sequence = defineSequence(base);
    expect(sequence.steps.map((step) => step.type)).toEqual(["send", "wait", "send"]);
    expect(sequence.steps[1]).toMatchObject({ type: "wait", wait: { days: 3 } });
    expect(sequence.quietHours).toEqual({ start: "21:00", end: "08:00" });
    expect(sequence.validForDays).toBe(14);
    expect(trialNurture).toMatchObject({ id: "trial-nurture", kind: "marketing", trigger: "user.signed_up" });
    expect(defineSequence({ ...base, quietHours: false }).quietHours).toBeNull();
  });

  it("rejects what cannot run: unknown events, bad waits and templates, and waits longer than the validity window", () => {
    const rejects = (config: Partial<SequenceConfig>, message: RegExp | typeof SequenceDefinitionError) => expect(() => defineSequence({ ...base, ...config } as SequenceConfig)).toThrow(message);
    rejects({ trigger: "user.nonexistent" }, /user.nonexistent is not in the event catalog/u);
    rejects({ exitOn: ["billing.subscription.gone"] }, /billing.subscription.gone is not in the event catalog/u);
    rejects({ exitOn: ["billing.subscription.activated", "billing.subscription.activated"] }, /twice/u);
    rejects({ exitOn: ["user.signed_up"] }, /trigger cannot also be an exit/u);
    rejects({ steps: [{ send: "hello" }, { wait: "3 days" }, { send: "again" }] }, /Invalid sequence wait "3 days"/u);
    rejects({ steps: [{ send: "hello" }, { send: "missing" }, { send: "again" }] }, /sends missing, which is not in templates/u);
    rejects({ steps: [{ send: "hello" }] }, /templates again are never sent/u);
    rejects({ steps: [{ wait: "1d" }], templates: {} }, /at least one send/u);
    rejects({ quietHours: { start: "08:00", end: "08:00" } }, /different times/u);
    rejects({ quietHours: { start: "8am", end: "09:00" } }, /Invalid quiet hours time/u);
    rejects({ steps: [{ send: "hello" }, { wait: "2w" }, { send: "again" }] }, /longer than validForDays \(14\)/u);
    rejects({ validForDays: 45 }, SequenceDefinitionError);
    rejects({ id: "Welcome" }, /lowercase/u);
    rejects({ kind: "newsletter" as never }, SequenceDefinitionError);
    expect(defineSequence({ ...base, steps: [{ send: "hello" }, { wait: "2w" }, { send: "again" }], validForDays: 30 }).validForDays).toBe(30);
  });

  it("registers each sequence once and requires signed unsubscribe links for marketing", () => {
    const dependencies = { engine: () => undefined } as unknown as SequenceDependencies<unknown>;
    expect(() => new SequenceRegistry(dependencies).register(defineSequence(base))).toThrow(/needs signed unsubscribe links/u);
    const registry = new SequenceRegistry({ ...dependencies, unsubscribeUrl: async () => "https://example.test/u" });
    registry.register(defineSequence(base));
    expect(() => registry.register(defineSequence(base))).toThrow(/already registered/u);
    registry.register(defineSequence({ ...base, id: "receipts", kind: "transactional" }));
    expect(registry.list().map((sequence) => sequence.id)).toEqual(["welcome", "receipts"]);
  });
});

describe("sequence timing", () => {
  it("parses waits as calendar days or exact spans", () => {
    expect(parseSequenceWait("3d")).toEqual({ days: 3 });
    expect(parseSequenceWait("2w")).toEqual({ days: 14 });
    expect(parseSequenceWait("12h")).toEqual({ ms: 12 * 3_600_000 });
    expect(parseSequenceWait("30s")).toEqual({ ms: 30_000 });
    for (const invalid of ["0d", "3", "1.5h", "-1d", "3 d", "1y"]) expect(() => parseSequenceWait(invalid)).toThrow(/Invalid sequence wait/u);
  });

  it("keeps the recipient's local time across daylight-saving changes", () => {
    // 09:00 EST on 6 March; 9 March is after the spring-forward change, still 09:00 local (now EDT).
    expect(sequenceWaitEnd(at("2026-03-06T14:00:00Z"), { days: 3 }, "America/New_York").toISOString()).toBe("2026-03-09T13:00:00.000Z");
    // 09:00 EDT on 30 October; 2 November is after the fall-back change, still 09:00 local (now EST).
    expect(sequenceWaitEnd(at("2026-10-30T13:00:00Z"), { days: 3 }, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // Exact spans ignore the calendar: 24 hours across spring-forward is 10:00 local the next day.
    expect(sequenceWaitEnd(at("2026-03-07T14:00:00Z"), { ms: 86_400_000 }, "America/New_York").toISOString()).toBe("2026-03-08T14:00:00.000Z");
    // Unknown or invalid zones measure in UTC.
    expect(sequenceWaitEnd(at("2026-03-06T14:00:00Z"), { days: 1 }, null).toISOString()).toBe("2026-03-07T14:00:00.000Z");
    expect(sequenceWaitEnd(at("2026-03-06T14:00:00Z"), { days: 1 }, "Mars/Olympus").toISOString()).toBe("2026-03-07T14:00:00.000Z");
  });

  it("resolves skipped and repeated local times", () => {
    // 02:30 does not exist on 8 March in New York: it moves forward by the gap, to 03:30 EDT.
    expect(zonedInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // 03:30 on 8 March exists (EDT).
    expect(zonedInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 30, second: 0 }, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
    // 01:30 on 1 November happens twice: the first (EDT) occurrence.
    expect(zonedInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // A wait that lands on 02:30 local on the spring-forward day sends at 03:30.
    expect(sequenceWaitEnd(at("2026-03-07T07:30:00Z"), { days: 1 }, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("moves sends out of quiet hours in the recipient's zone", () => {
    const quiet = { start: "21:00", end: "08:00" };
    // 22:30 in Los Angeles: the next morning at 08:00.
    expect(nextAllowedSendTime(at("2026-06-02T05:30:00Z"), "America/Los_Angeles", quiet).toISOString()).toBe("2026-06-02T15:00:00.000Z");
    // 06:00 in Los Angeles: 08:00 the same day.
    expect(nextAllowedSendTime(at("2026-06-02T13:00:00Z"), "America/Los_Angeles", quiet).toISOString()).toBe("2026-06-02T15:00:00.000Z");
    // Midday is allowed as is; so is 08:00 exactly and 20:59.
    expect(nextAllowedSendTime(at("2026-06-02T19:00:00Z"), "America/Los_Angeles", quiet).toISOString()).toBe("2026-06-02T19:00:00.000Z");
    expect(nextAllowedSendTime(at("2026-06-02T15:00:00Z"), "America/Los_Angeles", quiet).toISOString()).toBe("2026-06-02T15:00:00.000Z");
    expect(nextAllowedSendTime(at("2026-06-03T03:59:00Z"), "America/Los_Angeles", quiet).toISOString()).toBe("2026-06-03T03:59:00.000Z");
    // Quiet hours spanning the fall-back night: 23:00 EDT on 31 October waits for 08:00 EST.
    expect(nextAllowedSendTime(at("2026-11-01T03:00:00Z"), "America/New_York", quiet).toISOString()).toBe("2026-11-01T13:00:00.000Z");
    // A window that does not cross midnight, in UTC when the zone is unknown.
    expect(nextAllowedSendTime(at("2026-06-02T13:30:00Z"), null, { start: "13:00", end: "14:00" }).toISOString()).toBe("2026-06-02T14:00:00.000Z");
    expect(nextAllowedSendTime(at("2026-06-02T13:30:00Z"), null, null).toISOString()).toBe("2026-06-02T13:30:00.000Z");
  });
});

describe("one-click unsubscribe route", () => {
  const environment = { DATABASE_URL: "postgres://user:password@127.0.0.1:1/unused", DATABASE_DRIVER: "postgres-js" as const, BETTER_AUTH_SECRET: "test-secret-at-least-32-characters", APP_ENV: "local" as const };
  const token = () => signUnsubscribeToken(environment.BETTER_AUTH_SECRET, { organizationId: "org_1", recipientHash: "a".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) });

  it("confirms on GET without unsubscribing, and refuses forged or expired links", async () => {
    const valid = await token();
    const page = await app.request(`/api/email/unsubscribe?token=${valid}`, {}, environment);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain(`<form method="post" action="/api/email/unsubscribe?token=${valid}">`);
    const expired = await signUnsubscribeToken(environment.BETTER_AUTH_SECRET, { organizationId: "org_1", recipientHash: "a".repeat(64), expiresAt: new Date(Date.now() - 1_000) });
    for (const bad of [expired, `${valid}x`, "", "a.b"]) {
      expect((await app.request(`/api/email/unsubscribe?token=${encodeURIComponent(bad)}`, {}, environment)).status).toBe(400);
      expect((await app.request(`/api/email/unsubscribe?token=${encodeURIComponent(bad)}`, { method: "POST", body: "List-Unsubscribe=One-Click" }, environment)).status).toBe(400);
    }
  });

  it("performs a one-click POST from a mail client and reports a storage failure as retryable", async () => {
    // The database is unreachable here: a valid token reaches persistence and fails without a stack trace.
    const response = await app.request(`/api/email/unsubscribe?token=${await token()}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }, environment);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Try again");
  });
});

describe("unsubscribe tokens", () => {
  const secret = "unsubscribe-test-secret-at-least-32-bytes";
  const subject = { organizationId: "org_1", recipientHash: "a".repeat(64) };

  it("verifies its own signature until it expires, and nothing else", async () => {
    const token = await signUnsubscribeToken(secret, { ...subject, expiresAt: at("2026-12-01T00:00:00Z") });
    expect(await verifyUnsubscribeToken(secret, token, at("2026-11-01T00:00:00Z"))).toEqual(subject);
    expect(await verifyUnsubscribeToken(secret, token, at("2026-12-01T00:00:01Z"))).toBeNull();
    expect(await verifyUnsubscribeToken(`${secret}-other`, token, at("2026-11-01T00:00:00Z"))).toBeNull();
    const [body, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(Buffer.from(body, "base64url").toString().replace("org_1", "org_2")).toString("base64url");
    expect(await verifyUnsubscribeToken(secret, `${forged}.${signature}`, at("2026-11-01T00:00:00Z"))).toBeNull();
    expect(await verifyUnsubscribeToken(secret, "not-a-token", at("2026-11-01T00:00:00Z"))).toBeNull();
    expect(token).not.toContain("@");
    await expect(signUnsubscribeToken("short", { ...subject, expiresAt: at("2026-12-01T00:00:00Z") })).rejects.toThrow(/at least 32 bytes/u);
  });
});
