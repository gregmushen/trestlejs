import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { createTenantDatabase, PostgresArtifactMetadataRepository } from "@__TRESTLE_PROJECT_NAME__/db";
import { CloudflareR2ArtifactStore, createArtifactSigner, LocalArtifactStore, type ArtifactStore } from "@__TRESTLE_PROJECT_NAME__/integrations";
import { artifactRetentionDays } from "./artifact-retention.js";

const localArtifacts = new LocalArtifactStore();

export function artifactStore(environment: AuthEnvironment, organizationId: string): ArtifactStore {
  const days = artifactRetentionDays(environment.ARTIFACT_READY_RETENTION_DAYS);
  if (environment.TRESTLE_ARTIFACTS) {
    return new CloudflareR2ArtifactStore(
      environment.TRESTLE_ARTIFACTS,
      new PostgresArtifactMetadataRepository(createTenantDatabase(environment.DATABASE_URL, environment.DATABASE_DRIVER, organizationId)),
      days === null ? undefined : { maxAgeDays: days, now: () => new Date() },
    );
  }
  if (days !== null) throw new Error("Ready artifact retention requires the R2 binding");
  if (!environment.APP_ENV || environment.APP_ENV === "local") return localArtifacts;
  throw new Error("R2 artifact binding is required outside local development");
}

export function artifactSigner(environment: AuthEnvironment) {
  const secret = environment.ARTIFACT_SIGNING_SECRET
    ?? (!environment.APP_ENV || environment.APP_ENV === "local" ? environment.BETTER_AUTH_SECRET : undefined);
  if (!secret) throw new Error("ARTIFACT_SIGNING_SECRET is required outside local development");
  return createArtifactSigner(secret);
}

export function artifactRuntimeReady(environment: AuthEnvironment): boolean {
  return !environment.APP_ENV || environment.APP_ENV === "local"
    || Boolean(environment.TRESTLE_ARTIFACTS && environment.ARTIFACT_SIGNING_SECRET
      && new TextEncoder().encode(environment.ARTIFACT_SIGNING_SECRET).byteLength >= 32);
}
