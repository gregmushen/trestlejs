import { describe, expect, it } from "vitest";
import { auditArtifactOrphans, runArtifactOrphanAudit, type ArtifactOrphanFinding } from "./artifact-orphan-audit.js";

const now = new Date("2026-09-23T12:00:00Z");
const old = new Date("2026-09-23T10:00:00Z");
const object = (key: string, uploaded = old) => ({ key, uploaded, size: 1 });

describe("bounded R2 orphan audit", () => {
  it("separates referenced, young, missing, and orphaned objects without logging raw keys", async () => {
    const findings: ArtifactOrphanFinding[] = [];
    const calls: string[] = [];
    const result = await runArtifactOrphanAudit("org-a", [object("org-a/used/secret"), object("org-a/new/secret", new Date("2026-09-23T11:30:00Z")), object("org-a/gone/secret"), object("org-a/orphan/secret")],
      async (_organizationId, key) => { calls.push(key); return key.includes("used"); },
      async (key) => key.includes("gone") ? null : object(key),
      (finding) => findings.push(finding), now);
    expect(result).toEqual({ listed: 4, checked: 2, skipped: 2, orphaned: 1, failed: 0 });
    expect(calls).toEqual(["org-a/used/secret", "org-a/gone/secret", "org-a/orphan/secret", "org-a/orphan/secret"]);
    expect(findings).toMatchObject([{ organizationId: "org-a", reason: "orphan" }]);
    expect(findings[0]!.keyFingerprint).toMatch(/^[a-f0-9]{24}$/u);
    expect(JSON.stringify(findings)).not.toContain("secret");
  });

  it("does not report an upload that commits its reservation during the scan", async () => {
    const findings: ArtifactOrphanFinding[] = [];
    let lookups = 0;
    const result = await runArtifactOrphanAudit("org-a", [object("org-a/new/secret")], async () => ++lookups > 1,
      async () => object("org-a/new/secret"), (finding) => findings.push(finding), now);
    expect(result).toMatchObject({ checked: 0, skipped: 1, orphaned: 0, failed: 0 });
    expect(findings).toEqual([]);
  });

  it("fails closed on foreign keys, invalid clocks, and provider or database outages", async () => {
    const findings: ArtifactOrphanFinding[] = [];
    const result = await runArtifactOrphanAudit("org-a", [object("org-b/foreign"), object("org-a/db-down"), object("org-a/r2-down")],
      async (_organizationId, key) => { if (key.includes("db-down")) throw new Error("sensitive database failure"); return false; },
      async () => { throw new Error("sensitive provider failure"); }, (finding) => findings.push(finding), now);
    expect(result).toEqual({ listed: 3, checked: 0, skipped: 0, orphaned: 0, failed: 3 });
    expect(findings.every((finding) => finding.reason === "unavailable")).toBe(true);
    expect(JSON.stringify(findings)).not.toMatch(/foreign|db-down|r2-down|sensitive/u);
    await expect(runArtifactOrphanAudit("org-a", [], async () => false, async () => null, () => undefined, new Date(NaN))).rejects.toThrow("clock");
  });

  it("requires listing and metadata-only inspection from R2", async () => {
    await expect(auditArtifactOrphans({ DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "unused", TRESTLE_ARTIFACTS: {
      put: async () => undefined, get: async () => null, delete: async () => undefined,
    } }, () => undefined)).rejects.toThrow("list and head");
  });
});
