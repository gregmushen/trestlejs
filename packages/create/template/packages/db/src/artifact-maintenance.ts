import { and, asc, eq, gt } from "drizzle-orm";
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
    .where(gt(organization.id, cursor.afterOrganizationId)).orderBy(asc(organization.id)).limit(limit);
  if (page.length === 0 && cursor.afterOrganizationId) {
    page = await database.select({ id: organization.id }).from(organization).orderBy(asc(organization.id)).limit(limit);
  }
  if (page.length === 0) return [];
  const advanced = await database.update(artifactMaintenanceCursor)
    .set({ afterOrganizationId: page.at(-1)!.id, updatedAt: new Date() })
    .where(and(eq(artifactMaintenanceCursor.name, cursorName), eq(artifactMaintenanceCursor.afterOrganizationId, cursor.afterOrganizationId)))
    .returning();
  return advanced.length > 0 ? page.map(({ id }) => id) : [];
}

export async function nextArtifactMaintenanceOrganizations(database: Database, limit = 25): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid artifact maintenance page size");
  return nextMaintenanceOrganizations(database, "incomplete-artifacts", limit);
}
