import type { ArtifactMetadata, ArtifactMetadataRepository } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";

import { artifactMetadata } from "./artifact-schema.js";
import type { Database } from "./index.js";

export class PostgresArtifactMetadataRepository implements ArtifactMetadataRepository {
  constructor(private readonly database: Database) {}

  async put(metadata: ArtifactMetadata): Promise<ArtifactMetadata> {
    const [record] = await this.database.insert(artifactMetadata).values({ id: metadata.id, organizationId: metadata.organizationId, storageKey: metadata.key, contentType: metadata.contentType, size: metadata.size, createdAt: metadata.createdAt, uploadState: "pending" }).onConflictDoNothing().returning();
    if (!record) throw new Error("artifact identifier is unavailable");
    return { id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt };
  }

  async complete(organizationId: string, id: string, key: string): Promise<boolean> {
    return (await this.database.update(artifactMetadata).set({ uploadState: "ready" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), eq(artifactMetadata.uploadState, "pending"), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async get(organizationId: string, id: string): Promise<ArtifactMetadata | null> {
    const [record] = await this.database.select().from(artifactMetadata).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.uploadState, "ready"), isNull(artifactMetadata.deletedAt))).limit(1);
    return record ? { id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt } : null;
  }

  async beginDeletion(organizationId: string, id: string): Promise<ArtifactMetadata | null> {
    const [record] = await this.database.update(artifactMetadata).set({ uploadState: "cleaning" }).where(and(
      eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId),
      inArray(artifactMetadata.uploadState, ["ready", "cleaning"]), isNull(artifactMetadata.deletedAt),
    )).returning();
    return record ? { id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt } : null;
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    return (await this.database.update(artifactMetadata).set({ deletedAt: new Date(), uploadState: "deleted" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.uploadState, "ready"), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async discard(organizationId: string, id: string, key: string): Promise<boolean> {
    return (await this.database.delete(artifactMetadata).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), eq(artifactMetadata.uploadState, "pending"), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async retire(organizationId: string, id: string, key: string): Promise<boolean> {
    return (await this.database.update(artifactMetadata).set({ deletedAt: new Date(), uploadState: "deleted" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async listIncomplete(organizationId: string, before: Date, limit: number): Promise<ArtifactMetadata[]> {
    if (!Number.isFinite(before.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid artifact recovery parameters");
    const records = await this.database.select().from(artifactMetadata).where(and(eq(artifactMetadata.organizationId, organizationId), lt(artifactMetadata.createdAt, before), inArray(artifactMetadata.uploadState, ["pending", "cleaning"]), isNull(artifactMetadata.deletedAt))).orderBy(asc(artifactMetadata.createdAt), asc(artifactMetadata.id)).limit(limit);
    return records.map((record) => ({ id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt }));
  }

  async claimIncomplete(organizationId: string, id: string, key: string, before: Date): Promise<boolean> {
    if (!Number.isFinite(before.getTime())) throw new Error("Invalid artifact recovery cutoff");
    return (await this.database.update(artifactMetadata).set({ uploadState: "cleaning" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), lt(artifactMetadata.createdAt, before), inArray(artifactMetadata.uploadState, ["pending", "cleaning"]), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async listExpiredReady(organizationId: string, before: Date, limit: number): Promise<ArtifactMetadata[]> {
    if (!Number.isFinite(before.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid artifact retention parameters");
    const records = await this.database.select().from(artifactMetadata).where(and(eq(artifactMetadata.organizationId, organizationId), lt(artifactMetadata.createdAt, before), eq(artifactMetadata.uploadState, "ready"), isNull(artifactMetadata.deletedAt))).orderBy(asc(artifactMetadata.createdAt), asc(artifactMetadata.id)).limit(limit);
    return records.map((record) => ({ id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt }));
  }

  async claimExpiredReady(organizationId: string, id: string, key: string, before: Date): Promise<boolean> {
    if (!Number.isFinite(before.getTime())) throw new Error("Invalid artifact retention cutoff");
    return (await this.database.update(artifactMetadata).set({ uploadState: "cleaning" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), lt(artifactMetadata.createdAt, before), eq(artifactMetadata.uploadState, "ready"), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }
}
