import { createDatabase, createTenantDatabase, PostgresEventInbox, PostgresOutboxStore, tenantRecord, type Database } from "@__TRESTLE_PROJECT_NAME__/db";
import { dispatchOutbox, type EventEnvelope, type QueuePublisher } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
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

async function countRecords(database: Database, organizationId: string, name: string): Promise<number> {
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

export type ConformanceHarness = Readonly<{
  runtime: JobRuntimeName;
  /** What the outbox dispatcher hands committed events to. */
  publisher: QueuePublisher;
  /** Wait until every accepted run has completed or failed permanently. */
  settle(): Promise<void>;
  /** Permanently failed runs the runtime reports, by event ID. */
  failed(): Promise<string[]>;
  /** Replace the executing code while runs are in flight (a deploy). */
  deploy(version: string): Promise<void>;
  /** Stop and start the executor, keeping accepted work. */
  restart(): Promise<void>;
  close(): Promise<void>;
}>;

export function runtimeConformanceSuite(options: { runtime: JobRuntimeName; connectionString: string | undefined; harness: (connectionString: string) => Promise<ConformanceHarness> }): void {
  const suite = options.connectionString ? describe : describe.skip;
  suite(`${options.runtime} job runtime conformance`, () => {
    const connectionString = options.connectionString!;
    const run = `jc${Date.now().toString(36)}`;
    const organizations = [`${run}-a`, `${run}-b`];
    const database = options.connectionString ? createDatabase(connectionString, "postgres-js") : undefined;
    let harness: ConformanceHarness | undefined;
    const open = async () => (harness ??= await options.harness(connectionString));
    const appended: string[] = [];

    async function commit(organizationId: string, definition: { name: string; schemaVersion: number }, payload: ConformancePayload, occurredAt = new Date()): Promise<EventEnvelope> {
      const outbox = new PostgresOutboxStore(connectionString);
      try {
        const id = crypto.randomUUID();
        const envelope = { id, name: definition.name, schemaVersion: definition.schemaVersion, occurredAt: occurredAt.toISOString(), resource: { type: "conformance", id: payload.tag }, correlationId: `conformance-${id}`, idempotencyKey: `${organizationId}:conformance:${payload.tag}`, payload };
        await outbox.append(envelope, { organizationId });
        appended.push(id);
        return envelope;
      } finally { await outbox.close(); }
    }
    async function dispatch(wrap?: (store: PostgresOutboxStore) => PostgresOutboxStore): Promise<void> {
      const store = new PostgresOutboxStore(connectionString);
      try {
        const target = await open();
        for (let batch = 0; batch < 50; batch++) {
          const result = await dispatchOutbox(wrap ? wrap(store) : store, target.publisher, { leaseMs: 1_000 });
          if (result.sent + result.failed === 0) break;
        }
      } finally { await store.close(); }
    }
    const count = (organizationId: string, name: string) => countRecords(database!, organizationId, name);
    const tag = (label: string) => `${run}-${label}`;

    afterAll(async () => {
      await harness?.close();
      if (!database) return;
      await database.delete(tenantRecord).where(like(tenantRecord.organizationId, `${run}%`));
      await database.$client.end();
    });

    it("runs a committed event exactly once under its tenant", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("ok"), failTimes: 0 });
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("ok")}:v1`)).toBe(1);
      expect(await count(organizations[1]!, `done:${tag("ok")}:v1`)).toBe(0);
    });

    it("retries a transient failure and completes once", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("retry"), failTimes: 2 });
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `attempt:${tag("retry")}`)).toBe(3);
      expect(await count(organizations[0]!, `done:${tag("retry")}:v1`)).toBe(1);
    });

    it("runs a duplicate delivery once", async () => {
      const envelope = await commit(organizations[0]!, conformanceEvent, { tag: tag("duplicate"), failTimes: 0 });
      await dispatch();
      await (await open()).publisher.send(envelope);
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("duplicate")}:v1`)).toBe(1);
    });

    it("resends after a lost dispatch acknowledgement without running twice", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("ack"), failTimes: 0 });
      let lost = false;
      // The runtime accepts the event, but the dispatcher crashes before recording it.
      await dispatch((store) => Object.assign(Object.create(store), { succeed: async (id: string) => { if (!lost) { lost = true; throw new Error("acknowledgement lost"); } await store.succeed(id); } }) as PostgresOutboxStore);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await dispatch();
      await (await open()).settle();
      expect(lost).toBe(true);
      expect(await count(organizations[0]!, `done:${tag("ack")}:v1`)).toBe(1);
    });

    it("skips a handler whose entitlement was revoked before it ran", async () => {
      await database!.insert(tenantRecord).values({ organizationId: organizations[1]!, name: `entitlement:${conformanceEntitlement}` });
      await commit(organizations[1]!, conformanceEntitledEvent, { tag: tag("entitled"), failTimes: 1 });
      await dispatch();
      // The first attempt fails transiently; access is revoked before the retry.
      await database!.delete(tenantRecord).where(and(eq(tenantRecord.organizationId, organizations[1]!), eq(tenantRecord.name, `entitlement:${conformanceEntitlement}`)));
      await (await open()).settle();
      expect(await count(organizations[1]!, `done:${tag("entitled")}:v1`)).toBe(0);
    });

    it("rejects expired provenance permanently without retrying", async () => {
      const envelope = await commit(organizations[0]!, conformanceEvent, { tag: tag("expired"), failTimes: 0 }, new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `attempt:${tag("expired")}`)).toBe(0);
      expect(await (await open()).failed()).toContain(envelope.id);
    });

    it("fans out to several tenants, each under its own authority", async () => {
      for (const organizationId of organizations) await commit(organizationId, conformanceEvent, { tag: tag(`fan-${organizationId}`), failTimes: 0 });
      await dispatch();
      await (await open()).settle();
      for (const organizationId of organizations) {
        expect(await count(organizationId, `done:${tag(`fan-${organizationId}`)}:v1`)).toBe(1);
        expect(await count(organizations.find((other) => other !== organizationId)!, `done:${tag(`fan-${organizationId}`)}:v1`)).toBe(0);
      }
    });

    it("recovers accepted work across an executor restart", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("restart"), failTimes: 1 });
      await dispatch();
      await (await open()).restart();
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("restart")}:v1`)).toBe(1);
    });

    it("runs in-flight work with the newly deployed code", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("deploy"), failTimes: 1 });
      await dispatch();
      await (await open()).deploy("v2");
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("deploy")}:v2`)).toBe(1);
      expect(await count(organizations[0]!, `done:${tag("deploy")}:v1`)).toBe(0);
    });
  });
}
