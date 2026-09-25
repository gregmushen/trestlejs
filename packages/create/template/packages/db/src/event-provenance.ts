import { EVENT_REPLAY_WINDOW_DAYS, PermanentEventError, type EventEnvelope, type OutboxEntry } from "@__TRESTLE_PROJECT_NAME__/events";

export type CommittedEventStore = { findCommitted(id: string): Promise<OutboxEntry | null> };

const dayMs = 24 * 60 * 60 * 1_000;

/** Whether a committed event is older than the replay window at `now`.
 * Exactly `maxAgeDays` old is still inside it. */
export function outsideReplayWindow(occurredAt: Date | string, now: Date, maxAgeDays = EVENT_REPLAY_WINDOW_DAYS): boolean {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error("Invalid event replay window");
  const committedAt = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(occurredAt);
  if (!Number.isFinite(committedAt) || !Number.isFinite(now.getTime())) throw new Error("Invalid event replay window time");
  return now.getTime() - committedAt > maxAgeDays * dayMs;
}

/** Stable JSON with object keys sorted, so key order never decides a match. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item);
}

function sameEvent(committed: EventEnvelope, delivered: EventEnvelope): boolean {
  return committed.id === delivered.id && committed.name === delivered.name && committed.schemaVersion === delivered.schemaVersion
    && committed.idempotencyKey === delivered.idempotencyKey && committed.correlationId === delivered.correlationId
    && (committed.causationId ?? null) === (delivered.causationId ?? null)
    && committed.resource.type === delivered.resource.type && committed.resource.id === delivered.resource.id
    // The envelope schema accepts several ISO formats, and committed rows keep
    // database precision, so compare instants rather than strings.
    && Date.parse(committed.occurredAt) === Date.parse(delivered.occurredAt)
    && canonicalJson(committed.payload) === canonicalJson(delivered.payload);
}

/**
 * Reload the committed outbox row for a delivered envelope and require an
 * exact match on every execution-relevant field. A Queue or Workflow message
 * is a reference to committed work, never the authority for it.
 *
 * - No committed row: `PermanentEventError("provenance_missing")`.
 * - Any field differs: `PermanentEventError("provenance_mismatch")`.
 * - The committed event is older than the replay window:
 *   `PermanentEventError("provenance_expired")`. Age comes from the committed
 *   row, never the delivered envelope, and is checked after the comparison.
 *
 * Store failures propagate unchanged so they stay transient and retry.
 */
export async function verifyCommittedEvent(store: CommittedEventStore, delivered: EventEnvelope, options: { now?: Date; maxAgeDays?: number } = {}): Promise<OutboxEntry> {
  const maxAgeDays = options.maxAgeDays ?? EVENT_REPLAY_WINDOW_DAYS;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error("Invalid event replay window");
  const committed = await store.findCommitted(delivered.id);
  if (!committed) throw new PermanentEventError("provenance_missing");
  if (committed.id !== delivered.id || !sameEvent(committed.message, delivered)) throw new PermanentEventError("provenance_mismatch");
  if (outsideReplayWindow(committed.message.occurredAt, options.now ?? new Date(), maxAgeDays)) throw new PermanentEventError("provenance_expired");
  return committed;
}
