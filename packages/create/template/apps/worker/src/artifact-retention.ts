import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, createTenantDatabase, nextMaintenanceOrganizations, PostgresArtifactMetadataRepository } from "@__TRESTLE_PROJECT_NAME__/db";
import { CloudflareR2ArtifactStore } from "@__TRESTLE_PROJECT_NAME__/integrations";

export type ArtifactRetentionResult = { organizations: number; claimed: number; retired: number; failed: number };

/** Absent means indefinite retention; an invalid configured policy must never
 * silently become indefinite or trigger an unexpectedly broad purge. */
export function artifactRetentionDays(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,3}$/u.test(value)) throw new Error("ARTIFACT_READY_RETENTION_DAYS must be an integer from 1 to 3650");
  const days = Number(value);
  if (days > 3650) throw new Error("ARTIFACT_READY_RETENTION_DAYS must be an integer from 1 to 3650");
  return days;
}

export async function runArtifactReadyRetention(
  organizations: () => Promise<string[]>,
  expire: (organizationId: string, before: Date) => Promise<{ claimed: number; retired: number; failed: number }>,
  days: number,
  now: Date,
): Promise<ArtifactRetentionResult> {
  if (!Number.isInteger(days) || days < 1 || days > 3650 || !Number.isFinite(now.getTime())) throw new Error("Invalid artifact retention policy or clock");
  const before = new Date(now.getTime() - days * 86_400_000);
  const ids = await organizations();
  const result: ArtifactRetentionResult = { organizations: ids.length, claimed: 0, retired: 0, failed: 0 };
  for (const organizationId of ids) {
    try {
      const expired = await expire(organizationId, before);
      result.claimed += expired.claimed;
      result.retired += expired.retired;
      result.failed += expired.failed;
    } catch { result.failed += 1; }
  }
  return result;
}

export async function maintainReadyArtifacts(environment: AuthEnvironment, now = new Date()): Promise<ArtifactRetentionResult | null> {
  const days = artifactRetentionDays(environment.ARTIFACT_READY_RETENTION_DAYS);
  if (days === null) return null;
  if (!environment.TRESTLE_ARTIFACTS) throw new Error("Artifact retention requires the R2 binding");
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  return runArtifactReadyRetention(
    () => nextMaintenanceOrganizations(database, "ready-artifact-retention", 5),
    (organizationId, before) => new CloudflareR2ArtifactStore(
      environment.TRESTLE_ARTIFACTS!,
      new PostgresArtifactMetadataRepository(createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId)),
    ).expireReady(organizationId, before),
    days,
    now,
  );
}
