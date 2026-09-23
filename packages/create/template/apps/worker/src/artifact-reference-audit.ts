import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createDatabase, createTenantDatabase, nextArtifactReferenceAuditCandidates, nextMaintenanceOrganizations, PostgresArtifactMetadataRepository, type ArtifactReferenceCandidate } from "@__TRESTLE_PROJECT_NAME__/db";
import type { ArtifactMetadata, R2ObjectMetadata } from "@__TRESTLE_PROJECT_NAME__/integrations";

export type ArtifactReferenceAuditResult = {
  selected: number;
  checked: number;
  skipped: number;
  missing: number;
  mismatched: number;
  failed: number;
};

export type ArtifactReferenceFinding = { organizationId: string; artifactId: string; reason: "missing" | "mismatched" | "unavailable" };

/** Read-only verification: selected IDs have no authority until reloaded through
 * the tenant database. A concurrent deletion is rechecked before reporting a miss. */
export async function runArtifactReferenceAudit(
  candidates: readonly ArtifactReferenceCandidate[],
  lookup: (organizationId: string, id: string) => Promise<ArtifactMetadata | null>,
  head: (key: string) => Promise<R2ObjectMetadata | null>,
  finding: (item: ArtifactReferenceFinding) => void,
): Promise<ArtifactReferenceAuditResult> {
  const result: ArtifactReferenceAuditResult = { selected: candidates.length, checked: 0, skipped: 0, missing: 0, mismatched: 0, failed: 0 };
  for (const candidate of candidates) {
    let metadata: ArtifactMetadata | null;
    try { metadata = await lookup(candidate.organizationId, candidate.id); }
    catch { result.failed += 1; finding({ organizationId: candidate.organizationId, artifactId: candidate.id, reason: "unavailable" }); continue; }
    if (!metadata) { result.skipped += 1; continue; }
    let object: R2ObjectMetadata | null;
    try { object = await head(metadata.key); }
    catch { result.failed += 1; finding({ organizationId: candidate.organizationId, artifactId: candidate.id, reason: "unavailable" }); continue; }
    if (!object) {
      try {
        if (!await lookup(candidate.organizationId, candidate.id)) { result.skipped += 1; continue; }
      } catch { result.failed += 1; finding({ organizationId: candidate.organizationId, artifactId: candidate.id, reason: "unavailable" }); continue; }
      result.checked += 1;
      result.missing += 1;
      finding({ organizationId: candidate.organizationId, artifactId: candidate.id, reason: "missing" });
      continue;
    }
    const mismatched = object.size !== metadata.size || object.httpMetadata?.contentType !== metadata.contentType
      || object.customMetadata?.organizationId !== metadata.organizationId || object.customMetadata?.artifactId !== metadata.id;
    if (mismatched) {
      try {
        const current = await lookup(candidate.organizationId, candidate.id);
        if (!current || current.key !== metadata.key) { result.skipped += 1; continue; }
      } catch { result.failed += 1; finding({ organizationId: candidate.organizationId, artifactId: candidate.id, reason: "unavailable" }); continue; }
    }
    result.checked += 1;
    if (mismatched) {
      result.mismatched += 1;
      finding({ organizationId: candidate.organizationId, artifactId: candidate.id, reason: "mismatched" });
    }
  }
  return result;
}

export async function auditArtifactReferences(
  environment: AuthEnvironment,
  finding: (item: ArtifactReferenceFinding) => void,
): Promise<ArtifactReferenceAuditResult> {
  const bucket = environment.TRESTLE_ARTIFACTS;
  if (!bucket?.head) throw new Error("Artifact reference audit requires the R2 head binding");
  const database = createDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER);
  const organizationIds = await nextMaintenanceOrganizations(database, "artifact-reference-organizations", 5);
  const result: ArtifactReferenceAuditResult = { selected: 0, checked: 0, skipped: 0, missing: 0, mismatched: 0, failed: 0 };
  for (const organizationId of organizationIds) {
    try {
      const tenantDatabase = createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId);
      const repository = new PostgresArtifactMetadataRepository(tenantDatabase);
      const candidates = await nextArtifactReferenceAuditCandidates(database, tenantDatabase, organizationId);
      const page = await runArtifactReferenceAudit(candidates, (tenantId, id) => repository.get(tenantId, id), (key) => bucket.head!(key), finding);
      for (const key of Object.keys(result) as Array<keyof ArtifactReferenceAuditResult>) result[key] += page[key];
    } catch { result.failed += 1; finding({ organizationId, artifactId: "", reason: "unavailable" }); }
  }
  return result;
}
