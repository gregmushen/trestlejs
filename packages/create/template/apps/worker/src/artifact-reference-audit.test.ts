import { describe, expect, it } from "vitest";
import { auditArtifactReferences, runArtifactReferenceAudit, type ArtifactReferenceFinding } from "./artifact-reference-audit.js";
import type { ArtifactMetadata } from "@__TRESTLE_PROJECT_NAME__/integrations";

const metadata = (id: string, organizationId = "org-a"): ArtifactMetadata => ({
  id, organizationId, key: `${organizationId}/${id}/object`, contentType: "text/plain", size: 3, createdAt: new Date("2026-01-01T00:00:00Z"),
});

describe("bounded R2 reference audit", () => {
  it("checks metadata only after a tenant-scoped reload and reports no object contents", async () => {
    const findings: ArtifactReferenceFinding[] = [];
    const keys: string[] = [];
    const result = await runArtifactReferenceAudit(
      [{ id: "good", organizationId: "org-a" }, { id: "removed", organizationId: "org-a" }, { id: "missing", organizationId: "org-b" }, { id: "mismatch", organizationId: "org-a" }],
      async (organizationId, id) => id === "removed" ? null : metadata(id, organizationId),
      async (key) => { keys.push(key); if (key.includes("missing")) return null; return { size: key.includes("mismatch") ? 4 : 3, httpMetadata: { contentType: "text/plain" }, customMetadata: { organizationId: key.split("/")[0]!, artifactId: key.split("/")[1]! } }; },
      (item) => findings.push(item),
    );
    expect(result).toEqual({ selected: 4, checked: 3, skipped: 1, missing: 1, mismatched: 1, failed: 0 });
    expect(keys).toEqual(["org-a/good/object", "org-b/missing/object", "org-a/mismatch/object"]);
    expect(findings).toEqual([
      { organizationId: "org-b", artifactId: "missing", reason: "missing" },
      { organizationId: "org-a", artifactId: "mismatch", reason: "mismatched" },
    ]);
    expect(JSON.stringify(findings)).not.toContain("/object");
  });

  it("does not report a missing object after concurrent authorized deletion", async () => {
    let lookups = 0;
    const findings: ArtifactReferenceFinding[] = [];
    const result = await runArtifactReferenceAudit(
      [{ id: "deleted", organizationId: "org-a" }],
      async () => ++lookups === 1 ? metadata("deleted") : null,
      async () => null,
      (item) => findings.push(item),
    );
    expect(result).toEqual({ selected: 1, checked: 0, skipped: 1, missing: 0, mismatched: 0, failed: 0 });
    expect(findings).toEqual([]);
  });

  it("does not report metadata drift for an artifact deleted during HEAD", async () => {
    let lookups = 0;
    const findings: ArtifactReferenceFinding[] = [];
    const result = await runArtifactReferenceAudit(
      [{ id: "deleted", organizationId: "org-a" }],
      async () => ++lookups === 1 ? metadata("deleted") : null,
      async () => ({ size: 99 }),
      (item) => findings.push(item),
    );
    expect(result).toEqual({ selected: 1, checked: 0, skipped: 1, missing: 0, mismatched: 0, failed: 0 });
    expect(findings).toEqual([]);
  });

  it.each([
    { label: "size", object: { size: 4, httpMetadata: { contentType: "text/plain" }, customMetadata: { organizationId: "org-a", artifactId: "a" } } },
    { label: "content type", object: { size: 3, httpMetadata: { contentType: "application/pdf" }, customMetadata: { organizationId: "org-a", artifactId: "a" } } },
    { label: "owner", object: { size: 3, httpMetadata: { contentType: "text/plain" }, customMetadata: { organizationId: "org-b", artifactId: "a" } } },
    { label: "artifact ID", object: { size: 3, httpMetadata: { contentType: "text/plain" }, customMetadata: { organizationId: "org-a", artifactId: "b" } } },
  ])("reports $label drift without mutating the reference", async ({ object }) => {
    const findings: ArtifactReferenceFinding[] = [];
    const result = await runArtifactReferenceAudit([{ id: "a", organizationId: "org-a" }], async () => metadata("a"), async () => object, (item) => findings.push(item));
    expect(result).toMatchObject({ checked: 1, mismatched: 1, missing: 0, failed: 0 });
    expect(findings).toEqual([{ organizationId: "org-a", artifactId: "a", reason: "mismatched" }]);
  });

  it("distinguishes provider or database outage from a confirmed missing object", async () => {
    const findings: ArtifactReferenceFinding[] = [];
    const result = await runArtifactReferenceAudit(
      [{ id: "db-down", organizationId: "org-a" }, { id: "r2-down", organizationId: "org-b" }],
      async (organizationId, id) => { if (id === "db-down") throw new Error("Postgres unavailable"); return metadata(id, organizationId); },
      async () => { throw new Error("R2 unavailable"); },
      (item) => findings.push(item),
    );
    expect(result).toEqual({ selected: 2, checked: 0, skipped: 0, missing: 0, mismatched: 0, failed: 2 });
    expect(findings.map((item) => item.reason)).toEqual(["unavailable", "unavailable"]);
  });

  it("fails closed when a purported R2 binding cannot inspect object metadata", async () => {
    await expect(auditArtifactReferences({ DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "unused", TRESTLE_ARTIFACTS: {
      put: async () => undefined, get: async () => null, delete: async () => undefined,
    } }, () => undefined)).rejects.toThrow("R2 head binding");
  });
});
