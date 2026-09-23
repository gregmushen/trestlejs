import { describe, expect, it } from "vitest";
import { artifactReferenceCheck, recoveryCheckStatus } from "./recovery-evidence.js";
import { createR2RecoveryHead, verifyArtifactObjects, type ReadyArtifactReference } from "./recovery-r2.js";

describe("restore verification evidence", () => {
  it("passes only when there are no ready external artifact references", () => {
    const result = artifactReferenceCheck("metadata-reference-verification", 0);
    expect(result.status).toBe("pass");
    expect(recoveryCheckStatus([result])).toBe("passed");
  });

  it("does not claim a restore is verified while R2 references remain unchecked", () => {
    const result = artifactReferenceCheck("metadata-reference-verification", 3);
    expect(result).toMatchObject({ id: "artifacts.references", status: "unverifiable" });
    expect(recoveryCheckStatus([{ id: "database.reachable", status: "pass", evidence: "ok" }, result])).toBe("failed");
  });

  it("rejects an excluded or undeclared artifact policy when references exist", () => {
    expect(artifactReferenceCheck("none", 1).status).toBe("fail");
    expect(artifactReferenceCheck(undefined, 0).status).toBe("fail");
    expect(artifactReferenceCheck("metadata-reference-verification", -1).status).toBe("fail");
    expect(recoveryCheckStatus([])).toBe("failed");
  });

  it("passes only when every restored reference matches provider metadata", async () => {
    const references: ReadyArtifactReference[] = Array.from({ length: 205 }, (_, index) => ({
      id: String(index).padStart(4, "0"), organizationId: "org-a", key: `org-a/${String(index).padStart(4, "0")}/private`, contentType: "text/plain", size: 3,
    }));
    const pages: number[] = [];
    const result = await verifyArtifactObjects(references.length, async (afterId, limit) => {
      pages.push(limit);
      return references.filter((reference) => reference.id > afterId).slice(0, limit);
    }, async () => ({ size: 3, contentType: "text/plain", metadata: { organizationId: "org-a", artifactId: "0000" } }));
    // The provider's artifact ID must match each individual reference.
    expect(result).toMatchObject({ expected: 205, checked: 205, missing: 0, unavailable: 0, mismatched: 204 });
    expect(pages).toEqual([100, 100, 100, 100]);
    expect(artifactReferenceCheck("metadata-reference-verification", 205, result).status).toBe("fail");
    const clean = await verifyArtifactObjects(205, async (afterId, limit) => references.filter((reference) => reference.id > afterId).slice(0, limit),
      async (key) => ({ size: 3, contentType: "text/plain", metadata: { organizationid: "org-a", artifactid: key.split("/")[1]! } }));
    expect(artifactReferenceCheck("metadata-reference-verification", 205, clean).status).toBe("pass");
  });

  it("fails closed on missing, mismatched, unavailable, truncated, and unsorted pages", async () => {
    const references: ReadyArtifactReference[] = [
      { id: "a", organizationId: "org-a", key: "org-a/a", contentType: "text/plain", size: 1 },
      { id: "b", organizationId: "org-a", key: "org-a/b", contentType: "text/plain", size: 1 },
      { id: "c", organizationId: "org-a", key: "org-a/c", contentType: "text/plain", size: 1 },
    ];
    const result = await verifyArtifactObjects(3, async (afterId) => references.filter((reference) => reference.id > afterId), async (key) => {
      if (key.endsWith("/a")) return null;
      if (key.endsWith("/b")) return { size: 2, contentType: "text/plain", metadata: { organizationid: "org-a", artifactid: "b" } };
      throw new Error("private provider error");
    });
    expect(result).toEqual({ expected: 3, checked: 3, missing: 1, mismatched: 1, unavailable: 1 });
    expect(artifactReferenceCheck("metadata-reference-verification", 3, result)).toMatchObject({ status: "fail" });
    await expect(verifyArtifactObjects(3, async () => references.slice(0, 2), async () => null)).rejects.toThrow("pagination");
    await expect(verifyArtifactObjects(3, async () => references.slice(0, 1), async () => null)).rejects.toThrow("pagination");
    await expect(verifyArtifactObjects(3, async () => references.slice(1, 3).reverse(), async () => null)).rejects.toThrow("pagination");
    await expect(verifyArtifactObjects(3, async (afterId) => afterId ? [] : references.slice(0, 2), async () => null)).rejects.toThrow("count changed");
    expect(() => createR2RecoveryHead({ accountId: "invalid", accessKeyId: "", secretAccessKey: "", bucket: "bad" })).toThrow("missing or invalid");
  });
});
