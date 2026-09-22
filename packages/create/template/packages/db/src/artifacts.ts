import type { ArtifactMetadata, ArtifactMetadataRepository } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { and, eq, isNull } from "drizzle-orm";

import { artifactMetadata } from "./artifact-schema.js";
import type { Database } from "./index.js";

export class PostgresArtifactMetadataRepository implements ArtifactMetadataRepository {
  constructor(private readonly database: Database) {}

  async put(metadata: ArtifactMetadata): Promise<ArtifactMetadata> {
    const [record] = await this.database.insert(artifactMetadata).values({ id: metadata.id, organizationId: metadata.organizationId, storageKey: metadata.key, contentType: metadata.contentType, size: metadata.size, createdAt: metadata.createdAt }).onConflictDoUpdate({ target: artifactMetadata.id, set: { storageKey: metadata.key, contentType: metadata.contentType, size: metadata.size, deletedAt: null }, setWhere: eq(artifactMetadata.organizationId, metadata.organizationId) }).returning();
    if (!record) throw new Error("artifact identifier belongs to another organization");
    return { id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt };
  }

  async get(organizationId: string, id: string): Promise<ArtifactMetadata | null> {
    const [record] = await this.database.select().from(artifactMetadata).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), isNull(artifactMetadata.deletedAt))).limit(1);
    return record ? { id: record.id, organizationId: record.organizationId, key: record.storageKey, contentType: record.contentType, size: record.size, createdAt: record.createdAt } : null;
  }

  async remove(organizationId: string, id: string): Promise<boolean> {
    return (await this.database.update(artifactMetadata).set({ deletedAt: new Date() }).where(and(eq(artifactMetadata.id, id), eq(artifactMetadata.organizationId, organizationId), isNull(artifactMetadata.deletedAt))).returning()).length > 0;
  }
}
