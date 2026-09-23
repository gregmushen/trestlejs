import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const connectionString = process.env.TRESTLE_RLS_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const sql = connectionString ? postgres(connectionString, { max: 1, prepare: false }) : undefined;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/verify-recovery.ts", import.meta.url));
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const artifactId = `recovery-${suffix}`;

suite("isolated restore evidence", () => {
  afterAll(async () => { await sql!.end(); });

  it("reports a failed restore when PostgreSQL still references an unverified R2 object", async () => {
    try {
      await sql!`insert into artifact_metadata (id, organization_id, storage_key, content_type, size, upload_state) values (${artifactId}, 'recovery-org', ${`recovery-org/${artifactId}`}, 'text/plain', 1, 'ready')`;
      const stdout = execFileSync("pnpm", ["exec", "tsx", script], {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, DATABASE_MIGRATION_URL: connectionString!, DATABASE_URL: connectionString!, TRESTLE_ARTIFACT_POLICY: "metadata-reference-verification" },
      });
      const report = JSON.parse(stdout) as { status: string; checks: Array<{ id: string; status: string; evidence: string }> };
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "artifacts.references")).toMatchObject({ status: "unverifiable" });
      expect(stdout).not.toContain(connectionString!);
    } finally {
      await sql!`delete from artifact_metadata where id = ${artifactId}`;
    }
  });
});
