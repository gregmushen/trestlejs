import { Resend } from "resend";
import { z } from "zod";

const resendEventSchema = z.object({
  type: z.enum(["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed"]),
  created_at: z.string(),
  data: z.object({
    email_id: z.string().min(1),
    // Optional context is read defensively: an unexpected shape never rejects a signed event.
    to: z.unknown().optional(),
    bounce: z.unknown().optional(),
    tags: z.unknown().optional(),
  }).passthrough(),
}).passthrough();

/** The Resend tag the adapter adds to email sent for an organization, returned on delivery webhooks. */
export const RESEND_ORGANIZATION_TAG = "trestle_organization";

export type NormalizedEmailDeliveryEvent = {
  id: string;
  emailDeliveryId: string;
  occurredAt: Date;
  status: "accepted" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed";
};

/** Tenant binding and recipient for a verified event. Kept apart from the
 * delivery record so the recipient is never persisted with it or logged. */
export type EmailDeliveryContext = {
  organizationId?: string;
  recipient?: string;
  bounceType?: string;
  bounceSubType?: string;
};

export function verifiedResendDeliveryContext(verified: unknown): EmailDeliveryContext {
  const { data } = resendEventSchema.parse(verified);
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 320 ? value : undefined;
  const field = (value: unknown, key: string) => value && typeof value === "object" && !Array.isArray(value) ? text((value as Record<string, unknown>)[key]) : undefined;
  const organizationId = field(data.tags, RESEND_ORGANIZATION_TAG);
  // Suppression and recipient hashes apply to single-recipient email only.
  const recipient = Array.isArray(data.to) && data.to.length === 1 ? text(data.to[0]) : undefined;
  const bounceType = field(data.bounce, "type");
  const bounceSubType = field(data.bounce, "subType");
  return {
    ...(organizationId && /^[A-Za-z0-9_-]+$/u.test(organizationId) ? { organizationId } : {}),
    ...(recipient ? { recipient } : {}),
    ...(bounceType ? { bounceType } : {}),
    ...(bounceSubType ? { bounceSubType } : {}),
  };
}

export function normalizeVerifiedResendEvent(verified: unknown, id: string): NormalizedEmailDeliveryEvent {
  const event = resendEventSchema.parse(verified);
  const occurredAt = new Date(event.created_at);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid email webhook timestamp");
  return {
    id,
    emailDeliveryId: event.data.email_id,
    occurredAt,
    status: event.type === "email.sent" ? "accepted" : event.type.slice("email.".length) as NormalizedEmailDeliveryEvent["status"],
  };
}

export async function verifyResendWebhook(input: {
  apiKey: string;
  webhookSecret: string;
  rawBody: string;
  headers: { id: string; timestamp: string; signature: string };
}): Promise<NormalizedEmailDeliveryEvent & { context?: EmailDeliveryContext }> {
  const verified = await new Resend(input.apiKey).webhooks.verify({
    payload: input.rawBody,
    headers: input.headers,
    webhookSecret: input.webhookSecret,
  });
  return { ...normalizeVerifiedResendEvent(verified, input.headers.id), context: verifiedResendDeliveryContext(verified) };
}
