import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { emailRecipientHash, isSuppressed, recordTenantEmailDeliveryEvent, suppressEmailAddress } from "./email-delivery.js";
import { createTenantDatabase } from "./index.js";

const databaseUrl = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, prepare: false }) : undefined;
const organizationIds: string[] = [];
const eventIds: string[] = [];

function fixture(status: string, overrides: { recipient?: string; bounceType?: string; organizationId?: string } = {}) {
  const organizationId = overrides.organizationId ?? `email_delivery_${crypto.randomUUID().replaceAll("-", "")}`;
  const id = `msg_${crypto.randomUUID()}`;
  organizationIds.push(organizationId);
  eventIds.push(id);
  return { databaseUrl: databaseUrl!, driver: "postgres-js" as const, organizationId, correlationId: `corr_${id}`,
    event: { id, emailDeliveryId: `email_${crypto.randomUUID()}`, status, occurredAt: new Date() },
    ...(overrides.recipient ? { recipient: overrides.recipient } : {}), ...(overrides.bounceType ? { bounceType: overrides.bounceType } : {}) };
}

suite("Resend delivery events against PostgreSQL", () => {
  afterAll(async () => {
    if (eventIds.length) {
      await sql!`delete from outbox_message where idempotency_key = any(${eventIds.map((id) => `email:resend:${id}`)})`;
      await sql!`delete from email_delivery_event where id = any(${eventIds})`;
    }
    if (organizationIds.length) await sql!`delete from email_suppression where organization_id = any(${organizationIds})`;
    await sql!.end();
  });

  it("commits the receipt, the tenant outbox event and a hard-bounce suppression together, once", async () => {
    const input = fixture("bounced", { recipient: "Person@Example.test", bounceType: "Permanent" });
    expect(await recordTenantEmailDeliveryEvent(input)).toEqual({ duplicate: false, published: true, suppressed: true });
    const [outbox] = await sql!`select event_name, organization_id, resource_id, causation_id, payload from outbox_message where idempotency_key=${`email:resend:${input.event.id}`}`;
    expect(outbox).toMatchObject({ event_name: "email.bounced", organization_id: input.organizationId, resource_id: input.organizationId, causation_id: input.event.id,
      payload: { organizationId: input.organizationId, emailDeliveryId: input.event.emailDeliveryId, recipientHash: await emailRecipientHash("person@example.test"), bounceType: "Permanent" } });
    expect(JSON.stringify(outbox?.payload).toLowerCase()).not.toContain("person@example.test");
    expect(await sql!`select address, reason, source_event_id from email_suppression where organization_id=${input.organizationId}`)
      .toEqual([{ address: "person@example.test", reason: "bounced", source_event_id: input.event.id }]);
    expect(await recordTenantEmailDeliveryEvent(input)).toEqual({ duplicate: true, published: false, suppressed: false });
    expect(await sql!`select id from outbox_message where idempotency_key=${`email:resend:${input.event.id}`}`).toHaveLength(1);
  });

  it("publishes soft bounces and delays without suppressing, and suppresses complaints", async () => {
    const transient = fixture("bounced", { recipient: "soft@example.test", bounceType: "Transient" });
    expect(await recordTenantEmailDeliveryEvent(transient)).toEqual({ duplicate: false, published: true, suppressed: false });
    const delayed = fixture("delivery_delayed", { recipient: "late@example.test", organizationId: transient.organizationId });
    expect(await recordTenantEmailDeliveryEvent(delayed)).toMatchObject({ published: true, suppressed: false });
    const complained = fixture("complained", { recipient: "spam@example.test", organizationId: transient.organizationId });
    expect(await recordTenantEmailDeliveryEvent(complained)).toMatchObject({ published: true, suppressed: true });
    const sent = fixture("accepted", { organizationId: transient.organizationId });
    expect(await recordTenantEmailDeliveryEvent(sent)).toEqual({ duplicate: false, published: false, suppressed: false });
    const database = createTenantDatabase(databaseUrl!, "postgres-js", transient.organizationId);
    expect(await isSuppressed(database, transient.organizationId, "SPAM@example.test")).toBe(true);
    expect(await isSuppressed(database, transient.organizationId, "soft@example.test")).toBe(false);
    expect((await sql!`select event_name from outbox_message where idempotency_key = any(${[delayed, sent].map((value) => `email:resend:${value.event.id}`)})`).map((row) => row.event_name)).toEqual(["email.delivery_delayed"]);
  });

  it("keeps suppressions tenant-scoped under row-level security", async () => {
    const first = fixture("complained", { recipient: "shared@example.test" });
    await recordTenantEmailDeliveryEvent(first);
    const otherId = `email_delivery_${crypto.randomUUID().replaceAll("-", "")}`;
    organizationIds.push(otherId);
    const other = createTenantDatabase(databaseUrl!, "postgres-js", otherId);
    // Another tenant neither sees the first tenant's suppression nor can write one for it.
    expect(await isSuppressed(other, first.organizationId, "shared@example.test")).toBe(false);
    await expect(suppressEmailAddress(other, first.organizationId, "x@example.test", "unsubscribed")).rejects.toThrow();
    await suppressEmailAddress(other, otherId, "Shared@Example.test", "unsubscribed");
    expect(await isSuppressed(other, otherId, "shared@example.test")).toBe(true);
  });
});
