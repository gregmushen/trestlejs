import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { emailRecipientHash, recordTenantEmailUnsubscribe } from "./email-delivery.js";
import { createPlatformDatabase, createTenantDatabase } from "./index.js";
import { exitSequenceRunAsOperator, listSequenceRuns, sequenceSummaries } from "./platform-sequences.js";
import { advanceSequenceRun, endSequenceRun, exitSequenceRuns, findSequenceRun, recordSequenceSend, startSequenceRun } from "./sequences.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false }) : undefined;
const organizationIds: string[] = [];

function tenant() {
  const organizationId = `sequence_${crypto.randomUUID().replaceAll("-", "")}`;
  organizationIds.push(organizationId);
  return { organizationId, data: createTenantDatabase(databaseUrl!, "postgres-js", organizationId) };
}
const start = (data: ReturnType<typeof tenant>["data"], organizationId: string, overrides: { sequenceId?: string; userId?: string; triggerEventId?: string; address?: string } = {}) =>
  startSequenceRun(data, { organizationId, sequenceId: overrides.sequenceId ?? "welcome", kind: "marketing", userId: overrides.userId ?? "user-1", address: overrides.address ?? "Person@Example.test",
    triggerEventId: overrides.triggerEventId ?? crypto.randomUUID(), engine: "cloudflare" });

suite("email sequence runs against PostgreSQL", () => {
  afterAll(async () => {
    if (organizationIds.length) {
      await sql!`delete from sequence_run where organization_id = any(${organizationIds})`;
      await sql!`delete from email_suppression where organization_id = any(${organizationIds})`;
      await sql!`delete from outbox_message where organization_id = any(${organizationIds})`;
      await sql!`delete from audit_event where organization_id = any(${organizationIds})`;
    }
    await sql!.end();
  });

  it("starts one active run per sequence, organization and user, and one run per trigger event", async () => {
    const { organizationId, data } = tenant();
    const first = await start(data, organizationId, { triggerEventId: "11111111-1111-4111-8111-111111111111" });
    expect(first).toMatchObject({ created: true, run: { status: "active", currentStep: 0, recipientAddress: "person@example.test", recipientHash: await emailRecipientHash("person@example.test") } });
    // A repeated trigger for the same user finds the active run instead of starting another.
    expect(await start(data, organizationId, { triggerEventId: "22222222-2222-4222-8222-222222222222" })).toMatchObject({ created: false, run: { id: first.run.id } });
    // The same event redelivered after the run ended starts nothing either.
    await endSequenceRun(data, { organizationId, runId: first.run.id, status: "exited", reason: "operator" });
    expect(await start(data, organizationId, { triggerEventId: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ created: false, run: { id: first.run.id, status: "exited" } });
    // A new trigger after the run ended, or another sequence, starts a new run.
    expect((await start(data, organizationId, { triggerEventId: "33333333-3333-4333-8333-333333333333" })).created).toBe(true);
    expect((await start(data, organizationId, { sequenceId: "other" })).created).toBe(true);
    const [row] = await sql!`select count(*)::int as active from sequence_run where organization_id = ${organizationId} and sequence_id = 'welcome' and status = 'active'`;
    expect(row!.active).toBe(1);
  });

  it("records a send and advances the run in one transaction, fenced on the current step", async () => {
    const { organizationId, data } = tenant();
    const { run } = await start(data, organizationId);
    const send = { organizationId, runId: run.id, stepIndex: 0, idempotencyKey: `seq:${run.id}:0`, emailDeliveryId: "email_1", toStep: 1, complete: false };
    expect(await recordSequenceSend(data, send)).toEqual({ recorded: true, advanced: true });
    // A retried step records nothing new and advances nothing.
    expect(await recordSequenceSend(data, send)).toEqual({ recorded: false, advanced: false });
    const wake = new Date(Date.now() + 60_000);
    expect(await advanceSequenceRun(data, { organizationId, runId: run.id, fromStep: 0, toStep: 2, nextAt: wake })).toBe(false);
    expect(await advanceSequenceRun(data, { organizationId, runId: run.id, fromStep: 1, toStep: 2, nextAt: wake })).toBe(true);
    expect(await findSequenceRun(data, organizationId, run.id)).toMatchObject({ currentStep: 2, nextAt: wake });
    expect(await recordSequenceSend(data, { ...send, stepIndex: 2, idempotencyKey: `seq:${run.id}:2`, emailDeliveryId: "email_2", toStep: 3, complete: true })).toEqual({ recorded: true, advanced: true });
    expect(await findSequenceRun(data, organizationId, run.id)).toMatchObject({ status: "completed", currentStep: 3, nextAt: null, exitReason: null });
    expect(await sql!`select step_index, email_delivery_id from sequence_send where run_id = ${run.id} order by step_index`).toEqual([{ step_index: 0, email_delivery_id: "email_1" }, { step_index: 2, email_delivery_id: "email_2" }]);
  });

  it("exits active runs by user, by recipient, or across an organization's sequences", async () => {
    const { organizationId, data } = tenant();
    const alice = await start(data, organizationId, { userId: "alice", address: "alice@example.test" });
    const bob = await start(data, organizationId, { userId: "bob", address: "bob@example.test" });
    const carol = await start(data, organizationId, { userId: "carol", address: "carol@example.test", sequenceId: "receipts" });
    expect((await exitSequenceRuns(data, { organizationId, reason: "billing.subscription.activated", userId: "alice", sequenceIds: ["welcome"] })).map((run) => run.id)).toEqual([alice.run.id]);
    expect(await exitSequenceRuns(data, { organizationId, reason: "email.unsubscribed", recipientHash: await emailRecipientHash("carol@example.test"), kind: "transactional" })).toHaveLength(0);
    expect((await exitSequenceRuns(data, { organizationId, reason: "billing.subscription.activated", sequenceIds: ["welcome", "receipts"] })).map((run) => run.id).sort()).toEqual([bob.run.id, carol.run.id].sort());
    expect(await findSequenceRun(data, organizationId, alice.run.id)).toMatchObject({ status: "exited", exitReason: "billing.subscription.activated", nextAt: null });
    await expect(exitSequenceRuns(data, { organizationId, reason: "x" })).rejects.toThrow(/needs a user, a recipient, or sequences/u);
  });

  it("isolates runs by tenant; the platform role reads them and only exits an active run, audited", async () => {
    const first = tenant();
    const other = tenant();
    const { run } = await start(first.data, first.organizationId);
    expect(await findSequenceRun(other.data, first.organizationId, run.id)).toBeNull();
    expect(await exitSequenceRuns(other.data, { organizationId: other.organizationId, reason: "x", userId: "user-1" })).toEqual([]);
    await expect(start(other.data, first.organizationId)).rejects.toThrow();
    const platform = createPlatformDatabase(databaseUrl!, "postgres-js");
    try {
      const listed = await listSequenceRuns(platform, { organizationId: first.organizationId });
      expect(listed).toEqual([expect.objectContaining({ id: run.id, recipient: "p***@example.test", status: "active", sends: 0 })]);
      expect(JSON.stringify(listed)).not.toContain("person@example.test");
      expect((await sequenceSummaries(platform)).find((summary) => summary.sequenceId === "welcome")?.active).toBeGreaterThanOrEqual(1);
      const change = { actor: { type: "platform_operator" as const, id: "operator-1" }, reason: "customer asked to stop", environment: "local", correlationId: `corr-${run.id}` };
      expect(await exitSequenceRunAsOperator(platform, { runId: run.id }, change)).toMatchObject({ organizationId: first.organizationId, currentStep: 0 });
      await expect(exitSequenceRunAsOperator(platform, { runId: run.id }, change)).rejects.toThrow(/not active/u);
      const [audit] = await sql!`select name, target_type, target_id, reason, summary from audit_event where correlation_id = ${change.correlationId}`;
      expect(audit).toMatchObject({ name: "platform.sequence_run.exited", target_type: "sequence_run", target_id: run.id, reason: "customer asked to stop", summary: { sequenceId: "welcome" } });
      // The platform role never starts, advances, or rewrites a run.
      await expect(sql!.begin(async (transaction) => {
        await transaction`set local role trestle_platform`;
        await transaction`update sequence_run set current_step = 5 where id = ${run.id}`;
      })).rejects.toThrow(/permission denied/u);
      await expect(sql!.begin(async (transaction) => {
        await transaction`set local role trestle_platform`;
        await transaction`insert into sequence_send (run_id, organization_id, step_index, idempotency_key, email_delivery_id) values (${run.id}, ${first.organizationId}, 9, ${`forged-${run.id}`}, 'x')`;
      })).rejects.toThrow(/permission denied/u);
    } finally { await platform.$client.end(); }
  });

  it("records a signed unsubscribe as a suppression and one outbox event, once", async () => {
    const { organizationId, data } = tenant();
    await start(data, organizationId, { address: "Reader@Example.test" });
    const recipientHash = await emailRecipientHash("reader@example.test");
    const input = { databaseUrl: databaseUrl!, driver: "postgres-js" as const, organizationId, recipientHash, correlationId: `corr-${organizationId}` };
    expect(await recordTenantEmailUnsubscribe(input)).toEqual({ found: true, suppressed: true });
    expect(await recordTenantEmailUnsubscribe(input)).toEqual({ found: true, suppressed: false });
    expect(await recordTenantEmailUnsubscribe({ ...input, recipientHash: "b".repeat(64) })).toEqual({ found: false, suppressed: false });
    expect(await sql!`select address, reason from email_suppression where organization_id = ${organizationId}`).toEqual([{ address: "reader@example.test", reason: "unsubscribed" }]);
    const events = await sql!`select event_name, payload from outbox_message where organization_id = ${organizationId}`;
    expect(events).toEqual([{ event_name: "email.unsubscribed", payload: { organizationId, recipientHash } }]);
  });
});
