import { Resend } from "resend";
import { z } from "zod";

const resendEventSchema = z.object({
  type: z.enum(["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed"]),
  created_at: z.string(),
  data: z.object({ email_id: z.string().min(1) }).passthrough(),
}).passthrough();

export type NormalizedEmailDeliveryEvent = {
  id: string;
  emailDeliveryId: string;
  occurredAt: Date;
  status: "accepted" | "delivered" | "bounced" | "complained" | "failed";
};

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
}): Promise<NormalizedEmailDeliveryEvent> {
  const verified = await new Resend(input.apiKey).webhooks.verify({
    payload: input.rawBody,
    headers: input.headers,
    webhookSecret: input.webhookSecret,
  });
  return normalizeVerifiedResendEvent(verified, input.headers.id);
}
