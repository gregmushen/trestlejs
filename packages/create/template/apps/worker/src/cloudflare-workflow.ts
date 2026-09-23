import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { PostgresEventInbox } from "@__TRESTLE_PROJECT_NAME__/db";
import { eventEnvelopeSchema, safeErrorCategory, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { handleEventWithInbox } from "./async-runtime.js";
import { eventConsumers } from "./index.js";

export class TrestleWorkflow extends WorkflowEntrypoint<AuthEnvironment, EventEnvelope> {
  async run(event: WorkflowEvent<EventEnvelope>, step: WorkflowStep): Promise<void> {
    const envelope = eventEnvelopeSchema.parse(event.payload);
    await step.do("consume-event-v1", { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" }, async () => {
      const inbox = new PostgresEventInbox(this.env.DATABASE_URL, { assumeApplicationRole: true });
      try {
        await handleEventWithInbox(eventConsumers, inbox, envelope, this.env);
        createLogger({ correlationId: envelope.correlationId }).info("workflow.event.completed", { workflowId: event.instanceId, eventName: envelope.name });
      } catch (error) {
        createLogger({ correlationId: envelope.correlationId }).warn("workflow.event.retrying", { workflowId: event.instanceId, eventName: envelope.name, errorCategory: safeErrorCategory(error) });
        throw new Error("Workflow handler failed");
      } finally {
        await inbox.close();
      }
    });
  }
}
