import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { emailRecipientHash, normalizeEmailAddress } from "./email-delivery.js";
import type { Database } from "./index.js";
import { sequenceRun, sequenceSend } from "./sequence-schema.js";

export type SequenceKind = "marketing" | "transactional";
export type SequenceRunStatus = "active" | "completed" | "exited" | "failed";
export type SequenceRun = typeof sequenceRun.$inferSelect;
/** What an exit needs to cancel the engine's waiting run. */
export type ExitedSequenceRun = Readonly<{ id: string; sequenceId: string; triggerEventId: string; engine: string; engineRunId: string | null }>;

const identifier = /^[A-Za-z0-9_-]+$/u;
const reasonPattern = /^[a-z][a-z0-9_.]{0,99}$/u;

function tenant(organizationId: string): string {
  if (!identifier.test(organizationId)) throw new Error("Invalid sequence organization identifier");
  return organizationId;
}

/**
 * Starts a run for one trigger event, or returns the run that already exists:
 * the active run for this sequence, organization and user (a repeated trigger
 * never starts a second one), or the run this same trigger event started.
 * Call it with the tenant database of the committed event's organization.
 */
export async function startSequenceRun(database: Database, input: Readonly<{
  organizationId: string; sequenceId: string; kind: SequenceKind; userId: string; address: string; timeZone?: string | null;
  triggerEventId: string; engine: string; now?: Date;
}>): Promise<{ run: SequenceRun; created: boolean }> {
  const organizationId = tenant(input.organizationId);
  const address = normalizeEmailAddress(input.address);
  if (!address.includes("@") || address.length > 320) throw new Error("Invalid sequence recipient address");
  if (!input.userId || !input.sequenceId || !input.triggerEventId) throw new Error("Invalid sequence run identity");
  const now = input.now ?? new Date();
  const recipientHash = await emailRecipientHash(address);
  return await database.transaction(async (transaction) => {
    const [inserted] = await transaction.insert(sequenceRun).values({
      id: crypto.randomUUID(), organizationId, sequenceId: input.sequenceId, kind: input.kind, userId: input.userId,
      recipientAddress: address, recipientHash, timeZone: input.timeZone ?? null, triggerEventId: input.triggerEventId,
      status: "active", currentStep: 0, nextAt: now, engine: input.engine, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().returning();
    if (inserted) return { run: inserted, created: true };
    const [existing] = await transaction.select().from(sequenceRun).where(and(eq(sequenceRun.organizationId, organizationId), eq(sequenceRun.sequenceId, input.sequenceId),
      sql`(${sequenceRun.triggerEventId} = ${input.triggerEventId} or (${sequenceRun.userId} = ${input.userId} and ${sequenceRun.status} = 'active'))`))
      .orderBy(desc(sql`${sequenceRun.status} = 'active'`)).limit(1);
    if (!existing) throw new Error("Sequence run conflict could not be resolved");
    return { run: existing, created: false };
  });
}

export async function findSequenceRun(database: Database, organizationId: string, runId: string): Promise<SequenceRun | null> {
  const [run] = await database.select().from(sequenceRun).where(and(eq(sequenceRun.organizationId, tenant(organizationId)), eq(sequenceRun.id, runId))).limit(1);
  return run ?? null;
}

/** Records the engine's own run ID once the engine accepted the run. */
export async function setSequenceEngineRun(database: Database, organizationId: string, runId: string, engineRunId: string): Promise<void> {
  await database.update(sequenceRun).set({ engineRunId, updatedAt: new Date() }).where(and(eq(sequenceRun.organizationId, tenant(organizationId)), eq(sequenceRun.id, runId)));
}

/**
 * Moves an active run from `fromStep` to `toStep` (a wait, a skipped send, or
 * a send deferred out of quiet hours when both are equal), fenced on the
 * current step so a retried or stale execution changes nothing.
 */
export async function advanceSequenceRun(database: Database, input: Readonly<{ organizationId: string; runId: string; fromStep: number; toStep: number; nextAt: Date | null; complete?: boolean; now?: Date }>): Promise<boolean> {
  const rows = await database.update(sequenceRun).set({
    currentStep: input.toStep, nextAt: input.complete ? null : input.nextAt, updatedAt: input.now ?? new Date(), ...(input.complete ? { status: "completed" } : {}),
  }).where(and(eq(sequenceRun.organizationId, tenant(input.organizationId)), eq(sequenceRun.id, input.runId), eq(sequenceRun.status, "active"), eq(sequenceRun.currentStep, input.fromStep))).returning();
  return rows.length > 0;
}

/**
 * Records a send Resend accepted and advances the run past it, in one
 * transaction. The send is recorded even if the run exited meanwhile (the
 * email did go out); only an active run at that step advances.
 */
export async function recordSequenceSend(database: Database, input: Readonly<{
  organizationId: string; runId: string; stepIndex: number; idempotencyKey: string; emailDeliveryId: string; toStep: number; complete: boolean; now?: Date;
}>): Promise<{ recorded: boolean; advanced: boolean }> {
  const organizationId = tenant(input.organizationId);
  const now = input.now ?? new Date();
  return await database.transaction(async (transaction) => {
    const inserted = await transaction.insert(sequenceSend).values({ runId: input.runId, organizationId, stepIndex: input.stepIndex, idempotencyKey: input.idempotencyKey, emailDeliveryId: input.emailDeliveryId, sentAt: now })
      .onConflictDoNothing().returning();
    const advanced = await transaction.update(sequenceRun).set({ currentStep: input.toStep, nextAt: null, updatedAt: now, ...(input.complete ? { status: "completed" } : {}) })
      .where(and(eq(sequenceRun.organizationId, organizationId), eq(sequenceRun.id, input.runId), eq(sequenceRun.status, "active"), eq(sequenceRun.currentStep, input.stepIndex))).returning();
    return { recorded: inserted.length > 0, advanced: advanced.length > 0 };
  });
}

/** Ends an active run as exited or permanently failed; an ended run is left as it is. */
export async function endSequenceRun(database: Database, input: Readonly<{ organizationId: string; runId: string; status: "exited" | "failed"; reason: string; now?: Date }>): Promise<boolean> {
  if (!reasonPattern.test(input.reason)) throw new Error("Invalid sequence exit reason");
  const rows = await database.update(sequenceRun).set({ status: input.status, exitReason: input.reason, nextAt: null, updatedAt: input.now ?? new Date() })
    .where(and(eq(sequenceRun.organizationId, tenant(input.organizationId)), eq(sequenceRun.id, input.runId), eq(sequenceRun.status, "active"))).returning();
  return rows.length > 0;
}

/**
 * Exits every active run matching a user or a recipient, or every run of the
 * given sequences in the organization when neither is named (optionally only
 * one kind), in one statement, and returns them so the caller can cancel their
 * waiting engine runs. Run it inside the consumer's handling of the committed
 * exit event.
 */
export async function exitSequenceRuns(database: Database, input: Readonly<{
  organizationId: string; reason: string; userId?: string; recipientHash?: string; sequenceIds?: readonly string[]; kind?: SequenceKind; now?: Date;
}>): Promise<ExitedSequenceRun[]> {
  if (!reasonPattern.test(input.reason)) throw new Error("Invalid sequence exit reason");
  if (!input.userId && !input.recipientHash && !input.sequenceIds) throw new Error("A sequence exit needs a user, a recipient, or sequences");
  if (input.sequenceIds && input.sequenceIds.length === 0) return [];
  const filters = [
    eq(sequenceRun.organizationId, tenant(input.organizationId)), eq(sequenceRun.status, "active"),
    input.userId ? eq(sequenceRun.userId, input.userId) : undefined,
    input.recipientHash ? eq(sequenceRun.recipientHash, input.recipientHash) : undefined,
    input.sequenceIds ? inArray(sequenceRun.sequenceId, [...input.sequenceIds]) : undefined,
    input.kind ? eq(sequenceRun.kind, input.kind) : undefined,
  ].filter((value) => value !== undefined);
  return (await database.update(sequenceRun).set({ status: "exited", exitReason: input.reason, nextAt: null, updatedAt: input.now ?? new Date() })
    .where(and(...filters))
    .returning()).map((row) => ({ id: row.id, sequenceId: row.sequenceId, triggerEventId: row.triggerEventId, engine: row.engine, engineRunId: row.engineRunId }));
}

/** The address a recipient hash stands for in this organization's sequences, for a signed unsubscribe. */
export async function sequenceRecipientAddress(database: Database, organizationId: string, recipientHash: string): Promise<string | null> {
  const [row] = await database.select({ address: sequenceRun.recipientAddress }).from(sequenceRun)
    .where(and(eq(sequenceRun.organizationId, tenant(organizationId)), eq(sequenceRun.recipientHash, recipientHash))).orderBy(desc(sequenceRun.createdAt)).limit(1);
  return row?.address ?? null;
}
