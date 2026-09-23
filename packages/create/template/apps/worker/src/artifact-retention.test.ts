import { describe, expect, it } from "vitest";
import { artifactRetentionDays, runArtifactReadyRetention } from "./artifact-retention.js";

describe("ready artifact retention", () => {
  it("is opt-in and rejects ambiguous or unbounded periods", () => {
    expect(artifactRetentionDays(undefined)).toBeNull();
    expect(artifactRetentionDays("30")).toBe(30);
    for (const value of ["", "0", "01", "1.5", "-1", "3651", "unlimited", " 30 "]) {
      expect(() => artifactRetentionDays(value)).toThrow("ARTIFACT_READY_RETENTION_DAYS");
    }
  });

  it("uses an injected clock, bounded tenants, and continues after one tenant fails", async () => {
    const seen: string[] = [];
    const result = await runArtifactReadyRetention(
      async () => ["org-a", "org-b", "org-c"],
      async (id, before) => {
        seen.push(id);
        expect(before.toISOString()).toBe("2026-08-23T12:00:00.000Z");
        if (id === "org-b") throw new Error("provider unavailable");
        return { claimed: 2, retired: 1, failed: 1 };
      },
      30,
      new Date("2026-09-22T12:00:00.000Z"),
    );
    expect(seen).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, claimed: 4, retired: 2, failed: 3 });
    await expect(runArtifactReadyRetention(async () => { throw new Error("should not scan"); }, async () => ({ claimed: 0, retired: 0, failed: 0 }), 0, new Date())).rejects.toThrow("Invalid artifact retention");
    await expect(runArtifactReadyRetention(async () => { throw new Error("should not scan"); }, async () => ({ claimed: 0, retired: 0, failed: 0 }), 30, new Date(NaN))).rejects.toThrow("Invalid artifact retention");
  });
});
