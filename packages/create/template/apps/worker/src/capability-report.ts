import type { AuthEnvironment } from "@__TRESTLE_PROJECT_NAME__/auth";
import { applicationConnectionString, createSqlRunner } from "@__TRESTLE_PROJECT_NAME__/db";
import { computeCapabilityStatus, declaredCapabilities, type CapabilityStatus } from "@__TRESTLE_PROJECT_NAME__/platform";
import { sql } from "drizzle-orm";

// The project manifest is bundled as text (see wrangler.jsonc rules), so the
// declared capabilities have exactly one source of truth.
import manifestText from "../../../.trestle/project.yaml";

const reportIntervalMs = 5 * 60_000;
let lastReportedAt = 0;

export function currentCapabilityStatus(environment: AuthEnvironment): CapabilityStatus[] {
  return computeCapabilityStatus(declaredCapabilities(manifestText), environment.APP_ENV ?? "local", environment as unknown as Record<string, unknown>);
}

/** Writes the sanitized projection the platform admin reads. Presence and health only. */
export async function reportCapabilityStatus(environment: AuthEnvironment, now = Date.now()): Promise<boolean> {
  if (now - lastReportedAt < reportIntervalMs) return false;
  lastReportedAt = now;
  const target = environment.APP_ENV ?? "local";
  const runner = createSqlRunner(applicationConnectionString(environment.DATABASE_URL), environment.DATABASE_DRIVER);
  await runner.atomic(currentCapabilityStatus(environment).map((status) => sql`insert into capability_status (environment, capability_id, label, state, healthy, mode, message, repair, reported_at)
    values (${target}, ${status.id}, ${status.label}, ${status.state}, ${status.healthy}, ${status.mode ?? null}, ${status.message ?? null}, ${status.repair ?? null}, now())
    on conflict (environment, capability_id) do update set label = excluded.label, state = excluded.state, healthy = excluded.healthy, mode = excluded.mode, message = excluded.message, repair = excluded.repair, reported_at = now()`));
  return true;
}
