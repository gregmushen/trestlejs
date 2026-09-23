import { eventEnvelopeSchema, safeErrorCategory, type EventEnvelope, type OutboxEntry, type OutboxStore } from "@__TRESTLE_PROJECT_NAME__/events";
import postgres from "postgres";

type Row = { id: string; event_name: string; schema_version: number; occurred_at: Date; resource_type: string; resource_id: string; correlation_id: string; causation_id: string | null; idempotency_key: string; payload: unknown; status: "pending" | "leased" | "succeeded" | "dead"; attempts: number; available_at: Date; leased_until: Date | null; last_error: string | null };

function entry(row: Row): OutboxEntry {
  return { id: row.id, message: eventEnvelopeSchema.parse({ id: row.id, name: row.event_name, schemaVersion: row.schema_version, occurredAt: row.occurred_at.toISOString(), resource: { type: row.resource_type, id: row.resource_id }, correlationId: row.correlation_id, ...(row.causation_id ? { causationId: row.causation_id } : {}), idempotencyKey: row.idempotency_key, payload: row.payload }), status: row.status, attempts: row.attempts, availableAt: row.available_at, ...(row.leased_until ? { leasedUntil: row.leased_until } : {}), ...(row.last_error ? { lastError: row.last_error } : {}) };
}

export function outboxApplicationConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  const options = url.searchParams.get("options");
  url.searchParams.set("options", [options, "-c role=trestle_app"].filter(Boolean).join(" "));
  return url.toString();
}

export class PostgresOutboxStore implements OutboxStore {
  private readonly sql;
  constructor(connectionString: string, options: { assumeApplicationRole?: boolean } = {}) { this.sql = postgres(options.assumeApplicationRole ? outboxApplicationConnectionString(connectionString) : connectionString, { max: 2, prepare: false }); }
  async close(): Promise<void> { await this.sql.end(); }
  async append(message: EventEnvelope): Promise<OutboxEntry> {
    const parsed = eventEnvelopeSchema.parse(message);
    const [inserted] = await this.sql<Row[]>`insert into outbox_message (id,event_name,schema_version,occurred_at,resource_type,resource_id,correlation_id,causation_id,idempotency_key,payload,available_at) values (${parsed.id},${parsed.name},${parsed.schemaVersion},${new Date(parsed.occurredAt)},${parsed.resource.type},${parsed.resource.id},${parsed.correlationId},${parsed.causationId ?? null},${parsed.idempotencyKey},${JSON.stringify(parsed.payload)},${new Date(parsed.occurredAt)}) on conflict (idempotency_key) do nothing returning *`;
    if (inserted) return entry(inserted);
    const [existing] = await this.sql<Row[]>`select * from outbox_message where idempotency_key=${parsed.idempotencyKey}`;
    if (!existing) throw new Error("Outbox idempotency lookup failed"); return entry(existing);
  }
  async lease(limit = 10, leaseMs = 30_000): Promise<OutboxEntry[]> {
    const rows = await this.sql.begin(async (transaction) => await transaction<Row[]>`with candidates as (select id from outbox_message where (status='pending' and available_at <= now()) or (status='leased' and leased_until <= now()) order by available_at for update skip locked limit ${limit}) update outbox_message set status='leased', leased_until=now()+(${leaseMs} * interval '1 millisecond') from candidates where outbox_message.id=candidates.id returning outbox_message.*`);
    return rows.map(entry);
  }
  async succeed(id: string): Promise<void> { const result = await this.sql`update outbox_message set status='succeeded', leased_until=null, processed_at=now() where id=${id} and status in ('leased','succeeded')`; if (result.count === 0) throw new Error(`Outbox entry ${id} is not leased`); }
  async fail(id: string, error: unknown, maxAttempts = 5): Promise<void> { const category = safeErrorCategory(error); const result = await this.sql`update outbox_message set attempts=attempts+1,last_error=${category},leased_until=null,status=case when attempts+1 >= ${maxAttempts} then 'dead' else 'pending' end,available_at=case when attempts+1 >= ${maxAttempts} then available_at else now()+(power(2,attempts)*interval '1 second') end where id=${id} and status='leased'`; if (result.count === 0) throw new Error(`Outbox entry ${id} is not leased`); }
  async listDead(): Promise<OutboxEntry[]> { return (await this.sql<Row[]>`select * from outbox_message where status='dead' order by available_at,id`).map(entry); }
  async redrive(id: string): Promise<OutboxEntry> { const [row] = await this.sql<Row[]>`update outbox_message set status='pending',available_at=now(),leased_until=null,last_error=null where id=${id} and status='dead' returning *`; if (!row) throw new Error(`Outbox entry ${id} is not dead-lettered`); return entry(row); }
  async countPrunableSucceeded(before: Date): Promise<number> {
    if (!Number.isFinite(before.getTime())) throw new Error("Invalid outbox retention cutoff");
    const [row] = await this.sql<[{ count: string }]>`select count(*)::text as count from outbox_message where status='succeeded' and processed_at < ${before}`;
    return Number(row?.count ?? 0);
  }
  async pruneSucceeded(before: Date, limit = 1_000): Promise<number> {
    if (!Number.isFinite(before.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid outbox retention parameters");
    const result = await this.sql`with candidates as (select id from outbox_message where status='succeeded' and processed_at < ${before} order by processed_at,id limit ${limit} for update skip locked) delete from outbox_message using candidates where outbox_message.id=candidates.id`;
    return result.count;
  }
}
