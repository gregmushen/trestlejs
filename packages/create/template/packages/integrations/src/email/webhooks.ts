import { Resend } from "resend";
import { z } from "zod";

const resendEventSchema = z.object({
  type: z.enum(["email.sent", "email.delivered", "email.bounced", "email.complained", "email.failed"]),
  created_at: z.string(),
  data: z.object({ email_id: z.string() }).passthrough(),
}).passthrough();

export type NormalizedEmailDeliveryEvent = {
  id: string;
  emailDeliveryId: string;
  occurredAt: Date;
  status: "accepted" | "delivered" | "bounced" | "complained" | "failed";
};

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
  const event = resendEventSchema.parse(verified);
  const normalized: NormalizedEmailDeliveryEvent = {
    id: input.headers.id,
    emailDeliveryId: event.data.email_id,
    occurredAt: new Date(event.created_at),
    status: event.type === "email.sent" ? "accepted" : event.type.slice("email.".length) as NormalizedEmailDeliveryEvent["status"],
  };
  return normalized;
}
