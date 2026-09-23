import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { advanceArtifactOrphanCursor, createDatabase, createTenantDatabase, getArtifactOrphanCursor, hasArtifactStorageKey, nextMaintenanceOrganizations } from "@__TRESTLE_PROJECT_NAME__/db";
import type { R2BucketBinding, R2ListedObject } from "@__TRESTLE_PROJECT_NAME__/integrations";

export type ArtifactOrphanFinding = { organizationId: string; keyFingerprint: string; reason: "orphan" | "unavailable" };
export type ArtifactOrphanAuditResult = { organizations: number; listed: number; checked: number; skipped: number; orphaned: number; failed: number };

async function fingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read-only scan. Young objects are skipped because an upload can be between
 * its R2 write and PostgreSQL finalization. No raw R2 key reaches a log. */
export async function runArtifactOrphanAudit(
  organizationId: string,
  objects: readonly R2ListedObject[],
  hasReference: (organizationId: string, key: string) => Promise<boolean>,
  head: (key: string) => Promise<unknown | null>,
  finding: (item: ArtifactOrphanFinding) => void,
  now: Date,
): Promise<Omit<ArtifactOrphanAuditResult, "organizations">> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid artifact orphan audit clock");
  const result = { listed: objects.length, checked: 0, skipped: 0, orphaned: 0, failed: 0 };
  for (const object of objects) {
    // R2's prefix query is a convenience, not a security boundary.
    if (!object.key.startsWith(`${organizationId}/`) || !(object.uploaded instanceof Date) || !Number.isFinite(object.uploaded.getTime())) {
      result.failed += 1;
      finding({ organizationId, keyFingerprint: await fingerprint(object.key), reason: "unavailable" });
      continue;
    }
    if (object.uploaded.getTime() > now.getTime() - 60 * 60 * 1_000) { result.skipped += 1; continue; }
    try {
      if (await hasReference(organizationId, object.key)) { result.checked += 1; continue; }
      // Recheck both systems to avoid reporting an upload or deletion racing
      // the scan. A missing object needs no cleanup and is not an orphan.
      if (!await head(object.key) || await hasReference(organizationId, object.key)) { result.skipped += 1; continue; }
      result.checked += 1;
      result.orphaned += 1;
      finding({ organizationId, keyFingerprint: await fingerprint(object.key), reason: "orphan" });
    } catch {
      result.failed += 1;
      finding({ organizationId, keyFingerprint: await fingerprint(object.key), reason: "unavailable" });
    }
  }
  return result;
}

export async function auditArtifactOrphans(
  environment: AuthEnvironment,
  finding: (item: ArtifactOrphanFinding) => void,
  now = new Date(),
): Promise<ArtifactOrphanAuditResult> {
  const bucket: R2BucketBinding | undefined = environment.TRESTLE_ARTIFACTS;
  if (!bucket?.list || !bucket.head) throw new Error("Artifact orphan audit requires R2 list and head bindings");
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  const organizationIds = await nextMaintenanceOrganizations(database, "artifact-orphan-organizations", 5);
  const result: ArtifactOrphanAuditResult = { organizations: organizationIds.length, listed: 0, checked: 0, skipped: 0, orphaned: 0, failed: 0 };
  for (const organizationId of organizationIds) {
    try {
      const tenantDatabase = createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId, { readOnly: true });
      const cursor = await getArtifactOrphanCursor(database, organizationId);
      const page = await bucket.list({ prefix: `${organizationId}/`, limit: 25, ...(cursor ? { cursor } : {}) });
      if (page.objects.length > 25 || (page.truncated && (!page.cursor || page.cursor === cursor))) throw new Error("Invalid R2 list continuation");
      const scanned = await runArtifactOrphanAudit(organizationId, page.objects,
        (tenantId, key) => hasArtifactStorageKey(tenantDatabase, tenantId, key),
        (key) => bucket.head!(key), finding, now);
      for (const key of Object.keys(scanned) as Array<keyof typeof scanned>) result[key] += scanned[key];
      if (scanned.failed === 0 && !await advanceArtifactOrphanCursor(database, organizationId, cursor, page.truncated ? page.cursor! : "")) {
        result.failed += 1;
        finding({ organizationId, keyFingerprint: "", reason: "unavailable" });
      }
    } catch {
      result.failed += 1;
      finding({ organizationId, keyFingerprint: "", reason: "unavailable" });
    }
  }
  return result;
}
