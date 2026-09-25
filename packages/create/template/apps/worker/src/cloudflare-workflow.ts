import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger, loggerSecretsFromEnvironment, type Logger } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresEventInbox, PostgresOutboxStore, type CommittedEventStore, type NativeWebhookWakeup } from "@__TRESTLE_PROJECT_NAME__/db";
import { eventEnvelopeSchema, PermanentEventError, safeErrorCategory, type CloudflareQueueBinding, type EventEnvelope, type EventInboxStore } from "@__TRESTLE_PROJECT_NAME__/events";
import { handleEventWithInbox, type EventConsumerRegistry, type PostCommitEffect } from "./async-runtime.js";
import { eventConsumers } from "./index.js";
import { projectWebhookForEvent } from "./webhook-runtime.js";

/**
 * One execution of the Workflow step. Every execution, including retries and
 * resumption, reloads provenance, rechecks the replay window, and rechecks
 * current entitlements; nothing is cached across executions. A handler the
 * tenant is no longer entitled to is skipped and the step completes.
 *
 * A `PermanentEventError` ends the instance with Cloudflare's
 * `NonRetryableError`, so it is reported as errored and never as completed.
 * Every other failure stays retryable.
 */
export async function consumeWorkflowEvent<Environment, Data = unknown>(input: {
  registry: EventConsumerRegistry<Environment, Data>;
  inbox: EventInboxStore;
  outbox: CommittedEventStore;
  envelope: EventEnvelope;
  environment: Environment;
  workflowId: string;
  log: Logger;
  postCommit?: PostCommitEffect<Environment>;
}): Promise<void> {
  const fields = { workflowId: input.workflowId, eventName: input.envelope.name };
  try {
    await handleEventWithInbox(input.registry, input.inbox, input.outbox, input.envelope, input.environment, input.postCommit);
    input.log.info("workflow.event.completed", fields);
  } catch (error) {
    if (error instanceof PermanentEventError) {
      input.log.warn("workflow.event.rejected", { ...fields, reason: error.reason });
      throw new NonRetryableError(`Workflow event rejected: ${error.reason}`);
    }
    input.log.warn("workflow.event.retrying", { ...fields, errorCategory: safeErrorCategory(error) });
    throw new Error("Workflow handler failed");
  }
}

export class TrestleWorkflow extends WorkflowEntrypoint<AuthEnvironment, EventEnvelope> {
  async run(event: WorkflowEvent<EventEnvelope>, step: WorkflowStep): Promise<void> {
    const envelope = eventEnvelopeSchema.parse(event.payload);
    await step.do("consume-event-v1", { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" }, async () => {
      const inbox = new PostgresEventInbox(this.env.DATABASE_URL, { assumeApplicationRole: true });
      const outbox = new PostgresOutboxStore(this.env.DATABASE_URL, { assumeApplicationRole: true });
      try {
        await consumeWorkflowEvent({
          registry: eventConsumers, inbox, outbox, envelope, environment: this.env, workflowId: event.instanceId,
          log: createLogger({ correlationId: envelope.correlationId }, undefined, { secretValues: loggerSecretsFromEnvironment(this.env) }),
          postCommit: async (message, environment, committed) => {
            const queue = (environment as AuthEnvironment & { TRESTLE_EVENTS?: CloudflareQueueBinding<NativeWebhookWakeup> }).TRESTLE_EVENTS;
            await projectWebhookForEvent({ envelope: message, environment, outbox, ...(committed ? { committed } : {}), ...(queue ? { queue } : {}) });
          },
        });
      } finally {
        await Promise.all([inbox.close(), outbox.close()]);
      }
    });
  }
}
