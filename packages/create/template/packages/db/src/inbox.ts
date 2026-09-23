import { eventEnvelopeSchema, type EventEnvelope, type EventInboxStore, type InboxClaim } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";

import { outboxApplicationConnectionString } from "./outbox.js";

type InboxRow = { event_name: string; status: "processing" | "completed" };

/** Durable duplicate suppression for Queue delivery; handlers must still make external side effects idempotent. */
export class PostgresEventInbox implements EventInboxStore {
  private readonly sql;
  constructor(connectionString: string, options: { assumeApplicationRole?: boolean } = {}) {
    this.sql = postgres(options.assumeApplicationRole ? outboxApplicationConnectionString(connectionString) : connectionString, { max: 2, prepare: false });
  }
  async close(): Promise<void> { await this.sql.end(); }

  async claim(message: EventEnvelope, leaseMs = 120_000): Promise<InboxClaim> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Inbox lease must be between 1 and 300000 milliseconds");
    const event = eventEnvelopeSchema.parse(message);
    const token = crypto.randomUUID();
    const [claimed] = await this.sql<InboxRow[]>`
      insert into event_inbox (idempotency_key, event_id, event_name, claim_token, leased_until, attempts)
      values (${event.idempotencyKey}, ${event.id}, ${event.name}, ${token}, now() + (${leaseMs} * interval '1 millisecond'), 1)
      on conflict (idempotency_key) do update
        set claim_token = excluded.claim_token,
            leased_until = excluded.leased_until,
            attempts = event_inbox.attempts + 1
      where event_inbox.event_name = excluded.event_name
        and event_inbox.status = 'processing'
        and (event_inbox.leased_until is null or event_inbox.leased_until <= now())
      returning event_name, status
    `;
    if (claimed) return { state: "claimed", token };
    const [existing] = await this.sql<InboxRow[]>`select event_name, status from event_inbox where idempotency_key = ${event.idempotencyKey}`;
    if (!existing) throw new Error("Inbox claim could not be resolved");
    if (existing.event_name !== event.name) throw new Error("Inbox idempotency key belongs to a different event");
    return { state: existing.status === "completed" ? "completed" : "busy" };
  }

  async complete(idempotencyKey: string, token: string): Promise<void> {
    const result = await this.sql`
      update event_inbox
         set status = 'completed', claim_token = null, leased_until = null, processed_at = now(), last_error = null
       where idempotency_key = ${idempotencyKey} and claim_token = ${token} and status = 'processing'
    `;
    if (result.count !== 1) throw new Error("Inbox claim is no longer active");
  }

  async release(idempotencyKey: string, token: string, error: unknown): Promise<void> {
    const category = error instanceof Error ? error.name : "UnknownError";
    const result = await this.sql`
      update event_inbox
         set claim_token = null, leased_until = now(), last_error = ${category.slice(0, 100)}
       where idempotency_key = ${idempotencyKey} and claim_token = ${token} and status = 'processing'
    `;
    if (result.count !== 1) throw new Error("Inbox claim is no longer active");
  }
}
