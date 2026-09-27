import { and, eq, sql } from "drizzle-orm";
import { applicationEventCatalog, eventEnvelopeSchema } from "@__TRESTLE_PROJECT_NAME__/events";

import { emailDeliveryEvent, emailSuppression } from "./email-schema.js";
import { createTenantDatabase, type Database, type DatabaseDriver } from "./index.js";
import { outboxStatement } from "./outbox.js";
import { sequenceRun } from "./sequence-schema.js";

export type EmailSuppressionReason = "unsubscribed" | "bounced" | "complained";

/** Delivery statuses published to the outbox as `email.<status>` application events. */
const publishedStatuses = new Set(["delivered", "delivery_delayed", "bounced", "complained"]);

export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Events identify a recipient by this hash; the address itself stays in the suppression table. */
export async function emailRecipientHash(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeEmailAddress(address)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Record one verified provider delivery event for an organization. The receipt,
 * the outbox event and any suppression commit in one tenant transaction; the
 * receipt's primary key (the provider event ID) makes redelivery a no-op.
 * Only permanent bounces and complaints suppress the address.
 */
export async function recordTenantEmailDeliveryEvent(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  organizationId: string;
  event: { id: string; emailDeliveryId: string; status: string; occurredAt: Date };
  recipient?: string;
  bounceType?: string;
  bounceSubType?: string;
  correlationId: string;
}): Promise<{ duplicate: boolean; published: boolean; suppressed: boolean }> {
  if (!/^[A-Za-z0-9_-]+$/u.test(input.organizationId)) throw new Error("Invalid email delivery organization identifier");
  if (!input.event.id || !input.event.emailDeliveryId || !Number.isFinite(input.event.occurredAt.getTime())) throw new Error("Invalid email delivery identity");
  const database = createTenantDatabase(input.databaseUrl, input.driver, input.organizationId);
  return await database.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.organization_id', ${input.organizationId}, true)`);
    const inserted = await transaction.insert(emailDeliveryEvent).values({ id: input.event.id, emailDeliveryId: input.event.emailDeliveryId,
      status: input.event.status, occurredAt: input.event.occurredAt, organizationId: input.organizationId,
      ...(input.bounceType ? { bounceType: input.bounceType.slice(0, 64) } : {}), ...(input.bounceSubType ? { bounceSubType: input.bounceSubType.slice(0, 64) } : {}) }).onConflictDoNothing().returning();
    if (inserted.length === 0) return { duplicate: true, published: false, suppressed: false };
    const published = publishedStatuses.has(input.event.status);
    if (published) {
      const name = `email.${input.event.status}`;
      const payload = applicationEventCatalog.parse(name, 1, { organizationId: input.organizationId, emailDeliveryId: input.event.emailDeliveryId,
        ...(input.recipient ? { recipientHash: await emailRecipientHash(input.recipient) } : {}),
        ...(input.bounceType ? { bounceType: input.bounceType } : {}), ...(input.bounceSubType ? { bounceSubType: input.bounceSubType } : {}) });
      const envelope = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name, schemaVersion: 1,
        occurredAt: input.event.occurredAt.toISOString(), resource: applicationEventCatalog.resource(name, 1, payload),
        correlationId: input.correlationId, causationId: input.event.id,
        idempotencyKey: `email:resend:${input.event.id}`, payload });
      await transaction.execute(outboxStatement(envelope, input.organizationId));
    }
    const reason = input.event.status === "complained" ? "complained" : input.event.status === "bounced" && input.bounceType === "Permanent" ? "bounced" : null;
    if (!reason || !input.recipient) return { duplicate: false, published, suppressed: false };
    await transaction.insert(emailSuppression).values({ organizationId: input.organizationId, address: normalizeEmailAddress(input.recipient),
      reason, sourceEventId: input.event.id }).onConflictDoNothing();
    return { duplicate: false, published, suppressed: true };
  });
}

/** Whether the organization must not email this address. */
export async function isSuppressed(database: Database, organizationId: string, address: string): Promise<boolean> {
  const [row] = await database.select({ reason: emailSuppression.reason }).from(emailSuppression)
    .where(and(eq(emailSuppression.organizationId, organizationId), eq(emailSuppression.address, normalizeEmailAddress(address)))).limit(1);
  return Boolean(row);
}

/** Why the organization must not email this address, or null when it may. */
export async function emailSuppressionReason(database: Database, organizationId: string, address: string): Promise<EmailSuppressionReason | null> {
  const [row] = await database.select({ reason: emailSuppression.reason }).from(emailSuppression)
    .where(and(eq(emailSuppression.organizationId, organizationId), eq(emailSuppression.address, normalizeEmailAddress(address)))).limit(1);
  return (row?.reason as EmailSuppressionReason | undefined) ?? null;
}

/**
 * A verified one-click unsubscribe for a recipient an organization's email
 * sequences wrote to. The suppression and the `email.unsubscribed` outbox
 * event commit in one tenant transaction; the event's consumer exits the
 * recipient's marketing sequence runs. Repeating it changes nothing. Returns
 * `found: false` when no sequence of the organization knows the recipient.
 */
export async function recordTenantEmailUnsubscribe(input: {
  databaseUrl: string;
  driver?: DatabaseDriver;
  organizationId: string;
  recipientHash: string;
  correlationId: string;
  now?: Date;
}): Promise<{ found: boolean; suppressed: boolean }> {
  if (!/^[A-Za-z0-9_-]+$/u.test(input.organizationId)) throw new Error("Invalid unsubscribe organization identifier");
  if (!/^[0-9a-f]{64}$/u.test(input.recipientHash)) throw new Error("Invalid unsubscribe recipient");
  const database = createTenantDatabase(input.databaseUrl, input.driver, input.organizationId);
  return await database.transaction(async (transaction) => {
    await transaction.execute(sql`select set_config('app.organization_id', ${input.organizationId}, true)`);
    const [run] = await transaction.select({ address: sequenceRun.recipientAddress }).from(sequenceRun)
      .where(and(eq(sequenceRun.organizationId, input.organizationId), eq(sequenceRun.recipientHash, input.recipientHash))).limit(1);
    if (!run) return { found: false, suppressed: false };
    const inserted = await transaction.insert(emailSuppression).values({ organizationId: input.organizationId, address: run.address, reason: "unsubscribed" }).onConflictDoNothing().returning();
    const payload = applicationEventCatalog.parse("email.unsubscribed", 1, { organizationId: input.organizationId, recipientHash: input.recipientHash });
    const envelope = eventEnvelopeSchema.parse({ id: crypto.randomUUID(), name: "email.unsubscribed", schemaVersion: 1,
      occurredAt: (input.now ?? new Date()).toISOString(), resource: applicationEventCatalog.resource("email.unsubscribed", 1, payload),
      correlationId: input.correlationId, idempotencyKey: `${input.organizationId}:email:unsubscribed:${input.recipientHash}`, payload });
    // One event per recipient: a second unsubscribe (or a mail client's retry) adds nothing.
    await transaction.execute(outboxStatement(envelope, input.organizationId));
    return { found: true, suppressed: inserted.length > 0 };
  });
}

/** Record an unsubscribe; an existing suppression for the address is kept. */
export async function suppressEmailAddress(database: Database, organizationId: string, address: string, reason: EmailSuppressionReason, sourceEventId?: string): Promise<void> {
  await database.insert(emailSuppression).values({ organizationId, address: normalizeEmailAddress(address), reason, ...(sourceEventId ? { sourceEventId } : {}) }).onConflictDoNothing();
}
