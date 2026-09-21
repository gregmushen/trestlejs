import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const tenantRecord = pgTable(
  "tenant_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("tenant_record_organization_idx").on(table.organizationId)],
);
