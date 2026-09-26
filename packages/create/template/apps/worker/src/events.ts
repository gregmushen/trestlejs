import { outboxStatement } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, eventEnvelopeSchema, type defineEventCatalog } from "@__TRESTLE_PROJECT_NAME__/events";
import type { SQL } from "drizzle-orm";

type Catalog = ReturnType<typeof defineEventCatalog>;

export type EventPublisher = Readonly<{
  /** Execute this statement inside the same `ctx.data.transaction` as the
   * domain mutation. The statement alone does not commit or publish. */
  statement(name: string, payload: unknown, options: { schemaVersion?: number; idempotencyKey: string; causationId?: string }): SQL;
}>;

const statementCounts = new WeakMap<EventPublisher, () => number>();

/** How many outbox statements a publisher has produced. After the work that
 * executed them commits, a nonzero count means outbox dispatch should wake. */
export function eventStatementCount(publisher: EventPublisher): number {
  return statementCounts.get(publisher)?.() ?? 0;
}

/** A tenant-bound, catalog-validated source of transactional outbox inserts.
 * Queue publishing happens only after the resulting transaction commits. */
export function createEventPublisher(input: {
  organizationId: string;
  correlationId: string;
  catalog?: Catalog;
  clock?: { now(): Date };
}): EventPublisher {
  const catalog = input.catalog ?? applicationEventCatalog;
  if (!/^[A-Za-z0-9_-]+$/u.test(input.organizationId)) throw new Error("Invalid event organization identifier");
  if (!input.correlationId.trim()) throw new Error("Event correlation identifier is required");
  let produced = 0;
  const publisher: EventPublisher = {
    statement(name, payload, options) {
      if (!options.idempotencyKey || options.idempotencyKey !== options.idempotencyKey.trim() || options.idempotencyKey.length > 256) {
        throw new Error("Event idempotency key must be trimmed and at most 256 characters");
      }
      const schemaVersion = options.schemaVersion ?? 1;
      if (!catalog.has(name, schemaVersion)) throw new Error(`Internal event ${name}@${schemaVersion} is not registered`);
      const parsed = catalog.parse(name, schemaVersion, payload);
      const resource = catalog.resource(name, schemaVersion, parsed);
      const envelope = eventEnvelopeSchema.parse({
        id: crypto.randomUUID(),
        name,
        schemaVersion,
        occurredAt: (input.clock?.now() ?? new Date()).toISOString(),
        resource,
        correlationId: input.correlationId,
        ...(options.causationId ? { causationId: options.causationId } : {}),
        idempotencyKey: `${input.organizationId}:${options.idempotencyKey}`,
        payload: parsed,
      });
      const statement = outboxStatement(envelope, input.organizationId);
      produced += 1;
      return statement;
    },
  };
  statementCounts.set(publisher, () => produced);
  return publisher;
}
