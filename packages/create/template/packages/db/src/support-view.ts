import { sql } from "drizzle-orm";

import { recordAuditEvent } from "./audit.js";
import type { Database } from "./index.js";
import type { PlatformChangeContext } from "./platform-roles.js";
import { supportHandoff } from "./support-schema.js";
import type { SupportSession } from "./support-sessions.js";

const tokenPattern = /^[0-9a-f]{64}$/u;

export function newSupportToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashSupportToken(token: string): Promise<string | null> {
  if (!tokenPattern.test(token)) return null;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Only the admin's platform connection can mint a one-use, 60-second handoff. */
export async function mintSupportHandoff(database: Database, session: SupportSession, context: PlatformChangeContext): Promise<string> {
  if (!session.targetUserId || session.operatorId !== context.actor.id || session.endedAt || session.expiresAt <= new Date()) throw new Error("An active member-bound support session is required");
  const token = newSupportToken();
  const tokenHash = (await hashSupportToken(token))!;
  const expiresAt = new Date(Math.min(Date.now() + 60_000, session.expiresAt.getTime()));
  await database.transaction(async (transaction) => {
    await transaction.insert(supportHandoff).values({ sessionId: session.id, tokenHash, expiresAt });
    await recordAuditEvent(transaction, {
      name: "platform.support_handoff.created", actor: context.actor, organizationId: session.organizationId,
      target: { type: "support_session", id: session.id }, summary: { viewedUserId: session.targetUserId, expiresAt: expiresAt.toISOString() },
      reason: context.reason, environment: context.environment, correlationId: context.correlationId, supportSessionId: session.id,
    });
  });
  return token;
}

function resultRows(result: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<Record<string, unknown>>;
}

/** App-role-only database functions atomically exchange the handoff; no support tables are granted to the app. */
export async function exchangeSupportHandoff(database: Database, handoffToken: string, grantToken: string): Promise<boolean> {
  const handoffHash = await hashSupportToken(handoffToken);
  const grantHash = await hashSupportToken(grantToken);
  if (!handoffHash || !grantHash) return false;
  const [row] = resultRows(await database.execute(sql`select public.trestle_consume_support_handoff(${handoffHash}, ${grantHash}) as accepted`));
  return row?.accepted === true;
}

export type SupportView = Readonly<{
  sessionId: string; organizationId: string; organizationName: string; operatorId: string; operatorEmail: string;
  viewedUserId: string; viewedUserName: string; viewedUserEmail: string; expiresAt: Date;
}>;

/** Rechecked against session, operator role and target membership on every app view. */
export async function activeSupportView(database: Database, grantToken: string, input: Readonly<{ path: string; correlationId: string; environment: string }>): Promise<SupportView | null> {
  const grantHash = await hashSupportToken(grantToken);
  if (!grantHash) return null;
  const [row] = resultRows(await database.execute(sql`select * from public.trestle_support_view(${grantHash}, ${input.path}, ${input.correlationId}, ${input.environment})`));
  if (!row) return null;
  return {
    sessionId: String(row.session_id), organizationId: String(row.organization_id), organizationName: String(row.organization_name),
    operatorId: String(row.operator_id), operatorEmail: String(row.operator_email), viewedUserId: String(row.viewed_user_id),
    viewedUserName: String(row.viewed_user_name), viewedUserEmail: String(row.viewed_user_email), expiresAt: new Date(row.expires_at as string),
  };
}

/** Revokes this app credential and ends its platform session in one database transaction. */
export async function endSupportView(database: Database, grantToken: string): Promise<boolean> {
  const grantHash = await hashSupportToken(grantToken);
  if (!grantHash) return false;
  const [row] = resultRows(await database.execute(sql`select public.trestle_end_support_view(${grantHash}) as ended`));
  return row?.ended === true;
}
