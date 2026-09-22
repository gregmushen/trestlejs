import { bigint, index, pgPolicy, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const artifactMetadata = pgTable("artifact_metadata", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull(), storageKey: text("storage_key").notNull(),
  contentType: text("content_type").notNull(), size: bigint("size", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("artifact_metadata_organization_idx").on(table.organizationId),
  pgPolicy("artifact_metadata_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
]).enableRLS();
