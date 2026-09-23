import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const artifactMaintenanceCursor = pgTable("artifact_maintenance_cursor", {
  name: text("name").primaryKey(),
  afterOrganizationId: text("after_organization_id").default("").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
