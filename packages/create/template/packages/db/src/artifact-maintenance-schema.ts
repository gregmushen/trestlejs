import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const artifactMaintenanceCursor = pgTable("artifact_maintenance_cursor", {
  name: text("name").primaryKey(),
  // The physical column predates artifact-reference scans; each named cursor
  // stores an opaque last-seen ID for its own bounded keyset traversal.
  afterId: text("after_organization_id").default("").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
