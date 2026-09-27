import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { recordAuditEvent } from "./audit.js";
import { organization } from "./auth-schema.js";
import type { Database } from "./index.js";
import { maskEmailAddress } from "./platform-email.js";
import { PlatformOperationError } from "./platform-operations.js";
import type { PlatformChangeContext } from "./platform-roles.js";
import { sequenceRun, sequenceSend } from "./sequence-schema.js";

/** The exit reason a run gets when its recipient was suppressed at send time. */
export const sequenceSuppressedReason = "suppressed";

export type SequenceSummary = Readonly<{
  sequenceId: string;
  active: number;
  completed: number;
  failed: number;
  sends: Readonly<{ last24h: number; last7d: number }>;
  /** Exited runs by reason (an exitOn event, a delivery event, `suppressed`, or `operator`). */
  exits: Readonly<Record<string, number>>;
  /** Runs that ended because the recipient was suppressed when a send was due. */
  suppressed: number;
}>;

/** Per sequence: runs by status, sends over the last day and week, and exits by reason. */
export async function sequenceSummaries(database: Database, now = new Date()): Promise<SequenceSummary[]> {
  const [statuses, exits, sends24h, sends7d] = await Promise.all([
    database.select({ sequenceId: sequenceRun.sequenceId, status: sequenceRun.status, total: count() }).from(sequenceRun).groupBy(sequenceRun.sequenceId, sequenceRun.status),
    database.select({ sequenceId: sequenceRun.sequenceId, reason: sequenceRun.exitReason, total: count() }).from(sequenceRun).where(eq(sequenceRun.status, "exited")).groupBy(sequenceRun.sequenceId, sequenceRun.exitReason),
    ...[86_400_000, 7 * 86_400_000].map((window) => database.select({ sequenceId: sequenceRun.sequenceId, total: count() }).from(sequenceSend)
      .innerJoin(sequenceRun, eq(sequenceRun.id, sequenceSend.runId)).where(gte(sequenceSend.sentAt, new Date(now.getTime() - window))).groupBy(sequenceRun.sequenceId)),
  ]);
  const ids = [...new Set([...statuses, ...exits, ...sends24h!, ...sends7d!].map((row) => row.sequenceId))].sort();
  const status = (id: string, value: string) => Number(statuses.find((row) => row.sequenceId === id && row.status === value)?.total ?? 0);
  return ids.map((sequenceId) => {
    const reasons = Object.fromEntries(exits.filter((row) => row.sequenceId === sequenceId).map((row) => [row.reason ?? "unknown", Number(row.total)]));
    return {
      sequenceId, active: status(sequenceId, "active"), completed: status(sequenceId, "completed"), failed: status(sequenceId, "failed"),
      sends: { last24h: Number(sends24h!.find((row) => row.sequenceId === sequenceId)?.total ?? 0), last7d: Number(sends7d!.find((row) => row.sequenceId === sequenceId)?.total ?? 0) },
      exits: reasons, suppressed: reasons[sequenceSuppressedReason] ?? 0,
    };
  });
}

export type PlatformSequenceRun = Readonly<{
  id: string; organizationId: string; organizationName: string | null; sequenceId: string; kind: string; userId: string;
  /** Masked: the first character and the domain. */
  recipient: string; status: string; exitReason: string | null; currentStep: number; nextAt: Date | null;
  engine: string; engineRunId: string | null; sends: number; createdAt: Date; updatedAt: Date;
}>;

/** Sequence runs across organizations, newest first, filterable by organization, sequence and status. Recipients are masked. */
export async function listSequenceRuns(database: Database, options: Readonly<{ organizationId?: string; sequenceId?: string; status?: string; limit?: number }> = {}): Promise<PlatformSequenceRun[]> {
  const filters = [
    options.organizationId ? eq(sequenceRun.organizationId, options.organizationId) : undefined,
    options.sequenceId ? eq(sequenceRun.sequenceId, options.sequenceId) : undefined,
    options.status ? eq(sequenceRun.status, options.status) : undefined,
  ].filter((value) => value !== undefined);
  const rows = await database.select({
    id: sequenceRun.id, organizationId: sequenceRun.organizationId, organizationName: organization.name, sequenceId: sequenceRun.sequenceId, kind: sequenceRun.kind,
    userId: sequenceRun.userId, recipient: sequenceRun.recipientAddress, status: sequenceRun.status, exitReason: sequenceRun.exitReason, currentStep: sequenceRun.currentStep,
    nextAt: sequenceRun.nextAt, engine: sequenceRun.engine, engineRunId: sequenceRun.engineRunId, createdAt: sequenceRun.createdAt, updatedAt: sequenceRun.updatedAt,
    sends: sql<number>`(select count(*) from ${sequenceSend} where ${sequenceSend.runId} = ${sequenceRun.id})`,
  }).from(sequenceRun).leftJoin(organization, eq(organization.id, sequenceRun.organizationId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(sequenceRun.createdAt)).limit(Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500));
  return rows.map((row) => ({ ...row, recipient: maskEmailAddress(row.recipient), sends: Number(row.sends) }));
}

/**
 * Ends one active run as `exited` with reason `operator`. The audit event,
 * which never names the recipient, commits in the same transaction. The next
 * step's active check prevents any further send, whether or not the engine's
 * waiting run is cancelled.
 */
export async function exitSequenceRunAsOperator(database: Database, input: Readonly<{ runId: string }>, context: PlatformChangeContext): Promise<{ sequenceId: string; organizationId: string; currentStep: number }> {
  const reason = context.reason.trim();
  if (!reason || reason.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  if (!/^[0-9a-f-]{36}$/u.test(input.runId)) throw new PlatformOperationError("invalid", "Choose a sequence run");
  return await database.transaction(async (transaction) => {
    const [exited] = await transaction.update(sequenceRun).set({ status: "exited", exitReason: "operator", nextAt: null, updatedAt: context.now ?? new Date() })
      .where(and(eq(sequenceRun.id, input.runId), eq(sequenceRun.status, "active")))
      .returning();
    if (!exited) throw new PlatformOperationError("not_found", "That sequence run is not active");
    await recordAuditEvent(transaction, {
      actor: context.actor, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}),
      name: "platform.sequence_run.exited", organizationId: exited.organizationId, target: { type: "sequence_run", id: input.runId },
      reason, summary: { sequenceId: exited.sequenceId, currentStep: exited.currentStep },
    });
    return { sequenceId: exited.sequenceId, organizationId: exited.organizationId, currentStep: exited.currentStep };
  });
}
