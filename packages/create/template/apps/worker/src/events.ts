import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import type { EventPublisher, SupportAttribution } from "@__TRESTLE_PROJECT_NAME__/context";
import { createSqlRunner, outboxStatement, tenantConnectionString } from "@__TRESTLE_PROJECT_NAME__/db";
import { applicationEvents } from "@__TRESTLE_PROJECT_NAME__/events";
import type { SQL } from "drizzle-orm";

export class UnregisteredEventError extends Error {
  constructor(name: string) {
    super(`Event ${name} is not registered in packages/events/src/catalog.ts`);
    this.name = "UnregisteredEventError";
  }
}

/**
 * `ctx.events`: emits registered application events into the transactional
 * outbox, bound to the request's tenant and correlation. The outbox runner
 * then publishes them to webhooks, notifications, and queue consumers.
 */
export function createEventPublisher(environment: AuthEnvironment, organizationId: string, correlationId: string, support?: SupportAttribution): EventPublisher<SQL> {
  const statement = (name: string, payload: Readonly<Record<string, unknown>>, resource: Readonly<{ type: string; id: string }>): SQL => {
    if (!applicationEvents.has(name)) throw new UnregisteredEventError(name);
    const id = crypto.randomUUID();
    return outboxStatement({
      id, name, schemaVersion: 1, occurredAt: new Date().toISOString(), resource, correlationId, idempotencyKey: `${name}:${id}`,
      payload: { ...payload, organizationId, ...(support ? { support: { sessionId: support.sessionId, operatorId: support.operatorId } } : {}) },
    });
  };
  return {
    statement,
    emit: async (name, payload, resource) => {
      await createSqlRunner(tenantConnectionString(environment.DATABASE_URL, organizationId), environment.DATABASE_DRIVER).query(statement(name, payload, resource));
    },
  };
}
