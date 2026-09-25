import { EVENT_PROVENANCE_RETENTION_DAYS, EVENT_REPLAY_WINDOW_DAYS, PermanentEventError, eventEnvelopeSchema, safeErrorCategory, type EventEnvelope, type OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";
import { describe, expect, it } from "vitest";

import { verifyCommittedEvent, type CommittedEventStore } from "./event-provenance.js";

const occurredAt = "2026-09-01T00:00:00.000Z";
const day = 24 * 60 * 60 * 1_000;
const committedMessage = eventEnvelopeSchema.parse({
  id: "7f1c3f0e-3c1a-4b8e-9d7c-2f4a8a1b6c01", name: "article.published", schemaVersion: 1, occurredAt,
  resource: { type: "article", id: "article-1" }, correlationId: "corr-1", causationId: "cause-1", idempotencyKey: "key-1",
  payload: { articleId: "article-1", title: "Hello", nested: { a: 1, b: [1, 2] } },
});
const committedEntry: OutboxEntry = { id: committedMessage.id, message: committedMessage, organizationId: "org-1", status: "succeeded", attempts: 0, availableAt: new Date(occurredAt) };
const store = (entry: OutboxEntry | null = committedEntry): CommittedEventStore => ({ findCommitted: async (id) => entry && entry.id === id ? entry : null });
const withinWindow = { now: new Date(Date.parse(occurredAt) + day) };

async function reason(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { if (error instanceof PermanentEventError) return error.reason; throw error; }
  throw new Error("Expected a permanent event failure");
}

describe("committed event verification", () => {
  it("declares the replay window inside the provenance retention window", () => {
    expect(EVENT_REPLAY_WINDOW_DAYS).toBe(14);
    expect(EVENT_PROVENANCE_RETENTION_DAYS).toBe(30);
  });

  it("returns the committed entry for an exact match", async () => {
    expect(await verifyCommittedEvent(store(), committedMessage, withinWindow)).toBe(committedEntry);
  });

  it("matches a reordered payload and an equivalent occurredAt format", async () => {
    const delivered: EventEnvelope = { ...committedMessage, occurredAt: "2026-09-01T00:00:00Z", payload: { nested: { b: [1, 2], a: 1 }, title: "Hello", articleId: "article-1" } };
    expect(await verifyCommittedEvent(store(), delivered, withinWindow)).toBe(committedEntry);
  });

  it("orders payload keys by code unit, not locale, so locale-equal keys still match in any order", async () => {
    // localeCompare ignores the soft hyphen, so it reports these two keys as equal.
    expect("a\u00ADb".localeCompare("ab")).toBe(0);
    const message = { ...committedMessage, payload: { "a\u00ADb": 1, ab: 2 } };
    const entry = { ...committedEntry, message };
    const delivered: EventEnvelope = { ...committedMessage, payload: { ab: 2, "a\u00ADb": 1 } };
    expect(await verifyCommittedEvent(store(entry), delivered, withinWindow)).toBe(entry);
    expect(await reason(verifyCommittedEvent(store(entry), { ...committedMessage, payload: { ab: 1, "a\u00ADb": 2 } }, withinWindow))).toBe("provenance_mismatch");
  });

  it("treats an absent causation ID the same on both sides", async () => {
    const { causationId: _omitted, ...withoutCausation } = committedMessage;
    const entry = { ...committedEntry, message: withoutCausation };
    expect(await verifyCommittedEvent(store(entry), withoutCausation, withinWindow)).toBe(entry);
    expect(await reason(verifyCommittedEvent(store(entry), committedMessage, withinWindow))).toBe("provenance_mismatch");
  });

  it.each<[string, Partial<EventEnvelope>]>([
    ["payload", { payload: { articleId: "article-1", title: "Forged", nested: { a: 1, b: [1, 2] } } }],
    ["resource type", { resource: { type: "comment", id: "article-1" } }],
    ["resource id", { resource: { type: "article", id: "article-2" } }],
    ["event type", { name: "article.deleted" }],
    ["schema version", { schemaVersion: 2 }],
    ["idempotency key", { idempotencyKey: "key-2" }],
    ["correlation ID", { correlationId: "corr-2" }],
    ["causation ID", { causationId: "cause-2" }],
    ["occurredAt", { occurredAt: "2026-09-01T00:00:01.000Z" }],
  ])("rejects a changed %s as a provenance mismatch", async (_field, change) => {
    expect(await reason(verifyCommittedEvent(store(), { ...committedMessage, ...change }, withinWindow))).toBe("provenance_mismatch");
  });

  it("rejects a delivered event with no committed row as missing provenance", async () => {
    expect(await reason(verifyCommittedEvent(store(null), committedMessage, withinWindow))).toBe("provenance_missing");
  });

  it("propagates store failures unchanged so they stay retryable", async () => {
    const unavailable = new Error("database unavailable");
    const failing: CommittedEventStore = { findCommitted: async () => { throw unavailable; } };
    await expect(verifyCommittedEvent(failing, committedMessage, withinWindow)).rejects.toBe(unavailable);
  });

  it("enforces the replay window from the committed occurredAt", async () => {
    const window = EVENT_REPLAY_WINDOW_DAYS * day;
    expect(await verifyCommittedEvent(store(), committedMessage, { now: new Date(Date.parse(occurredAt) + window - 1) })).toBe(committedEntry);
    expect(await reason(verifyCommittedEvent(store(), committedMessage, { now: new Date(Date.parse(occurredAt) + window + 1) }))).toBe("provenance_expired");
    expect(await reason(verifyCommittedEvent(store(), committedMessage, { now: new Date(Date.parse(occurredAt) + 2 * day + 1), maxAgeDays: 2 }))).toBe("provenance_expired");
  });

  it("compares before checking age, so a forged recent occurredAt cannot bypass expiry", async () => {
    const now = new Date(Date.parse(occurredAt) + 20 * day);
    const forged = { ...committedMessage, occurredAt: new Date(now.getTime() - day).toISOString() };
    expect(await reason(verifyCommittedEvent(store(), forged, { now }))).toBe("provenance_mismatch");
  });

  it("names permanent failures with a safe error category", () => {
    const error = new PermanentEventError("provenance_missing");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PermanentEventError");
    expect(error.message).toBe("Permanent event failure: provenance_missing");
    expect(safeErrorCategory(error)).toBe("PermanentEventError");
  });
});
