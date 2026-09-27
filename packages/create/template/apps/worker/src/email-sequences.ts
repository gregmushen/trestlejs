import { tenantRecord } from "@__TRESTLE_PROJECT_NAME__/db";
import { sequenceMessageTemplate } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { eq } from "drizzle-orm";

import { workerSequenceDependencies } from "./sequence-engines.js";
import { SequenceRegistry } from "./sequence-runtime.js";
import { defineSequence } from "./sequences.js";
import type { WorkerEnvironment } from "./worker-environment.js";

/**
 * Application email sequences. Register a sequence here; `index.ts` attaches
 * the registry to the event consumers, so its trigger starts runs and its
 * exit events end them on whichever job runtime is configured. See "Email
 * sequences" in the README.
 */
export const emailSequences = new SequenceRegistry<WorkerEnvironment>(workerSequenceDependencies());

/**
 * An example marketing sequence, shipped disabled: a new member gets a
 * welcome email, tips three days later unless the organization has already
 * created something, and a trial reminder four days after that. Activating a
 * subscription, unsubscribing, a hard bounce, or a complaint ends it.
 *
 * To enable it: publish `user.signed_up` when a member joins (in the same
 * transaction, with `createEventPublisher`), configure Resend and its webhook
 * (`trestle email webhook configure`), then `emailSequences.register(trialNurture)`.
 */
export const trialNurture = defineSequence({
  id: "trial-nurture",
  kind: "marketing",
  authority: "tenant",
  trigger: "user.signed_up",
  recipient: async (event, context) => {
    const account = await context.user((event.payload as { userId: string }).userId);
    return account ? { userId: account.id, address: account.email } : null;
  },
  exitOn: ["billing.subscription.activated"],
  steps: [
    { send: "welcome" },
    { wait: "3d" },
    { send: "tips", unless: async ({ data, organizationId }) => (await data.select({ id: tenantRecord.id }).from(tenantRecord).where(eq(tenantRecord.organizationId, organizationId)).limit(1)).length > 0 },
    { wait: "4d" },
    { send: "trial-ending" },
  ],
  templates: {
    welcome: ({ unsubscribeUrl }) => ({ subject: "Welcome aboard", template: sequenceMessageTemplate("trial-nurture-welcome", { heading: "Welcome aboard", paragraphs: ["Your trial has started. Here is how to get the most out of it."], unsubscribeUrl }) }),
    tips: ({ unsubscribeUrl }) => ({ subject: "Three tips for your first week", template: sequenceMessageTemplate("trial-nurture-tips", { heading: "Three tips for your first week", paragraphs: ["Invite your team, create your first record, and connect your tools."], unsubscribeUrl }) }),
    "trial-ending": ({ unsubscribeUrl }) => ({ subject: "Your trial ends soon", template: sequenceMessageTemplate("trial-nurture-trial-ending", { heading: "Your trial ends soon", paragraphs: ["Choose a plan to keep your work."], unsubscribeUrl }) }),
  },
});
