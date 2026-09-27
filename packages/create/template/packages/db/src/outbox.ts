import { EVENT_PROVENANCE_RETENTION_DAYS, eventEnvelopeSchema, safeErrorCategory, type EventEnvelope, type OutboxEntry, type OutboxStore } from "@__TRESTLE_PROJECT_NAME__/events";
import { sql, type SQL } from "drizzle-orm";
import postgres from "postgres";

type Row = { id: string; event_name: string; schema_version: number; occurred_at: Date; resource_type: string; resource_id: string; organization_id: string | null; correlation_id: string; causation_id: string | null; idempotency_key: string; payload: unknown; status: "pending" | "leased" | "succeeded" | "dead"; attempts: number; available_at: Date; leased_until: Date | null; last_error: string | null };

function entry(row: Row): OutboxEntry {
  return { id: row.id, message: eventEnvelopeSchema.parse({ id: row.id, name: row.event_name, schemaVersion: row.schema_version, occurredAt: row.occurred_at.toISOString(), resource: { type: row.resource_type, id: row.resource_id }, correlationId: row.correlation_id, ...(row.causation_id ? { causationId: row.causation_id } : {}), idempotencyKey: row.idempotency_key, payload: row.payload }), ...(row.organization_id ? { organizationId: row.organization_id } : {}), status: row.status, attempts: row.attempts, availableAt: row.available_at, ...(row.leased_until ? { leasedUntil: row.leased_until } : {}), ...(row.last_error ? { lastError: row.last_error } : {}) };
}

const retentionWindowMs = EVENT_PROVENANCE_RETENTION_DAYS * 86_400_000;

/** Committed provenance must outlive every supported replay, so a prune may only remove rows processed before now − 30 days. */
function assertRetentionCutoff(before: Date, now: Date): void {
  if (!Number.isFinite(before.getTime()) || !Number.isFinite(now.getTime())) throw new Error("Invalid outbox retention cutoff");
  const latest = new Date(now.getTime() - retentionWindowMs);
  if (before.getTime() > latest.getTime()) throw new Error(`Outbox retention cutoff is inside the ${EVENT_PROVENANCE_RETENTION_DAYS}-day provenance window; use a cutoff at or before ${latest.toISOString()}`);
}

export function outboxApplicationConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  const options = url.searchParams.get("options");
  url.searchParams.set("options", [options, "-c role=trestle_app"].filter(Boolean).join(" "));
  return url.toString();
}

/** Compose an event insert with a domain mutation in the same Drizzle
 * transaction. The tenant comes from the authenticated execution context,
 * never from an event payload or Queue envelope. */
export function outboxStatement(message: EventEnvelope, organizationId: string): SQL {
  const parsed = eventEnvelopeSchema.parse(message);
  if (!/^[A-Za-z0-9_-]+$/u.test(organizationId)) throw new Error("Invalid outbox organization identifier");
  return sql`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, causation_id, idempotency_key, payload, available_at)
    values (${parsed.id}, ${parsed.name}, ${parsed.schemaVersion}, ${parsed.occurredAt}::timestamptz, ${parsed.resource.type}, ${parsed.resource.id}, ${organizationId}, ${parsed.correlationId}, ${parsed.causationId ?? null}, ${parsed.idempotencyKey}, ${JSON.stringify(parsed.payload)}::text::jsonb, ${parsed.occurredAt}::timestamptz)
    on conflict (idempotency_key) do nothing`;
}

/** Compose a tenantless event insert for `{ authority: "system" }` work in the
 * same transaction as the state that requests it. The committed row carries
 * no organization, so it can never reach a tenant or verified handler. */
export function systemOutboxStatement(message: EventEnvelope): SQL {
  const parsed = eventEnvelopeSchema.parse(message);
  return sql`insert into outbox_message (id, event_name, schema_version, occurred_at, resource_type, resource_id, organization_id, correlation_id, causation_id, idempotency_key, payload, available_at)
    values (${parsed.id}, ${parsed.name}, ${parsed.schemaVersion}, ${parsed.occurredAt}::timestamptz, ${parsed.resource.type}, ${parsed.resource.id}, null, ${parsed.correlationId}, ${parsed.causationId ?? null}, ${parsed.idempotencyKey}, ${JSON.stringify(parsed.payload)}::text::jsonb, ${parsed.occurredAt}::timestamptz)
    on conflict (idempotency_key) do nothing`;
}

export class PostgresOutboxStore implements OutboxStore {
  private readonly sql;
  constructor(connectionString: string, options: { assumeApplicationRole?: boolean } = {}) { this.sql = postgres(options.assumeApplicationRole ? outboxApplicationConnectionString(connectionString) : connectionString, { max: 2, prepare: false }); }
  async close(): Promise<void> { await this.sql.end(); }
  async append(message: EventEnvelope, options: { organizationId?: string } = {}): Promise<OutboxEntry> {
    const parsed = eventEnvelopeSchema.parse(message);
    if (options.organizationId !== undefined && !options.organizationId.trim()) throw new Error("Outbox organization ID must not be blank");
    const [inserted] = await this.sql<Row[]>`insert into outbox_message (id,event_name,schema_version,occurred_at,resource_type,resource_id,organization_id,correlation_id,causation_id,idempotency_key,payload,available_at) values (${parsed.id},${parsed.name},${parsed.schemaVersion},${new Date(parsed.occurredAt)},${parsed.resource.type},${parsed.resource.id},${options.organizationId ?? null},${parsed.correlationId},${parsed.causationId ?? null},${parsed.idempotencyKey},${this.sql.json(parsed.payload as postgres.JSONValue)},${new Date(parsed.occurredAt)}) on conflict (idempotency_key) do nothing returning *`;
    if (inserted) return entry(inserted);
    const [existing] = await this.sql<Row[]>`select * from outbox_message where idempotency_key=${parsed.idempotencyKey}`;
    if (!existing) throw new Error("Outbox idempotency lookup failed");
    if (existing.organization_id !== (options.organizationId ?? null)) throw new Error("Outbox idempotency key belongs to a different organization");
    return entry(existing);
  }
  /** Resolve tenant provenance from the committed row; never infer it from Queue payloads. */
  async findCommitted(id: string): Promise<OutboxEntry | null> {
    const [row] = await this.sql<Row[]>`select * from outbox_message where id=${id}`;
    return row ? entry(row) : null;
  }
  /** When pending or leased work is next due: the earliest available pending row or expiring lease, or null when none remains. */
  async nextDue(): Promise<Date | null> {
    const [row] = await this.sql<[{ next: Date | null }]>`select min(case when status = 'pending' then available_at else leased_until end) as next from outbox_message where status in ('pending', 'leased')`;
    return row?.next ?? null;
  }
  async lease(limit = 10, leaseMs = 30_000): Promise<OutboxEntry[]> {
    const rows = await this.sql.begin(async (transaction) => await transaction<Row[]>`with candidates as (select id from outbox_message where (status='pending' and available_at <= now()) or (status='leased' and leased_until <= now()) order by available_at for update skip locked limit ${limit}) update outbox_message set status='leased', leased_until=now()+(${leaseMs} * interval '1 millisecond') from candidates where outbox_message.id=candidates.id returning outbox_message.*`);
    return rows.map(entry);
  }
  async succeed(id: string): Promise<void> { const result = await this.sql`update outbox_message set status='succeeded', leased_until=null, processed_at=now() where id=${id} and status in ('leased','succeeded')`; if (result.count === 0) throw new Error(`Outbox entry ${id} is not leased`); }
  async fail(id: string, error: unknown, maxAttempts = 5): Promise<void> { const category = safeErrorCategory(error); const result = await this.sql`update outbox_message set attempts=attempts+1,last_error=${category},leased_until=null,status=case when attempts+1 >= ${maxAttempts} then 'dead' else 'pending' end,available_at=case when attempts+1 >= ${maxAttempts} then available_at else now()+(power(2,attempts)*interval '1 second') end where id=${id} and status='leased'`; if (result.count === 0) throw new Error(`Outbox entry ${id} is not leased`); }
  /**
   * Settlement for runtimes that can end a run without success (a canceled or
   * crashed run): events dispatched longer ago than `olderThanMs`, still inside
   * the replay window, that no consumer completed, return to pending under the
   * next generation. An event that reached the attempt cap is dead-lettered
   * instead, so it is visible and redrivable rather than silently stranded. The
   * inbox still guarantees a handler never completes twice.
   */
  async settleUnconsumed(options: { olderThanMs: number; maxAttempts?: number; limit?: number }): Promise<string[]> {
    await this.sql`update outbox_message set status='dead', last_error='unconsumed_after_retries' where id in (select o.id from outbox_message o where o.status='succeeded' and o.processed_at <= now() - (${options.olderThanMs} * interval '1 millisecond') and o.occurred_at > now() - interval '14 days' and o.attempts + 1 >= ${options.maxAttempts ?? 5} and not exists (select 1 from event_inbox i where i.idempotency_key = o.idempotency_key and i.status = 'completed') for update of o skip locked)`;
    const rows = await this.sql<{ id: string }[]>`with stale as (select o.id from outbox_message o where o.status='succeeded' and o.processed_at <= now() - (${options.olderThanMs} * interval '1 millisecond') and o.occurred_at > now() - interval '14 days' and o.attempts + 1 < ${options.maxAttempts ?? 5} and not exists (select 1 from event_inbox i where i.idempotency_key = o.idempotency_key and i.status = 'completed') order by o.processed_at for update of o skip locked limit ${options.limit ?? 100}) update outbox_message set status='pending', available_at=now(), attempts=attempts+1, processed_at=null from stale where outbox_message.id = stale.id returning outbox_message.id`;
    return rows.map((row) => row.id);
  }
  /** What still depends on dispatch or completion before a job runtime can be removed (`trestle jobs migrate`). */
  async migrationInventory(): Promise<{ pending: number; unconsumed: number; dead: number }> {
    const [row] = await this.sql<{ pending: number; unconsumed: number; dead: number }[]>`select
      count(*) filter (where o.status in ('pending','leased'))::int as pending,
      count(*) filter (where o.status = 'succeeded' and o.occurred_at > now() - interval '14 days' and not exists (select 1 from event_inbox i where i.idempotency_key = o.idempotency_key and i.status = 'completed'))::int as unconsumed,
      count(*) filter (where o.status = 'dead')::int as dead
      from outbox_message o`;
    return row!;
  }
  async reject(id: string, reason: string): Promise<void> {
    await this.sql`update outbox_message set status='dead', leased_until=null, last_error=${`rejected:${reason}`.slice(0, 120)} where id=${id} and status in ('pending','leased','succeeded')`;
  }
  async listDead(): Promise<OutboxEntry[]> { return (await this.sql<Row[]>`select * from outbox_message where status='dead' order by available_at,id`).map(entry); }
  async redrive(id: string): Promise<OutboxEntry> { const [row] = await this.sql<Row[]>`update outbox_message set status='pending',available_at=now(),leased_until=null,last_error=null where id=${id} and status='dead' returning *`; if (!row) throw new Error(`Outbox entry ${id} is not dead-lettered`); return entry(row); }
  /**
   * Count succeeded rows a prune at `before` would remove. Rows that in-progress
   * work still references are excluded (see migration 0033), and `before` must be
   * at least EVENT_PROVENANCE_RETENTION_DAYS before `now`.
   */
  async countPrunableSucceeded(before: Date, now: Date = new Date()): Promise<number> {
    assertRetentionCutoff(before, now);
    const [row] = await this.sql<[{ count: number }]>`select trestle_count_prunable_outbox_provenance(${before}) as count`;
    return Number(row?.count ?? 0);
  }
  /** Remove at most `limit` prunable succeeded rows, oldest first. Concurrent prunes skip each other's rows. */
  async pruneSucceeded(before: Date, limit = 1_000, now: Date = new Date()): Promise<number> {
    if (!Number.isFinite(before.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid outbox retention parameters");
    assertRetentionCutoff(before, now);
    const [row] = await this.sql<[{ count: number }]>`select trestle_prune_outbox_provenance(${before}, ${limit}) as count`;
    return Number(row?.count ?? 0);
  }
  /** The processed time of the oldest succeeded row still held, or null when none is. */
  async oldestRetainedSucceeded(): Promise<Date | null> {
    const [row] = await this.sql<[{ oldest: Date | null }]>`select min(processed_at) as oldest from outbox_message where status='succeeded'`;
    return row?.oldest ?? null;
  }
}
