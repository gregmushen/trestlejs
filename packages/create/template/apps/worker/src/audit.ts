import { recordAuditEvent, type AuditEventInput } from "@__TRESTLE_PROJECT_NAME__/db";

import type { AppExecutionContext } from "./execution-context.js";

type TenantAuditInput = Pick<AuditEventInput, "name" | "target" | "summary" | "reason" | "outcome">;

/** The audit record for an action taken in the request's tenant, attributed to its principal and correlation ID. */
export function tenantAuditEvent(execution: AppExecutionContext, environment: string | undefined, event: TenantAuditInput): AuditEventInput {
  return {
    ...event,
    actor: { type: execution.principal.kind, id: execution.principal.id },
    organizationId: execution.tenant.organizationId,
    environment: environment ?? "local",
    correlationId: execution.correlation.correlationId,
  };
}

/**
 * Records a tenant action on the tenant-bound connection. Prefer passing the
 * record into the mutation's own transaction; this form is for subsystems
 * that own their transaction, and records only after the change committed.
 */
export async function auditTenantAction(execution: AppExecutionContext, environment: string | undefined, event: TenantAuditInput): Promise<void> {
  await recordAuditEvent(execution.data, tenantAuditEvent(execution, environment, event));
}
