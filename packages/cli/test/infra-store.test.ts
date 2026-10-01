import { describe, expect, it } from "vitest";

import { approvalCovers, approvalFor, generateApproverKeys, signApproval, verifyApprovalSignature } from "../src/infra/approvals.js";
import { decideReserve } from "../src/infra/stores/rules.js";
import { MemoryOperationStore } from "../src/infra/stores/memory.js";
import { PLAN, storeContract } from "./helpers/store-contract.js";

storeContract("memory", async () => new MemoryOperationStore());

const now = new Date("2026-10-02T00:00:00.000Z");

describe("approval records", () => {
  it("binds the signature to every payload field", () => {
    const keys = generateApproverKeys();
    const approval = signApproval(approvalFor(PLAN, { operationId: "op-1", approverId: "alice", now }), keys.privateKeyPem);
    expect(verifyApprovalSignature(approval, keys.publicKeyPem)).toBe(true);
    for (const change of [{ planDigest: "sha256:x" }, { operationId: "op-2" }, { environment: "production" }, { expiresAt: "2099-01-01T00:00:00.000Z" }, { target: { ...approval.payload.target, stripeAccountId: "acct_other00000" } }, { costLimit: { currency: "usd", monthlyMinor: 1 } }]) {
      expect(verifyApprovalSignature({ ...approval, payload: { ...approval.payload, ...change } }, keys.publicKeyPem), JSON.stringify(change)).toBe(false);
    }
    expect(verifyApprovalSignature(approval, generateApproverKeys().publicKeyPem)).toBe(false);
    expect(verifyApprovalSignature({ ...approval, signature: "not-base64!" }, keys.publicKeyPem)).toBe(false);
  });

  it("covers only the exact plan, target and effects, and never outlives the plan", () => {
    const keys = generateApproverKeys();
    const approval = signApproval(approvalFor(PLAN, { operationId: "op-1", approverId: "alice", ttlSeconds: 86_400, now }), keys.privateKeyPem);
    expect(approval.payload.expiresAt).toBe(PLAN.expiresAt);
    expect(approvalCovers(approval, PLAN, [], now)).toEqual([]);
    expect(approvalCovers(approval, { ...PLAN, digest: "sha256:altered" }, [], now)).toContain("approval is for a different plan digest");
    expect(approvalCovers(approval, { ...PLAN, target: { ...PLAN.target!, stripeAccountId: "acct_9999999999" } }, [], now)).toContain("approval targets a different account, project or environment");
    expect(approvalCovers(approval, PLAN, ["remote_resource_delete"], now)).toEqual(["effects not covered by approval: remote_resource_delete"]);
    expect(approvalCovers(approval, PLAN, [], new Date(PLAN.expiresAt))).toContain("approval has expired");
    expect(() => approvalFor({ ...PLAN, target: null }, { operationId: "x", approverId: "a", now })).toThrow(/reviewed target/u);
  });
});

describe("reservation rules", () => {
  const base = { scope: "s", operationId: "op-1", holder: "a", fencingToken: 1, leaseExpiresAt: "2026-10-02T00:00:10.000Z", state: "active" as const, inflightEffect: null };
  it("enumerates every decision", () => {
    expect(decideReserve(undefined, "op-1", "a", now)).toEqual({ action: "insert" });
    expect(decideReserve(base, "op-1", "a", now)).toEqual({ action: "renew" });
    expect(decideReserve(base, "op-2", "b", now)).toEqual({ action: "busy" });
    const later = new Date("2026-10-02T00:01:00.000Z");
    expect(decideReserve(base, "op-2", "b", later)).toEqual({ action: "takeover" });
    expect(decideReserve({ ...base, inflightEffect: "e" }, "op-2", "b", later)).toEqual({ action: "uncertain", mark: true });
    expect(decideReserve({ ...base, inflightEffect: "e" }, "op-1", "a", later)).toEqual({ action: "uncertain", mark: true });
    expect(decideReserve({ ...base, state: "uncertain" }, "op-1", "a", now)).toEqual({ action: "uncertain", mark: false });
  });
});
