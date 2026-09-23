import { bigint, check, index, pgPolicy, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const artifactMetadata = pgTable("artifact_metadata", {
  id: text("id").primaryKey(), organizationId: text("organization_id").notNull(), storageKey: text("storage_key").notNull(),
  contentType: text("content_type").notNull(), size: bigint("size", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
  uploadState: text("upload_state").default("pending").notNull(),
}, (table) => [
  index("artifact_metadata_organization_idx").on(table.organizationId),
  index("artifact_metadata_upload_state_idx").on(table.uploadState, table.createdAt),
  check("artifact_metadata_upload_state_check", sql`${table.uploadState} IN ('pending', 'ready', 'cleaning', 'deleted')`),
  pgPolicy("artifact_metadata_tenant", { for: "all", to: "trestle_app", using: sql`${table.organizationId} = current_setting('app.organization_id', true)`, withCheck: sql`${table.organizationId} = current_setting('app.organization_id', true)` }),
  // Platform reads are limited by column grants; storage keys are never granted.
  pgPolicy("artifact_metadata_platform_select", { for: "select", to: "trestle_platform", using: sql`true` }),
]).enableRLS();
