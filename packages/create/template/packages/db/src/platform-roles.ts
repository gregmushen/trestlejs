import { and, asc, eq, isNull } from "drizzle-orm";

import { recordAuditEvent } from "./audit.js";
import type { Database } from "./index.js";
import { platformRoleAssignment } from "./platform-schema.js";

export type PlatformRoleGrant = Readonly<{ userId: string; role: string; grantedBy: string; reason: string; grantedAt: Date }>;

/** The acting principal and request context every platform-role change records. */
export type PlatformChangeContext = Readonly<{ actor: Readonly<{ type: "platform_operator" | "system"; id: string }>; reason: string; environment: string; correlationId: string; now?: Date }>;

export class PlatformRoleError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "not_found", message: string) {
    super(message);
    this.name = "PlatformRoleError";
  }
}

function requireReason(reason: string): string {
  const text = reason.trim();
  if (!text || text.length > 500) throw new PlatformRoleError("invalid", "A reason of at most 500 characters is required");
  return text;
}

/** Active platform roles for a user. Callers resolve them through the reviewed platform role catalog. */
export async function activePlatformRoles(database: Database, userId: string): Promise<string[]> {
  const rows = await database.select({ role: platformRoleAssignment.role }).from(platformRoleAssignment)
    .where(and(eq(platformRoleAssignment.userId, userId), isNull(platformRoleAssignment.revokedAt)))
    .orderBy(asc(platformRoleAssignment.role));
  return rows.map(({ role }) => role);
}

export async function listPlatformRoleGrants(database: Database): Promise<PlatformRoleGrant[]> {
  return await database.select({ userId: platformRoleAssignment.userId, role: platformRoleAssignment.role, grantedBy: platformRoleAssignment.grantedBy, reason: platformRoleAssignment.reason, grantedAt: platformRoleAssignment.grantedAt })
    .from(platformRoleAssignment).where(isNull(platformRoleAssignment.revokedAt))
    .orderBy(asc(platformRoleAssignment.userId), asc(platformRoleAssignment.role));
}

/** Grants a platform role and records `platform.role.granted` in the same transaction. */
export async function grantPlatformRole(database: Database, input: Readonly<{ userId: string; role: string }>, context: PlatformChangeContext): Promise<void> {
  const reason = requireReason(context.reason);
  await database.transaction(async (transaction) => {
    const inserted = await transaction.insert(platformRoleAssignment)
      .values({ userId: input.userId, role: input.role, grantedBy: `${context.actor.type}:${context.actor.id}`, reason, ...(context.now ? { grantedAt: context.now } : {}) })
      .onConflictDoNothing().returning();
    if (inserted.length === 0) throw new PlatformRoleError("conflict", `The user already holds platform role ${input.role}`);
    await recordAuditEvent(transaction, {
      name: "platform.role.granted", actor: context.actor, organizationId: null, target: { type: "user", id: input.userId },
      reason, summary: { role: input.role }, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}),
    });
  });
}

/** Revokes an active platform role and records `platform.role.revoked` in the same transaction. */
export async function revokePlatformRole(database: Database, input: Readonly<{ userId: string; role: string }>, context: PlatformChangeContext): Promise<void> {
  const reason = requireReason(context.reason);
  await database.transaction(async (transaction) => {
    const revoked = await transaction.update(platformRoleAssignment)
      .set({ revokedAt: context.now ?? new Date(), revokedBy: `${context.actor.type}:${context.actor.id}`, revocationReason: reason })
      .where(and(eq(platformRoleAssignment.userId, input.userId), eq(platformRoleAssignment.role, input.role), isNull(platformRoleAssignment.revokedAt)))
      .returning();
    if (revoked.length === 0) throw new PlatformRoleError("not_found", `The user does not hold platform role ${input.role}`);
    await recordAuditEvent(transaction, {
      name: "platform.role.revoked", actor: context.actor, organizationId: null, target: { type: "user", id: input.userId },
      reason, summary: { role: input.role }, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { occurredAt: context.now } : {}),
    });
  });
}
