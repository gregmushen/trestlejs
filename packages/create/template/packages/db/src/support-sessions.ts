import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";

import { recordAuditEvent } from "./audit.js";
import { auditEvent } from "./audit-schema.js";
import { member, organization, user } from "./auth-schema.js";
import { organizationSubscription } from "./billing-schema.js";
import type { Database } from "./index.js";
import { PlatformOperationError } from "./platform-operations.js";
import type { PlatformChangeContext } from "./platform-roles.js";
import { supportSession } from "./support-schema.js";

/** The longest a support session may run; the database enforces the same bound. */
export const maximumSupportSessionMinutes = 240;

export type SupportSession = Readonly<{ id: string; organizationId: string; operatorId: string; reason: string; startedAt: Date; expiresAt: Date; endedAt: Date | null; endedBy: string | null }>;

const columns = {
  id: supportSession.id, organizationId: supportSession.organizationId, operatorId: supportSession.operatorId, reason: supportSession.reason,
  startedAt: supportSession.startedAt, expiresAt: supportSession.expiresAt, endedAt: supportSession.endedAt, endedBy: supportSession.endedBy,
};

function requireReason(reason: string): string {
  const text = reason.trim();
  if (!text || text.length > 500) throw new PlatformOperationError("invalid", "A reason of at most 500 characters is required");
  return text;
}

/** Opens a session for the operator in one organization and audits its start on that organization. */
export async function startSupportSession(database: Database, input: Readonly<{ organizationId: string; durationMinutes: number }>, context: PlatformChangeContext): Promise<SupportSession> {
  const reason = requireReason(context.reason);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > maximumSupportSessionMinutes) {
    throw new PlatformOperationError("invalid", `A support session lasts between 5 and ${maximumSupportSessionMinutes} minutes`);
  }
  const startedAt = context.now ?? new Date();
  const expiresAt = new Date(startedAt.getTime() + input.durationMinutes * 60_000);
  return await database.transaction(async (transaction) => {
    const [target] = await transaction.select({ id: organization.id }).from(organization).where(eq(organization.id, input.organizationId)).limit(1);
    if (!target) throw new PlatformOperationError("not_found", "The organization does not exist");
    // An expired session still counts as open until it is ended; end it now so the operator can start another.
    const expired = await transaction.select({ id: supportSession.id, organizationId: supportSession.organizationId }).from(supportSession)
      .where(and(eq(supportSession.operatorId, context.actor.id), isNull(supportSession.endedAt), lte(supportSession.expiresAt, startedAt))).for("update");
    for (const stale of expired) {
      await transaction.update(supportSession).set({ endedAt: startedAt, endedBy: "system:expired" }).where(eq(supportSession.id, stale.id));
      await recordAuditEvent(transaction, {
        name: "platform.support_session.ended", actor: { type: "system", id: "support-session-expiry" }, organizationId: stale.organizationId, target: { type: "support_session", id: stale.id },
        summary: { expired: true }, environment: context.environment, correlationId: context.correlationId, supportSessionId: stale.id, occurredAt: startedAt,
      });
    }
    const [open] = await transaction.select({ id: supportSession.id }).from(supportSession).where(and(eq(supportSession.operatorId, context.actor.id), isNull(supportSession.endedAt))).limit(1);
    if (open) throw new PlatformOperationError("conflict", "End your open support session before starting another");
    const session: SupportSession = { id: crypto.randomUUID(), organizationId: input.organizationId, operatorId: context.actor.id, reason, startedAt, expiresAt, endedAt: null, endedBy: null };
    await transaction.insert(supportSession).values({ id: session.id, organizationId: session.organizationId, operatorId: session.operatorId, reason, startedAt, expiresAt, correlationId: context.correlationId });
    await recordAuditEvent(transaction, {
      name: "platform.support_session.started", actor: context.actor, organizationId: input.organizationId, target: { type: "support_session", id: session.id },
      reason, summary: { expiresAt: expiresAt.toISOString() }, environment: context.environment, correlationId: context.correlationId, supportSessionId: session.id, occurredAt: startedAt,
    });
    return session;
  });
}

/** The operator's session, if it is open and unexpired. Anything else grants nothing. */
export async function activeSupportSession(database: Database, sessionId: string, operatorId: string, now = new Date()): Promise<SupportSession | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId)) return null;
  const [session] = await database.select(columns).from(supportSession)
    .where(and(eq(supportSession.id, sessionId), eq(supportSession.operatorId, operatorId), isNull(supportSession.endedAt), gt(supportSession.expiresAt, now))).limit(1);
  return session ?? null;
}

export async function listSupportSessions(database: Database, options: Readonly<{ operatorId?: string; limit?: number }> = {}): Promise<SupportSession[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  return await database.select(columns).from(supportSession).where(options.operatorId ? eq(supportSession.operatorId, options.operatorId) : undefined)
    .orderBy(desc(supportSession.startedAt)).limit(limit);
}

/** Ends the operator's open session (expired or not) and audits the exit on the organization. */
export async function endSupportSession(database: Database, sessionId: string, context: PlatformChangeContext): Promise<void> {
  const endedAt = context.now ?? new Date();
  await database.transaction(async (transaction) => {
    const [session] = await transaction.select({ organizationId: supportSession.organizationId, expiresAt: supportSession.expiresAt }).from(supportSession)
      .where(and(eq(supportSession.id, sessionId), eq(supportSession.operatorId, context.actor.id), isNull(supportSession.endedAt))).for("update").limit(1);
    if (!session) throw new PlatformOperationError("not_found", "You have no open support session with this ID");
    await transaction.update(supportSession).set({ endedAt, endedBy: `${context.actor.type}:${context.actor.id}` }).where(eq(supportSession.id, sessionId));
    await recordAuditEvent(transaction, {
      name: "platform.support_session.ended", actor: context.actor, organizationId: session.organizationId, target: { type: "support_session", id: sessionId },
      reason: context.reason.trim() || null, summary: { expired: session.expiresAt <= endedAt }, environment: context.environment, correlationId: context.correlationId, supportSessionId: sessionId, occurredAt: endedAt,
    });
  });
}

/**
 * The organization as support sees it inside a session: profile, members,
 * subscription, and recent audit history. Every read is itself audited with
 * the session ID, so the customer can see what support looked at.
 */
export async function supportOrganizationView(database: Database, session: SupportSession, context: Omit<PlatformChangeContext, "reason">) {
  const organizationId = session.organizationId;
  return await database.transaction(async (transaction) => {
    const [profile] = await transaction.select({ id: organization.id, name: organization.name, slug: organization.slug, createdAt: organization.createdAt }).from(organization).where(eq(organization.id, organizationId)).limit(1);
    const members = await transaction.select({ userId: member.userId, role: member.role, name: user.name, email: user.email, joinedAt: member.createdAt })
      .from(member).innerJoin(user, eq(user.id, member.userId)).where(eq(member.organizationId, organizationId)).orderBy(member.createdAt).limit(200);
    const [subscription] = await transaction.select({ plan: organizationSubscription.plan, planVersion: organizationSubscription.planVersion, status: organizationSubscription.status, currentPeriodEnd: organizationSubscription.currentPeriodEnd })
      .from(organizationSubscription).where(eq(organizationSubscription.organizationId, organizationId)).limit(1);
    const audit = await transaction.select({ name: auditEvent.name, occurredAt: auditEvent.occurredAt, actorType: auditEvent.actorType, outcome: auditEvent.outcome, correlationId: auditEvent.correlationId })
      .from(auditEvent).where(eq(auditEvent.organizationId, organizationId)).orderBy(desc(auditEvent.occurredAt)).limit(50);
    await recordAuditEvent(transaction, {
      name: "platform.support_session.accessed", actor: context.actor, organizationId, target: { type: "organization", id: organizationId },
      summary: { view: "organization" }, environment: context.environment, correlationId: context.correlationId, supportSessionId: session.id, ...(context.now ? { occurredAt: context.now } : {}),
    });
    return { organization: profile ?? null, members, subscription: subscription ?? null, recentAudit: audit };
  });
}
