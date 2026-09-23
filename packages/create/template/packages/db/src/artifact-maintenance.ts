import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import { artifactMetadata } from "./artifact-schema.js";
import { artifactMaintenanceCursor } from "./artifact-maintenance-schema.js";
import { organization } from "./auth-schema.js";
import type { Database } from "./index.js";

/** Advance one bounded page of canonical organizations. The compare-and-swap
 * prevents overlapping cron invocations from moving the cursor backwards. */
export async function nextMaintenanceOrganizations(database: Database, cursorName: string, limit = 25): Promise<string[]> {
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(cursorName)) throw new Error("Invalid maintenance cursor name");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid maintenance page size");
  await database.insert(artifactMaintenanceCursor).values({ name: cursorName }).onConflictDoNothing();
  const [cursor] = await database.select().from(artifactMaintenanceCursor).where(eq(artifactMaintenanceCursor.name, cursorName)).limit(1);
  if (!cursor) throw new Error("Artifact maintenance cursor is unavailable");
  let page = await database.select({ id: organization.id }).from(organization)
    .where(gt(organization.id, cursor.afterId)).orderBy(asc(organization.id)).limit(limit);
  if (page.length === 0 && cursor.afterId) {
    page = await database.select({ id: organization.id }).from(organization).orderBy(asc(organization.id)).limit(limit);
  }
  if (page.length === 0) return [];
  const advanced = await database.update(artifactMaintenanceCursor)
    .set({ afterId: page.at(-1)!.id, updatedAt: new Date() })
    .where(and(eq(artifactMaintenanceCursor.name, cursorName), eq(artifactMaintenanceCursor.afterId, cursor.afterId)))
    .returning();
  return advanced.length > 0 ? page.map(({ id }) => id) : [];
}

export async function nextArtifactMaintenanceOrganizations(database: Database, limit = 25): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid artifact maintenance page size");
  return nextMaintenanceOrganizations(database, "incomplete-artifacts", limit);
}

export type ArtifactReferenceCandidate = { id: string; organizationId: string };

export async function artifactReferenceCursorName(organizationId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/u.test(organizationId)) throw new Error("Invalid artifact audit organization");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationId));
  return `artifact-ref-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 48)}`;
}

export async function artifactOrphanCursorName(organizationId: string): Promise<string> {
  return (await artifactReferenceCursorName(organizationId)).replace("artifact-ref-", "artifact-orphan-");
}

/** Inspect a physical key only through the tenant role; pending and cleaning
 * reservations count as references while their cleanup is in flight. A retired
 * row does not protect a physical object from being reported as leaked. */
export async function hasArtifactStorageKey(tenantDatabase: Database, organizationId: string, key: string): Promise<boolean> {
  if (!key.startsWith(`${organizationId}/`)) throw new Error("Artifact key is outside the tenant prefix");
  const [record] = await tenantDatabase.select({ id: artifactMetadata.id }).from(artifactMetadata)
    .where(and(eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), ne(artifactMetadata.uploadState, "deleted"), isNull(artifactMetadata.deletedAt))).limit(1);
  return !!record;
}

/** The cursor is an opaque R2 continuation token, never an object key. */
export async function getArtifactOrphanCursor(cursorDatabase: Database, organizationId: string): Promise<string> {
  const name = await artifactOrphanCursorName(organizationId);
  await cursorDatabase.insert(artifactMaintenanceCursor).values({ name }).onConflictDoNothing();
  const [record] = await cursorDatabase.select({ afterId: artifactMaintenanceCursor.afterId }).from(artifactMaintenanceCursor)
    .where(eq(artifactMaintenanceCursor.name, name)).limit(1);
  if (!record) throw new Error("Artifact orphan audit cursor is unavailable");
  return record.afterId;
}

export async function advanceArtifactOrphanCursor(cursorDatabase: Database, organizationId: string, previous: string, next: string): Promise<boolean> {
  const name = await artifactOrphanCursorName(organizationId);
  return (await cursorDatabase.update(artifactMaintenanceCursor).set({ afterId: next, updatedAt: new Date() })
    .where(and(eq(artifactMaintenanceCursor.name, name), eq(artifactMaintenanceCursor.afterId, previous))).returning()).length > 0;
}

/** The login role advances only a cursor; artifact selection uses forced tenant
 * RLS. A hash keeps cursor names bounded without putting tenant IDs in names. */
export async function nextArtifactReferenceAuditCandidates(cursorDatabase: Database, tenantDatabase: Database, organizationId: string, limit = 25): Promise<ArtifactReferenceCandidate[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid artifact reference audit page size");
  const name = await artifactReferenceCursorName(organizationId);
  await cursorDatabase.insert(artifactMaintenanceCursor).values({ name }).onConflictDoNothing();
  const [cursor] = await cursorDatabase.select().from(artifactMaintenanceCursor).where(eq(artifactMaintenanceCursor.name, name)).limit(1);
  if (!cursor) throw new Error("Artifact reference audit cursor is unavailable");
  const active = and(eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.uploadState, "ready"), isNull(artifactMetadata.deletedAt));
  let page = await tenantDatabase.select({ id: artifactMetadata.id, organizationId: artifactMetadata.organizationId }).from(artifactMetadata)
    .where(and(active, gt(artifactMetadata.id, cursor.afterId))).orderBy(asc(artifactMetadata.id)).limit(limit);
  if (page.length === 0 && cursor.afterId) {
    page = await tenantDatabase.select({ id: artifactMetadata.id, organizationId: artifactMetadata.organizationId }).from(artifactMetadata)
      .where(active).orderBy(asc(artifactMetadata.id)).limit(limit);
  }
  if (page.length === 0) return [];
  const advanced = await cursorDatabase.update(artifactMaintenanceCursor)
    .set({ afterId: page.at(-1)!.id, updatedAt: new Date() })
    .where(and(eq(artifactMaintenanceCursor.name, name), eq(artifactMaintenanceCursor.afterId, cursor.afterId))).returning();
  return advanced.length > 0 ? page : [];
}
