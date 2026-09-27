import { and, count, desc, eq, gte, max, sql } from "drizzle-orm";

import { recordAuditEvent } from "./audit.js";
import { emailRecipientHash, normalizeEmailAddress } from "./email-delivery.js";
import { emailDeliveryEvent, emailSuppression } from "./email-schema.js";
import type { Database } from "./index.js";
import { PlatformOperationError } from "./platform-operations.js";
import type { PlatformChangeContext } from "./platform-roles.js";
import { organization } from "./auth-schema.js";

/** Delivery statuses the deliverability summary counts. */
export const deliverabilityStatuses = ["delivered", "delivery_delayed", "bounced", "complained"] as const;

export type EmailDeliverabilitySummary = Readonly<{
  lastReceivedAt: Date | null;
  last24h: Readonly<Record<(typeof deliverabilityStatuses)[number], number>>;
  last7d: Readonly<Record<(typeof deliverabilityStatuses)[number], number>>;
}>;

/** Counts of verified provider events by status over the last day and week, and when the last one arrived. */
export async function emailDeliverabilitySummary(database: Database, now = new Date()): Promise<EmailDeliverabilitySummary> {
  const window = async (since: Date) => {
    const rows = await database.select({ status: emailDeliveryEvent.status, total: count() }).from(emailDeliveryEvent)
      .where(gte(emailDeliveryEvent.receivedAt, since)).groupBy(emailDeliveryEvent.status);
    return Object.fromEntries(deliverabilityStatuses.map((status) => [status, Number(rows.find((row) => row.status === status)?.total ?? 0)])) as Record<(typeof deliverabilityStatuses)[number], number>;
  };
  const [last24h, last7d, [latest]] = await Promise.all([
    window(new Date(now.getTime() - 86_400_000)), window(new Date(now.getTime() - 7 * 86_400_000)),
    database.select({ at: max(emailDeliveryEvent.receivedAt) }).from(emailDeliveryEvent),
  ]);
  return { lastReceivedAt: latest?.at ? new Date(latest.at) : null, last24h, last7d };
}

export type PlatformEmailSuppression = Readonly<{ organizationId: string; organizationName: string | null; address: string; reason: string; sourceEventId: string | null; createdAt: Date }>;

/** Shows the first character and the domain: enough to recognize an address, not to harvest it. */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

/**
 * Suppressions across organizations, newest first. `address` matches exactly
 * (normalized); results carry the masked address only.
 */
export async function listEmailSuppressions(database: Database, options: Readonly<{ organizationId?: string; address?: string; limit?: number }> = {}): Promise<PlatformEmailSuppression[]> {
  const filters = [
    options.organizationId ? eq(emailSuppression.organizationId, options.organizationId) : undefined,
    options.address ? eq(emailSuppression.address, normalizeEmailAddress(options.address)) : undefined,
  ].filter((value) => value !== undefined);
  const rows = await database.select({ organizationId: emailSuppression.organizationId, organizationName: organization.name, address: emailSuppression.address,
    reason: emailSuppression.reason, sourceEventId: emailSuppression.sourceEventId, createdAt: emailSuppression.createdAt })
    .from(emailSuppression).leftJoin(organization, eq(organization.id, emailSuppression.organizationId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(emailSuppression.createdAt)).limit(Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500));
  return rows.map((row) => ({ ...row, address: maskEmailAddress(row.address) }));
}

/**
 * Removes one organization's suppression of an address. The audit event, which
 * identifies the recipient only by hash, commits in the same transaction.
 */
export async function removeEmailSuppression(database: Database, input: Readonly<{ organizationId: string; address: string }>, context: PlatformChangeContext): Promise<{ reason: string }> {
  const reason = context.reason.trim();
  if (!reason || reason.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  const address = normalizeEmailAddress(input.address);
  if (!input.organizationId || !address.includes("@")) throw new PlatformOperationError("invalid", "Choose an organization and an email address");
  return await database.transaction(async (transaction) => {
    const [removed] = await transaction.delete(emailSuppression)
      .where(and(eq(emailSuppression.organizationId, input.organizationId), eq(emailSuppression.address, address)))
      .returning();
    if (!removed) throw new PlatformOperationError("not_found", "That address is not suppressed for this organization");
    await recordAuditEvent(transaction, {
      actor: context.actor, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}),
      name: "platform.email_suppression.removed", organizationId: input.organizationId,
      target: { type: "email_suppression", id: await emailRecipientHash(address) },
      reason, summary: { suppressionReason: removed.reason, sourceEventId: removed.sourceEventId },
    });
    return { reason: removed.reason };
  });
}

export const emailSuppressionCount = async (database: Database): Promise<number> =>
  Number((await database.select({ total: sql<number>`count(*)` }).from(emailSuppression))[0]?.total ?? 0);
