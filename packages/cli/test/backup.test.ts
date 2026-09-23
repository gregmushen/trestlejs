import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRecoveryConnectionOutput, recoveryEvidencePassed, recoveryStatusLabel, validateRecoveryArtifactBucket, validateRecoveryPoint, validateRecoveryTarget, type RecoveryPolicy } from "../src/backup.js";

const policy: RecoveryPolicy = { schemaVersion: 1, provider: "neon", sourceBranch: "main", restoreTargets: ["restore-test"], recoveryPointObjectiveHours: 24, recoveryTimeObjectiveMinutes: 30, artifactPolicy: "metadata-reference-verification" };

describe("backup and restore safety", () => {
  it("allows only declared isolated targets", () => {
    expect(validateRecoveryTarget(policy, "restore-test")).toBe("restore-test");
    expect(() => validateRecoveryTarget(policy, "production")).toThrow("not declared");
    expect(() => validateRecoveryTarget({ ...policy, restoreTargets: ["main"] }, "main")).toThrow("isolated");
  });
  it("normalizes past points and rejects future points", () => {
    expect(validateRecoveryPoint("2025-01-01T00:00:00Z")).toBe("2025-01-01T00:00:00.000Z");
    expect(() => validateRecoveryPoint("2999-01-01T00:00:00Z")).toThrow("past");
  });
  it("parses protected connection output without weakening URL validation", () => {
    expect(parseRecoveryConnectionOutput("branch_id=br-restored\nmigration_url=postgres://migration:secret@db.test/app\nruntime_url=postgresql://runtime:secret@db.test/app\n")).toEqual({
      branchId: "br-restored",
      migrationUrl: "postgres://migration:secret@db.test/app",
      runtimeUrl: "postgresql://runtime:secret@db.test/app",
    });
    expect(() => parseRecoveryConnectionOutput("branch_id=br-restored\nmigration_url=https://db.test\nruntime_url=postgres://db.test/app\n")).toThrow("incomplete");
  });
  it("requires recovery R2 bucket identity to match the production Worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trestle-recovery-bucket-"));
    try {
      await mkdir(path.join(root, "apps", "worker"), { recursive: true });
      await writeFile(path.join(root, "apps", "worker", "wrangler.jsonc"), JSON.stringify({ env: { production: { name: "example-worker" } } }));
      await expect(validateRecoveryArtifactBucket(root, "apps/worker", { ...policy, artifactBucket: "example-worker-artifacts" })).resolves.toBeUndefined();
      await expect(validateRecoveryArtifactBucket(root, "apps/worker", { ...policy, artifactBucket: "other-bucket" })).rejects.toThrow("does not match");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("never labels missing, partial, or unverifiable restore evidence as verified", () => {
    const checks = ["database.reachable", "schema.migrations", "auth.integrity", "role.application", "rls.forced", "rls.runtime", "artifacts.references"]
      .map((id) => ({ id, status: "pass", evidence: "verified" }));
    const passed = { status: "passed", cleanup: "deleted", rtoMet: true, checks };
    expect(recoveryEvidencePassed(passed, "deleted", true)).toBe(true);
    expect(recoveryStatusLabel(passed)).toBe("passed");
    expect(recoveryEvidencePassed({ ...passed, checks: checks.slice(0, -1) }, "deleted", true)).toBe(false);
    expect(recoveryEvidencePassed({ ...passed, checks: [...checks.slice(0, -1), { id: "artifacts.references", status: "unverifiable" }] }, "deleted", true)).toBe(false);
    expect(recoveryEvidencePassed(passed, "not-attempted", true)).toBe(false);
    expect(recoveryEvidencePassed(passed, "deleted", false)).toBe(false);
    expect(recoveryStatusLabel(null)).toContain("not yet");
    expect(recoveryStatusLabel({ ...passed, rtoMet: false })).toContain("not verified");
  });
});
