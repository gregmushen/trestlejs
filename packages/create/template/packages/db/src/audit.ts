import { and, desc, eq, lt } from "drizzle-orm";

import { auditEvent } from "./audit-schema.js";
import type { Database } from "./index.js";

export type AuditActorType = "user" | "service_account" | "platform_operator" | "system";
export type AuditOutcome = "succeeded" | "denied" | "failed";

export type AuditEventInput = Readonly<{
  /** Semantic, versioned name: `<area>.<noun>.<past_verb>`, e.g. access.application_roles.changed. */
  name: string;
  actor: Readonly<{ type: AuditActorType; id: string }>;
  organizationId: string | null;
  target: Readonly<{ type: string; id: string }>;
  reason?: string | null;
  summary?: Readonly<Record<string, unknown>>;
  outcome?: AuditOutcome;
  environment: string;
  correlationId: string;
  supportSessionId?: string | null;
  occurredAt?: Date;
}>;

export class AuditEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditEventError";
  }
}

const auditNamePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/u;
const sensitiveKey = /(?:authorization|cookie|password|secret|token|api[-_]?key|verifier|credential|signature|body|html|payload|magic[-_]?link|url)/iu;
const maximumString = 500;
const maximumDepth = 4;
const maximumBytes = 8_192;

/**
 * Redacts audit summaries before they are persisted: sensitive keys become
 * "[REDACTED]", long strings are truncated, and deep or oversized values are
 * dropped. Audit records describe what changed, never the secret itself.
 */
export function redactAuditSummary(value: unknown, key = "", depth = 0): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (depth > maximumDepth) return "[TRUNCATED]";
  if (typeof value === "string") return value.length > maximumString ? `${value.slice(0, maximumString)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactAuditSummary(item, "", depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([name, item]) => [name, redactAuditSummary(item, name, depth + 1)]));
  return value;
}

function prepare(input: AuditEventInput) {
  if (!auditNamePattern.test(input.name)) throw new AuditEventError(`Audit event name ${input.name} must be <area>.<noun>.<past_verb>`);
  if (!input.correlationId.trim()) throw new AuditEventError("Audit events require a correlation ID");
  const summary = redactAuditSummary(input.summary ?? {}) as Record<string, unknown>;
  const bounded = JSON.stringify(summary).length > maximumBytes ? { truncated: true } : summary;
  return {
    name: input.name, actorType: input.actor.type, actorId: input.actor.id, organizationId: input.organizationId,
    targetType: input.target.type, targetId: input.target.id, reason: input.reason ? input.reason.slice(0, maximumString) : null,
    summary: bounded, outcome: input.outcome ?? "succeeded", environment: input.environment, correlationId: input.correlationId,
    supportSessionId: input.supportSessionId ?? null, ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

type Writer = Pick<Database, "insert">;

/**
 * Appends one audit record. Pass a transaction to commit it atomically with
 * the change it describes; tenant records must use the tenant-bound database.
 */
export async function recordAuditEvent(database: Writer, input: AuditEventInput): Promise<void> {
  const values = prepare(input);
  await database.insert(auditEvent).values(values);
}

export type AuditRecord = Readonly<{ id: string; occurredAt: Date; name: string; actorType: string; actorId: string; targetType: string; targetId: string; reason: string | null; summary: Record<string, unknown>; outcome: string; correlationId: string }>;

/**
 * A page of one organization's audit history, newest first. Tenant RLS bounds the rows as well.
 * Platform actions on the organization are listed, but the operator's identity and internal
 * reason stay internal: customers see that the platform acted, what changed, and the correlation ID.
 */
export async function listAuditEvents(database: Database, organizationId: string, options: Readonly<{ limit?: number; before?: Date }> = {}): Promise<AuditRecord[]> {
  const limit = Math.min(Math.max(Math.trunc(Number.isFinite(options.limit) ? options.limit! : 50), 1), 100);
  const rows = await database.select({
    id: auditEvent.id, occurredAt: auditEvent.occurredAt, name: auditEvent.name, actorType: auditEvent.actorType, actorId: auditEvent.actorId,
    targetType: auditEvent.targetType, targetId: auditEvent.targetId, reason: auditEvent.reason, summary: auditEvent.summary, outcome: auditEvent.outcome, correlationId: auditEvent.correlationId,
  }).from(auditEvent)
    .where(options.before ? and(eq(auditEvent.organizationId, organizationId), lt(auditEvent.occurredAt, options.before)) : eq(auditEvent.organizationId, organizationId))
    .orderBy(desc(auditEvent.occurredAt), desc(auditEvent.id)).limit(limit);
  return rows.map((row) => row.actorType === "platform_operator" ? { ...row, actorId: "platform", reason: null } : row);
}
