import { describe, expect, it } from "vitest";
import { artifactReferenceCheck, recoveryCheckStatus } from "./recovery-evidence.js";

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
});
