import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { recordAuditEvent, type AuditActorType } from "./audit.js";
import type { Database } from "./index.js";
import { apiKey, serviceAccount } from "./machine-access-schema.js";
import type { PlatformChangeContext } from "./platform-roles.js";

/**
 * Service accounts and API keys. Tenant functions take a database bound to the
 * restricted role and the organization, so forced RLS is a second tenant
 * boundary; each change records an audit_event in the same transaction.
 * Callers validate roles and scopes against the reviewed catalogs.
 */
export class MachineAccessError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "MachineAccessError";
  }
}

export type MachineAccessAudit = Readonly<{ actor: Readonly<{ type: AuditActorType; id: string }>; environment: string; correlationId: string; now?: Date }>;

export type ApiKeySummary = Readonly<{ id: string; serviceAccountId: string; name: string; environment: string; displayPrefix: string; scopes: string[]; expiresAt: Date | null; createdAt: Date; rotatedFrom: string | null; revokedAt: Date | null; revocationReason: string | null }>;
export type ServiceAccountSummary = Readonly<{ id: string; name: string; applicationRoles: string[]; status: string; createdAt: Date; keys: ApiKeySummary[] }>;

const keyColumns = {
  id: apiKey.id, serviceAccountId: apiKey.serviceAccountId, name: apiKey.name, environment: apiKey.environment, displayPrefix: apiKey.displayPrefix, scopes: apiKey.scopes,
  expiresAt: apiKey.expiresAt, createdAt: apiKey.createdAt, rotatedFrom: apiKey.rotatedFrom, revokedAt: apiKey.revokedAt, revocationReason: apiKey.revocationReason,
};

function requireName(name: string): string {
  const text = name.trim();
  if (!text || text.length > 100) throw new MachineAccessError("invalid", "A name of at most 100 characters is required");
  return text;
}

function requireReason(reason: string): string {
  const text = reason.trim();
  if (!text || text.length > 500) throw new MachineAccessError("invalid", "A reason of at most 500 characters is required");
  return text;
}

export async function createServiceAccount(database: Database, input: Readonly<{ organizationId: string; name: string; applicationRoles: readonly string[] }>, audit: MachineAccessAudit): Promise<{ id: string }> {
  const name = requireName(input.name);
  const id = crypto.randomUUID();
  const roles = [...new Set(input.applicationRoles)].sort();
  await database.transaction(async (transaction) => {
    const [existing] = await transaction.select({ id: serviceAccount.id }).from(serviceAccount)
      .where(and(eq(serviceAccount.organizationId, input.organizationId), sql`lower(${serviceAccount.name}) = lower(${name})`)).limit(1);
    if (existing) throw new MachineAccessError("conflict", "A service account with this name already exists");
    await transaction.insert(serviceAccount).values({ id, organizationId: input.organizationId, name, applicationRoles: roles, createdBy: `${audit.actor.type}:${audit.actor.id}`, ...(audit.now ? { createdAt: audit.now, updatedAt: audit.now } : {}) });
    await recordAuditEvent(transaction, {
      name: "access.service_account.created", actor: audit.actor, organizationId: input.organizationId, target: { type: "service_account", id },
      summary: { name, applicationRoles: roles }, environment: audit.environment, correlationId: audit.correlationId, ...(audit.now ? { occurredAt: audit.now } : {}),
    });
  });
  return { id };
}

export async function listServiceAccounts(database: Database, organizationId: string): Promise<ServiceAccountSummary[]> {
  const accounts = await database.select({ id: serviceAccount.id, name: serviceAccount.name, applicationRoles: serviceAccount.applicationRoles, status: serviceAccount.status, createdAt: serviceAccount.createdAt })
    .from(serviceAccount).where(eq(serviceAccount.organizationId, organizationId)).orderBy(asc(serviceAccount.name));
  const keys = await database.select(keyColumns).from(apiKey).where(eq(apiKey.organizationId, organizationId)).orderBy(desc(apiKey.createdAt));
  return accounts.map((account) => ({ ...account, keys: keys.filter((key) => key.serviceAccountId === account.id) }));
}

export async function findServiceAccount(database: Database, organizationId: string, serviceAccountId: string) {
  const [account] = await database.select({ id: serviceAccount.id, applicationRoles: serviceAccount.applicationRoles, status: serviceAccount.status })
    .from(serviceAccount).where(and(eq(serviceAccount.id, serviceAccountId), eq(serviceAccount.organizationId, organizationId))).limit(1);
  return account ?? null;
}

export type StoredApiKey = Readonly<{ publicId: string; displayPrefix: string; verifier: string }>;

/** Stores a freshly minted key's verifier and metadata. The token itself is never passed here. */
export async function storeApiKey(database: Database, input: Readonly<{ organizationId: string; serviceAccountId: string; name: string; environment: string; key: StoredApiKey; scopes: readonly string[]; expiresAt?: Date }>, audit: MachineAccessAudit): Promise<void> {
  const name = requireName(input.name);
  await database.transaction(async (transaction) => {
    const [account] = await transaction.select({ status: serviceAccount.status }).from(serviceAccount)
      .where(and(eq(serviceAccount.id, input.serviceAccountId), eq(serviceAccount.organizationId, input.organizationId))).for("share").limit(1);
    if (!account) throw new MachineAccessError("not_found", "The service account does not exist");
    if (account.status !== "active") throw new MachineAccessError("conflict", "The service account is suspended");
    await transaction.insert(apiKey).values({
      id: input.key.publicId, organizationId: input.organizationId, serviceAccountId: input.serviceAccountId, name, environment: input.environment, displayPrefix: input.key.displayPrefix,
      verifier: input.key.verifier, scopes: [...new Set(input.scopes)].sort(), createdBy: `${audit.actor.type}:${audit.actor.id}`, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), ...(audit.now ? { createdAt: audit.now } : {}),
    });
    await recordAuditEvent(transaction, {
      name: "access.api_key.minted", actor: audit.actor, organizationId: input.organizationId, target: { type: "api_key", id: input.key.publicId },
      summary: { serviceAccountId: input.serviceAccountId, displayPrefix: input.key.displayPrefix, scopes: [...input.scopes], environment: input.environment, expiresAt: input.expiresAt?.toISOString() ?? null },
      environment: audit.environment, correlationId: audit.correlationId, ...(audit.now ? { occurredAt: audit.now } : {}),
    });
  });
}

/**
 * Replaces an active key with a new one carrying the same scopes. The old key
 * keeps working until `oldKeyExpiresAt`, so callers can deploy the new token.
 */
export async function rotateApiKey(database: Database, input: Readonly<{ organizationId: string; keyId: string; key: StoredApiKey; oldKeyExpiresAt: Date }>, audit: MachineAccessAudit): Promise<{ scopes: string[]; previousKeyExpiresAt: Date }> {
  return await database.transaction(async (transaction) => {
    const [current] = await transaction.select({ serviceAccountId: apiKey.serviceAccountId, name: apiKey.name, environment: apiKey.environment, scopes: apiKey.scopes, expiresAt: apiKey.expiresAt })
      .from(apiKey).where(and(eq(apiKey.id, input.keyId), eq(apiKey.organizationId, input.organizationId), isNull(apiKey.revokedAt))).for("update").limit(1);
    if (!current) throw new MachineAccessError("not_found", "The API key does not exist or is revoked");
    // Rotation shortens the old key's life; it never extends it.
    const oldKeyExpiresAt = current.expiresAt && current.expiresAt < input.oldKeyExpiresAt ? current.expiresAt : input.oldKeyExpiresAt;
    await transaction.update(apiKey).set({ expiresAt: oldKeyExpiresAt }).where(and(eq(apiKey.id, input.keyId), eq(apiKey.organizationId, input.organizationId)));
    await transaction.insert(apiKey).values({
      id: input.key.publicId, organizationId: input.organizationId, serviceAccountId: current.serviceAccountId, name: current.name, environment: current.environment, displayPrefix: input.key.displayPrefix,
      verifier: input.key.verifier, scopes: current.scopes, createdBy: `${audit.actor.type}:${audit.actor.id}`, rotatedFrom: input.keyId, ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}), ...(audit.now ? { createdAt: audit.now } : {}),
    });
    await recordAuditEvent(transaction, {
      name: "access.api_key.rotated", actor: audit.actor, organizationId: input.organizationId, target: { type: "api_key", id: input.keyId },
      summary: { replacement: input.key.publicId, displayPrefix: input.key.displayPrefix, previousKeyExpiresAt: oldKeyExpiresAt.toISOString() },
      environment: audit.environment, correlationId: audit.correlationId, ...(audit.now ? { occurredAt: audit.now } : {}),
    });
    return { scopes: current.scopes, previousKeyExpiresAt: oldKeyExpiresAt };
  });
}

export async function revokeApiKey(database: Database, input: Readonly<{ organizationId: string; keyId: string; reason: string }>, audit: MachineAccessAudit): Promise<void> {
  const reason = requireReason(input.reason);
  const now = audit.now ?? new Date();
  await database.transaction(async (transaction) => {
    const [current] = await transaction.select({ displayPrefix: apiKey.displayPrefix }).from(apiKey)
      .where(and(eq(apiKey.id, input.keyId), eq(apiKey.organizationId, input.organizationId), isNull(apiKey.revokedAt))).for("update").limit(1);
    if (!current) throw new MachineAccessError("not_found", "The API key does not exist or is already revoked");
    await transaction.update(apiKey).set({ revokedAt: now, revokedBy: `${audit.actor.type}:${audit.actor.id}`, revocationReason: reason })
      .where(and(eq(apiKey.id, input.keyId), eq(apiKey.organizationId, input.organizationId), isNull(apiKey.revokedAt)));
    await recordAuditEvent(transaction, {
      name: audit.actor.type === "platform_operator" ? "platform.api_key.revoked" : "access.api_key.revoked", actor: audit.actor, organizationId: input.organizationId,
      target: { type: "api_key", id: input.keyId }, reason, summary: { displayPrefix: current.displayPrefix }, environment: audit.environment, correlationId: audit.correlationId, occurredAt: now,
    });
  });
}

export type ResolvedApiKey = Readonly<{ organizationId: string; serviceAccountId: string; verifier: string; environment: string; scopes: string[]; expiresAt: Date | null; revokedAt: Date | null; serviceAccountStatus: string; applicationRoles: string[] }>;

/**
 * Looks a key up by public ID before any tenant is known, through the
 * SECURITY DEFINER resolver granted only to trestle_app. The caller still
 * verifies the token against the returned verifier.
 */
export async function resolveApiKey(database: Database, publicId: string): Promise<ResolvedApiKey | null> {
  if (!/^[A-Za-z0-9]{16}$/u.test(publicId)) return null;
  const result = await database.execute(sql`select organization_id, service_account_id, verifier, environment, scopes, expires_at, revoked_at, service_account_status, application_roles from trestle_resolve_api_key(${publicId})`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const date = (value: unknown) => value === null || value === undefined ? null : new Date(value as string);
  return {
    organizationId: String(row.organization_id), serviceAccountId: String(row.service_account_id), verifier: String(row.verifier), environment: String(row.environment),
    scopes: row.scopes as string[], expiresAt: date(row.expires_at), revokedAt: date(row.revoked_at), serviceAccountStatus: String(row.service_account_status), applicationRoles: row.application_roles as string[],
  };
}

export type PlatformApiKey = ApiKeySummary & Readonly<{ organizationId: string; serviceAccountName: string }>;

/** API keys across organizations, without verifiers, for the platform admin. */
export async function listPlatformApiKeys(database: Database, options: Readonly<{ activeOnly?: boolean; limit?: number }> = {}): Promise<PlatformApiKey[]> {
  const limit = Math.min(Math.max(Math.trunc(Number.isFinite(options.limit) ? options.limit! : 100), 1), 200);
  return await database.select({ ...keyColumns, organizationId: apiKey.organizationId, serviceAccountName: serviceAccount.name }).from(apiKey)
    .innerJoin(serviceAccount, and(eq(serviceAccount.id, apiKey.serviceAccountId), eq(serviceAccount.organizationId, apiKey.organizationId)))
    .where(options.activeOnly ? isNull(apiKey.revokedAt) : undefined)
    .orderBy(desc(apiKey.createdAt)).limit(limit);
}

/** A platform operator revokes a key, for example a leaked one, audited on the owning organization. */
export async function platformRevokeApiKey(database: Database, input: Readonly<{ organizationId: string; keyId: string }>, context: PlatformChangeContext): Promise<void> {
  await revokeApiKey(database, { ...input, reason: context.reason }, { actor: context.actor, environment: context.environment, correlationId: context.correlationId, ...(context.now ? { now: context.now } : {}) });
}
