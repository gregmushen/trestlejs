import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createLogger } from "@__TRESTLE_PROJECT_NAME__/context";
import { applicationConnectionString, createSqlRunner, PostgresOutboxStore } from "@__TRESTLE_PROJECT_NAME__/db";
import { meteringProvider, UsageReporter } from "@__TRESTLE_PROJECT_NAME__/billing";
import { publicWebhookEvent } from "@__TRESTLE_PROJECT_NAME__/domain";
import { declaredCapabilities } from "@__TRESTLE_PROJECT_NAME__/platform";
import { applicationEvents, CloudflareQueuePublisher, type CloudflareQueueBinding, type EventEnvelope } from "@__TRESTLE_PROJECT_NAME__/events";
import { sql } from "drizzle-orm";

import manifestText from "../../../.trestle/project.yaml";
import { communicationDependencies, communicationsEnabled, notificationService, systemContext, webhookDispatcher } from "./communications.js";

type RunnerEnvironment = AuthEnvironment & { TRESTLE_EVENTS?: CloudflareQueueBinding };

/**
 * Publishes one committed outbox event: fans it out to subscribed webhook
 * endpoints and to the notifications it triggers, then forwards it to the
 * queue when one is bound. Throwing leaves the message for a retry.
 */
export async function publishEvent(message: EventEnvelope, environment: RunnerEnvironment): Promise<{ webhooks: number; notifications: number }> {
  const payload = message.payload && typeof message.payload === "object" ? message.payload as Record<string, unknown> : {};
  const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : null;
  let webhooks = 0;
  let raised = 0;
  if (organizationId && communicationsEnabled.webhooks) {
    const published = publicWebhookEvent(applicationEvents, message, organizationId);
    if (published) webhooks = await communicationDependencies.webhookRepository(environment, organizationId).enqueueEvent({ eventId: message.id, name: published.name, version: published.version, payload: published.body, correlationId: message.correlationId });
  }
  if (organizationId && communicationsEnabled.notifications) {
    const actorId = typeof (payload.support as { operatorId?: unknown } | undefined)?.operatorId === "string" ? String((payload.support as { operatorId: string }).operatorId) : "system:outbox";
    raised = await (await notificationService(environment, organizationId)).fromEvent({ ...systemContext(environment, organizationId, message.correlationId), actor: { type: "system", id: actorId } }, { id: message.id, name: message.name, resource: message.resource, payload });
  }
  if (environment.TRESTLE_EVENTS) await new CloudflareQueuePublisher(environment.TRESTLE_EVENTS).send(message);
  return { webhooks, notifications: raised };
}

/** Attempts due webhook and notification-email deliveries, each on its tenant's RLS-bound connection. */
export async function deliverDue(environment: RunnerEnvironment, now = new Date()): Promise<{ webhooks: number; emails: number }> {
  const runner = createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER);
  let webhooks = 0;
  let emails = 0;
  if (communicationsEnabled.webhooks) {
    for (const row of await runner.query(sql`select * from trestle_due_webhook_deliveries(50)`)) {
      const organizationId = String(row.organization_id);
      await (await webhookDispatcher(environment, organizationId)).attempt(String(row.id), systemContext(environment, organizationId, `webhook:${String(row.id)}`, now));
      webhooks += 1;
    }
  }
  if (communicationsEnabled.notifications) {
    const send = communicationDependencies.emailSender(environment);
    for (const row of await runner.query(sql`select * from trestle_due_notification_deliveries(50)`)) {
      const organizationId = String(row.organization_id);
      await (await notificationService(environment, organizationId)).deliverEmail(String(row.id), send, systemContext(environment, organizationId, `notification:${String(row.id)}`, now));
      emails += 1;
    }
  }
  return { webhooks, emails };
}

const declared = declaredCapabilities(manifestText);
const metering = declared.metering;

/**
 * When Queues is declared, remote runtimes fail closed without the binding:
 * events would otherwise be marked published without reaching queue consumers.
 * Without Queues the runner still delivers webhooks and notifications.
 */
export function assertQueueBinding(environment: RunnerEnvironment, queuesDeclared = declared.queues): void {
  if (queuesDeclared && !environment.TRESTLE_EVENTS && environment.APP_ENV && environment.APP_ENV !== "local") throw new Error("Remote outbox dispatch requires the TRESTLE_EVENTS Queue binding");
}

/**
 * Forwards committed usage to the declared metering provider and reads its
 * figures back into the local projection. Native metering does nothing here;
 * request authorization never waits on this.
 */
export async function reportUsage(environment: RunnerEnvironment, now = new Date()): Promise<{ reported: number; reconciled: number; failed: number }> {
  if (metering === "native") return { reported: 0, reconciled: 0, failed: 0 };
  const reporter = new UsageReporter(environment.DATABASE_URL, environment.DATABASE_DRIVER, meteringProvider(metering, environment));
  const reported = await reporter.report();
  const reconciled = await reporter.reconcile(now, 25);
  return { reported: reported.reported, reconciled: reconciled.reconciled, failed: reported.failed + reconciled.failed };
}

/**
 * The outbox runner, invoked by the Worker's cron trigger (and every few
 * seconds by `trestle dev`). Committed events are leased with SKIP LOCKED, so
 * concurrent runs never publish the same message twice.
 */
export async function runOutbox(environment: RunnerEnvironment): Promise<{ published: number; failed: number; webhooks: number; emails: number }> {
  const log = createLogger({ component: "outbox" });
  const store = new PostgresOutboxStore(applicationConnectionString(environment.DATABASE_URL));
  let published = 0;
  let failed = 0;
  try {
    for (const entry of await store.lease(50, 60_000)) {
      try {
        await publishEvent(entry.message, environment);
        await store.succeed(entry.id);
        published += 1;
      } catch (error) {
        await store.fail(entry.id, error);
        failed += 1;
        log.warn("outbox.publish.failed", { eventName: entry.message.name, messageId: entry.id, correlationId: entry.message.correlationId, errorName: error instanceof Error ? error.name : "UnknownError" });
      }
    }
  } finally {
    await store.close();
  }
  const delivered = await deliverDue(environment);
  const usage = await reportUsage(environment).catch((error: unknown) => { log.warn("metering.report.failed", { errorName: error instanceof Error ? error.name : "UnknownError" }); return { reported: 0, reconciled: 0, failed: 1 }; });
  if (usage.reported || usage.failed) log.info("metering.report.completed", usage);
  if (published || failed || delivered.webhooks || delivered.emails) log.info("outbox.run.completed", { published, failed, ...delivered });
  return { published, failed, ...delivered };
}
