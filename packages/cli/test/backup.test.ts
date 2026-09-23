import { describe, expect, it } from "vitest";
import { parseRecoveryConnectionOutput, recoveryEvidencePassed, recoveryStatusLabel, validateRecoveryPoint, validateRecoveryTarget, type RecoveryPolicy } from "../src/backup.js";

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
