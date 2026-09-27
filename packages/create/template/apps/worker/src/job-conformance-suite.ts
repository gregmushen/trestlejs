import { createDatabase, emailDeliveryEvent, emailSuppression, member, organization, outboxStatement, PostgresOutboxStore, recordTenantEmailDeliveryEvent, sequenceRun, sequenceSend, tenantRecord, user } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEventCatalog, dispatchOutbox, eventEnvelopeSchema, type EventEnvelope, type QueuePublisher } from "@__TRESTLE_PROJECT_NAME__/events";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conformanceEntitledEvent, conformanceEntitlement, conformanceEvent, conformanceSequenceExit, conformanceSequenceStart, countRecords, type ConformancePayload, type ConformanceSequencePayload } from "./job-conformance.js";
import { startRecordedResend } from "./job-conformance-resend.js";
import type { JobRuntimeName } from "./job-runtime.js";

/** The runtime conformance suite (see job-conformance.ts for what each runtime executes). */
export type ConformanceHarness = Readonly<{
  runtime: JobRuntimeName;
  /** What the outbox dispatcher hands committed events to. */
  publisher: QueuePublisher;
  /** Wait until every accepted run has completed or failed permanently. */
  settle(): Promise<void>;
  /** Wait until every sequence run the engine accepted has ended (completed, failed, or cancelled). */
  settleSequences(): Promise<void>;
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
    let resend: Awaited<ReturnType<typeof startRecordedResend>> | undefined;
    beforeAll(async () => {
      if (!options.connectionString) return;
      // Every executor, in this process or a child, sends sequence email to the recorded fake.
      resend = await startRecordedResend();
      process.env.TRESTLE_CONFORMANCE_RESEND_URL = resend.url;
      await open();
    }, Math.max(timeoutMs, 240_000));

    async function commit(organizationId: string, definition: { name: string; schemaVersion: number }, payload: ConformancePayload | (Readonly<Record<string, unknown>> & { tag: string }), occurredAt = new Date()): Promise<EventEnvelope> {
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
      await resend?.close();
      if (!database) return;
      await database.delete(sequenceRun).where(like(sequenceRun.organizationId, `${run}%`));
      await database.delete(emailSuppression).where(like(emailSuppression.organizationId, `${run}%`));
      await database.delete(organization).where(like(organization.id, `${run}%`));
      await database.delete(user).where(like(user.id, `${run}%`));
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

    // Email sequences: a member of a real organization, sending through the recorded Resend fake.
    const sequenceOrganization = `${run}-s`;
    const sequenceTimeoutMs = timeoutMs + 120_000;
    async function sequenceMember(label: string, address = `${label}.${run}@example.test`): Promise<{ userId: string; address: string }> {
      if (!(await database!.select({ id: organization.id }).from(organization).where(eq(organization.id, sequenceOrganization))).length) {
        await database!.insert(organization).values({ id: sequenceOrganization, name: "Sequence conformance", slug: sequenceOrganization, createdAt: new Date() });
      }
      const userId = `${run}-${label}`;
      await database!.insert(user).values({ id: userId, name: label, email: address, emailVerified: true });
      await database!.insert(member).values({ id: `${userId}-member`, organizationId: sequenceOrganization, userId, role: "member", createdAt: new Date() });
      return { userId, address };
    }
    async function startSequence(label: string, sequence: ConformanceSequencePayload["sequence"], recipient: { userId: string; address: string }): Promise<void> {
      await commit(sequenceOrganization, conformanceSequenceStart, { tag: tag(`sequence-${label}`), sequence, ...recipient });
      await dispatch();
      await (await open()).settle();
    }
    const sequenceRunFor = async (userId: string) => (await database!.select().from(sequenceRun).where(and(eq(sequenceRun.organizationId, sequenceOrganization), eq(sequenceRun.userId, userId))))[0];
    const sendsFor = async (runId: string) => (await database!.select({ step: sequenceSend.stepIndex }).from(sequenceSend).where(eq(sequenceSend.runId, runId))).map((row) => row.step).sort();
    async function until(condition: () => Promise<boolean>, what: string, limitMs = sequenceTimeoutMs - 10_000): Promise<void> {
      for (const started = Date.now(); !await condition(); await new Promise((resolve) => setTimeout(resolve, 250))) {
        if (Date.now() - started > limitMs) throw new Error(`Timed out waiting for ${what}`);
      }
    }

    it("waits, then sends each step once with one-click unsubscribe headers", async () => {
      const recipient = await sequenceMember("drip");
      await startSequence("drip", "short", recipient);
      await (await open()).settleSequences();
      const sequenceRow = await sequenceRunFor(recipient.userId);
      expect(sequenceRow).toMatchObject({ sequenceId: "conformance-short", status: "completed", exitReason: null });
      expect(await sendsFor(sequenceRow!.id)).toEqual([0, 2]);
      const emails = resend!.emails(recipient.address);
      expect(emails.map((email) => [email.subject, email.idempotencyKey])).toEqual([["first", `seq:${sequenceRow!.id}:0`], ["second", `seq:${sequenceRow!.id}:2`]]);
      // The wait held the second send back.
      expect(emails[1]!.receivedAt - emails[0]!.receivedAt).toBeGreaterThanOrEqual(1_900);
      expect(emails[0]!.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "List-Unsubscribe": expect.stringMatching(/^<https:\/\/conformance\.example\.test\/api\/email\/unsubscribe\?token=[A-Za-z0-9_.-]+>$/u) });
    }, sequenceTimeoutMs);

    it("exits a sequence during its wait and never sends the next step", async () => {
      const recipient = await sequenceMember("exit");
      await startSequence("exit", "long", recipient);
      await until(async () => resend!.emails(recipient.address).length >= 1, "the first send");
      const waiting = await sequenceRunFor(recipient.userId);
      expect(waiting).toMatchObject({ status: "active", currentStep: 2 });
      await commit(sequenceOrganization, conformanceSequenceExit, { tag: tag("sequence-exit-event"), userId: recipient.userId });
      await dispatch();
      await (await open()).settle();
      expect(await sequenceRunFor(recipient.userId)).toMatchObject({ status: "exited", exitReason: conformanceSequenceExit.name, nextAt: null });
      await (await open()).settleSequences();
      // Whether or not the engine's run was cancelled, nothing is sent after the wake time.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, waiting!.nextAt!.getTime() - Date.now()) + 1_500));
      expect(resend!.emails(recipient.address).map((email) => email.subject)).toEqual(["first"]);
      expect(await sendsFor(waiting!.id)).toEqual([0]);
    }, sequenceTimeoutMs);

    it("checks suppression before a send and exits a suppressed recipient's marketing run", async () => {
      const recipient = await sequenceMember("suppressed");
      await database!.insert(emailSuppression).values({ organizationId: sequenceOrganization, address: recipient.address, reason: "unsubscribed" });
      await startSequence("suppressed", "short", recipient);
      await (await open()).settleSequences();
      const sequenceRow = await sequenceRunFor(recipient.userId);
      expect(sequenceRow).toMatchObject({ status: "exited", exitReason: "suppressed" });
      expect(await sendsFor(sequenceRow!.id)).toEqual([]);
      expect(resend!.emails(recipient.address)).toEqual([]);
    }, sequenceTimeoutMs);

    it("ends a run permanently when the user's membership is revoked between steps", async () => {
      const recipient = await sequenceMember("revoked");
      await startSequence("revoked", "long", recipient);
      await until(async () => resend!.emails(recipient.address).length >= 1, "the first send");
      await database!.delete(member).where(eq(member.userId, recipient.userId));
      await (await open()).settleSequences();
      const sequenceRow = await sequenceRunFor(recipient.userId);
      expect(sequenceRow).toMatchObject({ status: "failed", exitReason: "not_member" });
      expect(await sendsFor(sequenceRow!.id)).toEqual([0]);
      expect(resend!.emails(recipient.address).map((email) => email.subject)).toEqual(["first"]);
    }, sequenceTimeoutMs);

    it("does not duplicate a send whose response was lost and retried", async () => {
      const recipient = await sequenceMember("retried", `retried+drop.${run}@example.test`);
      await startSequence("retried", "short", recipient);
      await (await open()).settleSequences();
      const sequenceRow = await sequenceRunFor(recipient.userId);
      expect(sequenceRow).toMatchObject({ status: "completed" });
      // Resend accepted the first request, the response was lost, and the retry carried the same key.
      expect(resend!.requests(`seq:${sequenceRow!.id}:0`)).toBeGreaterThanOrEqual(2);
      expect(resend!.emails(recipient.address).map((email) => email.subject)).toEqual(["first", "second"]);
      expect(await sendsFor(sequenceRow!.id)).toEqual([0, 2]);
    }, sequenceTimeoutMs);
  });
}
