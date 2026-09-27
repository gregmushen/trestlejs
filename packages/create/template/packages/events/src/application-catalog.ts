import { z } from "zod";

import { defineEvent, defineEventCatalog } from "./catalog.js";

// Application-owned event definitions belong here. Internal events do not
// become customer-visible until they declare an explicit webhook projection.
const billingSubscriptionPayload = z.object({
  organizationId: z.string().min(1),
  plan: z.string().min(1),
  planVersion: z.number().int().positive(),
  status: z.enum(["active", "trialing", "past_due", "cancelled", "incomplete"]),
  entitlements: z.array(z.string().min(1)),
  previousPlan: z.string().min(1).optional(),
  previousStatus: z.string().min(1).optional(),
  cancelAtPeriodEnd: z.boolean(),
  currentPeriodEnd: z.iso.datetime().optional(),
});

function billingSubscriptionEvent(name: string, description: string) {
  return defineEvent({ name, schemaVersion: 1, description,
    resource: { type: "organization", id: (payload: z.infer<typeof billingSubscriptionPayload>) => payload.organizationId },
    payload: billingSubscriptionPayload, sensitivity: "confidential" });
}

export const billingSubscriptionActivatedEvent = billingSubscriptionEvent("billing.subscription.activated", "An organization subscription became active");
export const billingSubscriptionUpdatedEvent = billingSubscriptionEvent("billing.subscription.updated", "An organization subscription changed");
export const billingSubscriptionCancelledEvent = billingSubscriptionEvent("billing.subscription.cancelled", "An organization subscription was cancelled");
export const billingSubscriptionPastDueEvent = billingSubscriptionEvent("billing.subscription.past_due", "An organization subscription became past due");

const billingCheckoutPayload = z.object({ organizationId: z.string().min(1), currentSubscription: z.boolean(),
  paymentStatus: z.enum(["paid", "unpaid", "no_payment_required"]).optional() });
export const billingCheckoutCompletedEvent = defineEvent({ name: "billing.checkout.completed", schemaVersion: 1,
  description: "A verified subscription Checkout session completed", sensitivity: "confidential",
  resource: { type: "organization", id: (payload: z.infer<typeof billingCheckoutPayload>) => payload.organizationId },
  payload: billingCheckoutPayload });

const billingInvoicePayload = z.object({ organizationId: z.string().min(1), currentSubscription: z.boolean(),
  amountMinor: z.number().int(), currency: z.string().regex(/^[a-z]{3}$/u) });
function billingInvoiceEvent(name: string, description: string) {
  return defineEvent({ name, schemaVersion: 1, description, sensitivity: "confidential",
    resource: { type: "organization", id: (payload: z.infer<typeof billingInvoicePayload>) => payload.organizationId },
    payload: billingInvoicePayload });
}
export const billingInvoicePaidEvent = billingInvoiceEvent("billing.invoice.paid", "A subscription invoice was paid");
export const billingInvoicePaymentFailedEvent = billingInvoiceEvent("billing.invoice.payment_failed", "A subscription invoice payment failed");

// Verified Resend delivery outcomes for email sent on behalf of an organization.
// The recipient is identified by a SHA-256 hash of the lowercase address, never the address.
const emailDeliveryPayload = z.object({ organizationId: z.string().min(1), emailDeliveryId: z.string().min(1),
  recipientHash: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  bounceType: z.string().min(1).optional(), bounceSubType: z.string().min(1).optional() });
function emailDeliveryEvent(name: string, description: string) {
  return defineEvent({ name, schemaVersion: 1, description, sensitivity: "confidential",
    resource: { type: "organization", id: (payload: z.infer<typeof emailDeliveryPayload>) => payload.organizationId },
    payload: emailDeliveryPayload });
}
export const emailDeliveredEvent = emailDeliveryEvent("email.delivered", "An email reached the recipient's mail server");
export const emailDeliveryDelayedEvent = emailDeliveryEvent("email.delivery_delayed", "An email delivery was temporarily delayed");
export const emailBouncedEvent = emailDeliveryEvent("email.bounced", "The recipient's mail server rejected an email");
export const emailComplainedEvent = emailDeliveryEvent("email.complained", "The recipient marked an email as spam");
const emailUnsubscribedPayload = z.object({ organizationId: z.string().min(1), recipientHash: z.string().regex(/^[0-9a-f]{64}$/u) });
export const emailUnsubscribedEvent = defineEvent({ name: "email.unsubscribed", schemaVersion: 1, sensitivity: "confidential",
  description: "A recipient unsubscribed from an organization's marketing email with a signed link",
  resource: { type: "organization", id: (payload: z.infer<typeof emailUnsubscribedPayload>) => payload.organizationId },
  payload: emailUnsubscribedPayload });

// Application lifecycle events that email sequences start from. Publish them in
// the same transaction as the change they describe (see createEventPublisher).
const userSignedUpPayload = z.object({ organizationId: z.string().min(1), userId: z.string().min(1) });
export const userSignedUpEvent = defineEvent({ name: "user.signed_up", schemaVersion: 1, sensitivity: "confidential",
  description: "A user signed up and joined an organization",
  resource: { type: "user", id: (payload: z.infer<typeof userSignedUpPayload>) => payload.userId },
  payload: userSignedUpPayload });

// trestle:resource-event-definitions
export const applicationEventCatalog = defineEventCatalog([
  billingSubscriptionActivatedEvent,
  billingSubscriptionUpdatedEvent,
  billingSubscriptionCancelledEvent,
  billingSubscriptionPastDueEvent,
  billingCheckoutCompletedEvent,
  billingInvoicePaidEvent,
  billingInvoicePaymentFailedEvent,
  emailDeliveredEvent,
  emailDeliveryDelayedEvent,
  emailBouncedEvent,
  emailComplainedEvent,
  emailUnsubscribedEvent,
  userSignedUpEvent,
  // trestle:resource-event-list
]);
