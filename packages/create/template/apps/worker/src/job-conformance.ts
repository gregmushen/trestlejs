import { createDatabase, createTenantDatabase, PostgresEventInbox, PostgresOutboxStore, tenantRecord, type Database } from "@__TRESTLE_PROJECT_NAME__/db";
import type { EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { EventConsumerRegistry } from "./async-runtime.js";
import { consumeCommittedEvent, type JobRuntimeName } from "./job-runtime.js";

/**
 * The runtime conformance suite: the guarantees every job runtime must keep,
 * observed only through PostgreSQL so it applies equally to runtimes that
 * execute in this process (Cloudflare's, simulated) and to real engines
 * running elsewhere (trigger.dev, Inngest). A runtime is supported only when
 * this suite passes against it.
 */
export const conformanceEvent = { name: "trestle.conformance.probe", schemaVersion: 1 } as const;
export const conformanceEntitledEvent = { name: "trestle.conformance.entitled", schemaVersion: 1 } as const;
const payloadSchema = z.object({ tag: z.string().min(1), failTimes: z.number().int().min(0).default(0) });
export type ConformancePayload = z.infer<typeof payloadSchema>;
export const conformanceEntitlement = "conformance.probe";

export async function countRecords(database: Database, organizationId: string, name: string): Promise<number> {
  return (await database.select({ id: tenantRecord.id }).from(tenantRecord).where(and(eq(tenantRecord.organizationId, organizationId), eq(tenantRecord.name, name)))).length;
}

/**
 * The consumers every runtime executes. Each attempt and each completion is a
 * tenant row written through the handler's tenant-scoped database, so the
 * assertions also prove tenant authority. `failTimes` makes the first
 * attempts fail transiently. The entitlement is read from current database
 * state on every execution.
 */
export function conformanceRegistry(connectionString: string, version = "v1"): EventConsumerRegistry<unknown, Database> {
  const registry = new EventConsumerRegistry<unknown, Database>(undefined, {
    tenantData: (_environment, organizationId) => createTenantDatabase(connectionString, "postgres-js", organizationId),
    closeTenantData: async (data) => { await data.$client.end(); },
    hasEntitlement: async (_environment, organizationId, entitlement) => {
      const database = createDatabase(connectionString, "postgres-js");
      try { return await countRecords(database, organizationId, `entitlement:${entitlement}`) > 0; }
      finally { await database.$client.end(); }
    },
  });
  const handler = async (payload: ConformancePayload, _envelope: EventEnvelope, _environment: unknown, context: { organizationId?: string; data?: Database }) => {
    const data = context.data!;
    await data.insert(tenantRecord).values({ organizationId: context.organizationId!, name: `attempt:${payload.tag}` });
    if (await countRecords(data, context.organizationId!, `attempt:${payload.tag}`) <= payload.failTimes) throw new Error("transient conformance failure");
    await data.insert(tenantRecord).values({ organizationId: context.organizationId!, name: `done:${payload.tag}:${version}` });
  };
  registry.register({ ...conformanceEvent, parse: (payload) => payloadSchema.parse(payload) }, handler, { authority: "tenant" });
  registry.register({ ...conformanceEntitledEvent, parse: (payload) => payloadSchema.parse(payload) }, handler, { authority: "tenant", requires: { entitlement: conformanceEntitlement } });
  return registry;
}

/** One execution of a delivered event: what each runtime's step or task body runs. */
export async function executeConformanceEvent(input: { connectionString: string; envelope: EventEnvelope; runId: string; runtime: JobRuntimeName; permanent: (message: string) => Error; registry?: EventConsumerRegistry<unknown, Database> }): Promise<void> {
  const inbox = new PostgresEventInbox(input.connectionString);
  const outbox = new PostgresOutboxStore(input.connectionString);
  const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } } as never;
  try {
    await consumeCommittedEvent({ registry: input.registry ?? conformanceRegistry(input.connectionString), inbox, outbox, envelope: input.envelope, environment: {}, runId: input.runId, runtime: input.runtime, log: quiet, permanent: input.permanent });
  } finally {
    await Promise.all([inbox.close(), outbox.close()]);
  }
}

