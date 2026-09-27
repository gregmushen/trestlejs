import { createDatabase, emailDeliveryEvent, outboxStatement, PostgresOutboxStore, recordTenantEmailDeliveryEvent, tenantRecord } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, dispatchOutbox, eventEnvelopeSchema, type EventEnvelope, type QueuePublisher } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conformanceEntitledEvent, conformanceEntitlement, conformanceEvent, countRecords, type ConformancePayload } from "./job-conformance.js";
import type { JobRuntimeName } from "./job-runtime.js";

/** The runtime conformance suite (see job-conformance.ts for what each runtime executes). */
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

/**
 * `deploy`: what a runtime does with runs already in flight when new code is
 * deployed. `new-code` (Cloudflare Workflows, Inngest) resumes them on the new
 * code; `pinned` (trigger.dev) finishes each run on the version it started on.
 */
export function runtimeConformanceSuite(options: { runtime: JobRuntimeName; connectionString: string | undefined; harness: (connectionString: string) => Promise<ConformanceHarness>; deploy?: "new-code" | "pinned"; timeoutMs?: number }): void {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const suite = options.connectionString ? describe : describe.skip;
  suite(`${options.runtime} job runtime conformance`, () => {
    const connectionString = options.connectionString!;
    const run = `jc${Date.now().toString(36)}`;
    const organizations = [`${run}-a`, `${run}-b`];
    const database = options.connectionString ? createDatabase(connectionString, "postgres-js") : undefined;
    let harness: ConformanceHarness | undefined;
    const open = async () => (harness ??= await options.harness(connectionString));
    const appended: string[] = [];
    const providerEventIds: string[] = [];
    beforeAll(async () => { if (options.connectionString) await open(); }, Math.max(timeoutMs, 240_000));

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
      if (providerEventIds.length) await database.delete(emailDeliveryEvent).where(inArray(emailDeliveryEvent.id, providerEventIds));
      await database.$client.end();
    });

    it("runs a committed event exactly once under its tenant", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("ok"), failTimes: 0 });
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("ok")}:v1`)).toBe(1);
      expect(await count(organizations[1]!, `done:${tag("ok")}:v1`)).toBe(0);
    }, timeoutMs);

    it("retries a transient failure and completes once", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("retry"), failTimes: 2 });
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `attempt:${tag("retry")}`)).toBe(3);
      expect(await count(organizations[0]!, `done:${tag("retry")}:v1`)).toBe(1);
    }, timeoutMs);

    it("runs a duplicate delivery once", async () => {
      const envelope = await commit(organizations[0]!, conformanceEvent, { tag: tag("duplicate"), failTimes: 0 });
      await dispatch();
      await (await open()).publisher.send(envelope);
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("duplicate")}:v1`)).toBe(1);
    }, timeoutMs);

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
    }, timeoutMs);

    it("skips a handler whose entitlement was revoked before it ran", async () => {
      await database!.insert(tenantRecord).values({ organizationId: organizations[1]!, name: `entitlement:${conformanceEntitlement}` });
      await commit(organizations[1]!, conformanceEntitledEvent, { tag: tag("entitled"), failTimes: 1 });
      await dispatch();
      // The first attempt fails transiently; access is revoked before the retry.
      await database!.delete(tenantRecord).where(and(eq(tenantRecord.organizationId, organizations[1]!), eq(tenantRecord.name, `entitlement:${conformanceEntitlement}`)));
      await (await open()).settle();
      expect(await count(organizations[1]!, `done:${tag("entitled")}:v1`)).toBe(0);
    }, timeoutMs);

    it("rejects expired provenance permanently without retrying", async () => {
      const envelope = await commit(organizations[0]!, conformanceEvent, { tag: tag("expired"), failTimes: 0 }, new Date(Date.now() - 15 * 24 * 60 * 60 * 1000));
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `attempt:${tag("expired")}`)).toBe(0);
      expect(await (await open()).failed()).toContain(envelope.id);
      // Dead-lettered, so settlement never re-dispatches it and `jobs migrate --check` does not wait on it.
      const outbox = new PostgresOutboxStore(connectionString);
      try { expect((await outbox.findCommitted(envelope.id))?.status).toBe("dead"); } finally { await outbox.close(); }
    }, timeoutMs);

    it("fans out to several tenants, each under its own authority", async () => {
      for (const organizationId of organizations) await commit(organizationId, conformanceEvent, { tag: tag(`fan-${organizationId}`), failTimes: 0 });
      await dispatch();
      await (await open()).settle();
      for (const organizationId of organizations) {
        expect(await count(organizationId, `done:${tag(`fan-${organizationId}`)}:v1`)).toBe(1);
        expect(await count(organizations.find((other) => other !== organizationId)!, `done:${tag(`fan-${organizationId}`)}:v1`)).toBe(0);
      }
    }, timeoutMs);

    it("delivers verified Stripe billing and Resend delivery events to their tenant handlers", async () => {
      const stripeEventId = `evt_${tag("stripe").replaceAll("-", "_")}`;
      const resendEventId = `msg_${tag("resend")}`;
      providerEventIds.push(resendEventId);
      // The billing event as applyBillingNotificationEvent commits it for a verified Stripe invoice.
      const payload = applicationEventCatalog.parse("billing.invoice.paid", 1, { organizationId: organizations[0]!, currentSubscription: true, amountMinor: 1200, currency: "usd" });
      const billing = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "billing.invoice.paid", schemaVersion: 1, occurredAt: new Date().toISOString(),
        resource: applicationEventCatalog.resource("billing.invoice.paid", 1, payload), correlationId: stripeEventId, causationId: stripeEventId,
        idempotencyKey: `billing:stripe:${stripeEventId}`, payload });
      await database!.execute(outboxStatement(billing, organizations[0]!));
      // The Resend event through the same producer the verified webhook uses.
      await recordTenantEmailDeliveryEvent({ databaseUrl: connectionString, driver: "postgres-js", organizationId: organizations[1]!, correlationId: resendEventId,
        event: { id: resendEventId, emailDeliveryId: `email_${tag("resend")}`, status: "bounced", occurredAt: new Date() }, bounceType: "Transient" });
      await dispatch();
      await (await open()).settle();
      expect(await count(organizations[0]!, `provider:billing.invoice.paid:${stripeEventId}:v1`)).toBe(1);
      expect(await count(organizations[1]!, `provider:email.bounced:${resendEventId}:v1`)).toBe(1);
      expect(await count(organizations[1]!, `provider:billing.invoice.paid:${stripeEventId}:v1`)).toBe(0);
    }, timeoutMs);

    it("recovers accepted work across an executor restart", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("restart"), failTimes: 1 });
      await dispatch();
      await (await open()).restart();
      await (await open()).settle();
      expect(await count(organizations[0]!, `done:${tag("restart")}:v1`)).toBe(1);
    }, timeoutMs);

    it("completes in-flight work exactly once across a deploy", async () => {
      await commit(organizations[0]!, conformanceEvent, { tag: tag("deploy"), failTimes: 1 });
      await dispatch();
      await (await open()).deploy("v2");
      await (await open()).settle();
      const [v1, v2] = [await count(organizations[0]!, `done:${tag("deploy")}:v1`), await count(organizations[0]!, `done:${tag("deploy")}:v2`)];
      // Either way the run completes exactly once, on one version of the code.
      expect(v1 + v2).toBe(1);
      if ((options.deploy ?? "new-code") === "new-code") expect(v2).toBe(1);
    }, timeoutMs);
  });
}
