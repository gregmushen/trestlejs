import type { ArtifactMetadata, ArtifactMetadataRepository } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq, isNull } from "drizzle-orm";

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

  async remove(organizationId: string, id: string): Promise<boolean> {
    return (await this.database.update(artifactMetadata).set({ deletedAt: new Date(), uploadState: "deleted" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.uploadState, "ready"), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async discard(organizationId: string, id: string, key: string): Promise<boolean> {
    return (await this.database.delete(artifactMetadata).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), eq(artifactMetadata.uploadState, "pending"), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }

  async retire(organizationId: string, id: string, key: string): Promise<boolean> {
    return (await this.database.update(artifactMetadata).set({ deletedAt: new Date(), uploadState: "deleted" }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), eq(artifactMetadata.storageKey, key), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }
}
