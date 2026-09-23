import { describe, expect, it } from "vitest";

import { runArtifactMaintenance } from "./artifact-maintenance.js";

describe("artifact maintenance", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");

  it("recovers each tenant using a one-hour cutoff and counts failures without starving later tenants", async () => {
    const visited: string[] = [];
    const result = await runArtifactMaintenance(
      async () => ["org-a", "org-b", "org-c"],
      async (organizationId, before) => {
        visited.push(organizationId);
        expect(before.toISOString()).toBe("2026-09-22T11:00:00.000Z");
        if (organizationId === "org-b") throw new Error("R2 unavailable");
        return { claimed: 2, retired: 1, failed: 1 };
      },
      now,
    );
    expect(visited).toEqual(["org-a", "org-b", "org-c"]);
    expect(result).toEqual({ organizations: 3, claimed: 4, retired: 2, failed: 3 });
  });

  it("rejects a broken clock before inspecting any tenant", async () => {
    await expect(runArtifactMaintenance(async () => { throw new Error("should not run"); }, async () => ({ claimed: 0, retired: 0, failed: 0 }), new Date(NaN)))
      .rejects.toThrow("Invalid artifact maintenance clock");
  });
});
