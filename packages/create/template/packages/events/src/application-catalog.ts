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

// trestle:resource-event-definitions
export const applicationEventCatalog = defineEventCatalog([
  billingSubscriptionActivatedEvent,
  billingSubscriptionUpdatedEvent,
  billingSubscriptionCancelledEvent,
  billingSubscriptionPastDueEvent,
  // trestle:resource-event-list
]);
