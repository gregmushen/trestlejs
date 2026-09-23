export type RecoveryCheck = { id: string; status: "pass" | "fail" | "unverifiable"; evidence: string };

export function artifactReferenceCheck(policy: string | undefined, readyReferences: number): RecoveryCheck {
  if (!Number.isSafeInteger(readyReferences) || readyReferences < 0) return { id: "artifacts.references", status: "fail", evidence: "ready artifact reference count is invalid" };
  if (policy !== "metadata-reference-verification" && policy !== "none") return { id: "artifacts.references", status: "fail", evidence: "artifact recovery policy is not declared" };
  if (readyReferences === 0) return { id: "artifacts.references", status: "pass", evidence: "no ready artifact references require external object verification" };
  if (policy === "none") return { id: "artifacts.references", status: "fail", evidence: `${readyReferences} ready artifact references exist, but the recovery policy excludes artifact verification` };
  return { id: "artifacts.references", status: "unverifiable", evidence: `${readyReferences} ready artifact references require provider-specific R2 object verification` };
}

export function recoveryCheckStatus(checks: readonly RecoveryCheck[]): "passed" | "failed" {
  return checks.length > 0 && checks.every((check) => check.status === "pass") ? "passed" : "failed";
}
