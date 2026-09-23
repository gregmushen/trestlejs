import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, createTenantDatabase, nextArtifactMaintenanceOrganizations, PostgresArtifactMetadataRepository } from "@__TRESTLE_PROJECT_NAME__/db";
import { CloudflareR2ArtifactStore } from "@__TRESTLE_PROJECT_NAME__/integrations";

export type ArtifactMaintenanceResult = { organizations: number; claimed: number; retired: number; failed: number };

export async function runArtifactMaintenance(
  organizations: () => Promise<string[]>,
  recover: (organizationId: string, before: Date) => Promise<{ claimed: number; retired: number; failed: number }>,
  now: Date,
): Promise<ArtifactMaintenanceResult> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid artifact maintenance clock");
  const before = new Date(now.getTime() - 60 * 60 * 1_000);
  const ids = await organizations();
  const result: ArtifactMaintenanceResult = { organizations: ids.length, claimed: 0, retired: 0, failed: 0 };
  for (const organizationId of ids) {
    try {
      const recovered = await recover(organizationId, before);
      result.claimed += recovered.claimed;
      result.retired += recovered.retired;
      result.failed += recovered.failed;
    } catch { result.failed += 1; }
  }
  return result;
}

export async function maintainArtifacts(environment: AuthEnvironment, now = new Date()): Promise<ArtifactMaintenanceResult> {
  if (!environment.TRESTLE_ARTIFACTS) throw new Error("Artifact maintenance requires the R2 binding");
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  return runArtifactMaintenance(
    () => nextArtifactMaintenanceOrganizations(database),
    (organizationId, before) => new CloudflareR2ArtifactStore(
      environment.TRESTLE_ARTIFACTS!,
      new PostgresArtifactMetadataRepository(createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId)),
    ).recoverIncomplete(organizationId, before),
    now,
  );
}
