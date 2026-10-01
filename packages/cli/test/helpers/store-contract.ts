import { describe, expect, it } from "vitest";

import { approvalFor, generateApproverKeys, signApproval } from "../../src/infra/approvals.js";
import type { InfraPlan } from "../../src/infra/planner.js";
import { StoreConflictError, type OperationStore } from "../../src/infra/store.js";

const t0 = new Date("2026-10-02T00:00:00.000Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

export const PLAN: InfraPlan = {
  schemaVersion: 1, kind: "trestle.infra.plan", environment: "staging", sourceDigest: "sha256:source", toolchain: null,
  target: { trestleProjectId: "t", stripeAccountId: "acct_1234567890", projectsProjectId: "proj_abc", projectsEnvironment: "staging", bindingGeneration: 1 },
  observedAt: t0.toISOString(), stale: false, operations: [], orphans: [], blockers: [], createdAt: t0.toISOString(), expiresAt: at(3600).toISOString(), digest: "sha256:plan",
};

/** One behavioral contract, run against every store backend. */
export function storeContract(name: string, open: () => Promise<OperationStore & { close?: () => Promise<void> }>): void {
  const withStore = (test: (store: OperationStore) => Promise<void>) => async () => {
    const store = await open();
    try {
      await test(store);
    } finally {
      await store.close?.();
    }
  };

  async function approved(store: OperationStore, operationId = "op-1") {
    const keys = generateApproverKeys();
    await store.registerApprover("alice", keys.publicKeyPem, ["staging"], t0);
    const approval = signApproval(approvalFor(PLAN, { operationId, approverId: "alice", now: t0 }), keys.privateKeyPem);
    return { keys, approval };
  }

  describe(`${name} control store`, () => {
    it("consumes an approval once and treats replay as resume, never a second authorization (AR-01)", withStore(async (store) => {
      const { approval } = await approved(store);
      await store.recordApproval(approval, t0);
      expect(await store.consumeApproval(approval.payload.approvalId, "op-1", PLAN.digest, at(1))).toEqual({ status: "consumed" });
      expect(await store.consumeApproval(approval.payload.approvalId, "op-1", PLAN.digest, at(2))).toEqual({ status: "already_consumed_by_operation" });
      expect(await store.consumeApproval(approval.payload.approvalId, "op-2", PLAN.digest, at(2))).toMatchObject({ status: "rejected" });
      await expect(store.recordApproval(approval, at(3))).rejects.toThrow(StoreConflictError);
    }));

    it("rejects tampered, re-targeted, unregistered, revoked, out-of-scope and expired approvals", withStore(async (store) => {
      const { approval, keys } = await approved(store);
      const tampered = { ...approval, payload: { ...approval.payload, allowedEffects: [...approval.payload.allowedEffects, "remote_resource_delete" as const] } };
      await expect(store.recordApproval(tampered, t0)).rejects.toThrow(/signature is invalid/u);
      const forged = signApproval({ ...approval.payload, approverId: "mallory" }, generateApproverKeys().privateKeyPem);
      await expect(store.recordApproval(forged, t0)).rejects.toThrow(/not registered/u);
      const production = signApproval({ ...approval.payload, approvalId: "a-prod", operationId: "op-prod", environment: "production" }, keys.privateKeyPem);
      await expect(store.recordApproval(production, t0)).rejects.toThrow(/may not approve production/u);
      await expect(store.recordApproval(approval, at(7200))).rejects.toThrow(/expired/u);
      await store.recordApproval(approval, t0);
      expect(await store.consumeApproval(approval.payload.approvalId, "op-1", "sha256:other", at(1))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/different plan digest/u) });
      await store.revokeApprover("alice", at(2));
      expect(await store.consumeApproval(approval.payload.approvalId, "op-1", PLAN.digest, at(3))).toMatchObject({ status: "rejected", reason: expect.stringMatching(/revoked/u) });
    }));

    it("keeps an append-only journal per operation", withStore(async (store) => {
      await store.createOperation({ id: "op-1", environment: "staging", planDigest: PLAN.digest, approvalId: null, state: "planned" }, t0);
      await expect(store.createOperation({ id: "op-1", environment: "staging", planDigest: PLAN.digest, approvalId: null, state: "planned" }, t0)).rejects.toThrow(StoreConflictError);
      await store.appendEvent("op-1", "infra.apply.started", { step: 1 }, at(1));
      await store.appendEvent("op-1", "infra.resource.created", { resource: "database" }, at(2));
      await expect(store.appendEvent("op-missing", "x", {}, at(3))).rejects.toThrow(StoreConflictError);
      expect((await store.events("op-1")).map((event) => event.kind)).toEqual(["infra.apply.started", "infra.resource.created"]);
      await store.setOperationState("op-1", "succeeded", at(4));
      expect(await store.getOperation("op-1")).toMatchObject({ state: "succeeded" });
    }));

    it("excludes a second holder while a lease is live and fences stale tokens", withStore(async (store) => {
      const first = await store.reserve("neon:staging", "op-1", "runner-a", 30_000, t0);
      expect(first.status).toBe("acquired");
      expect(await store.reserve("neon:staging", "op-2", "runner-b", 30_000, at(1))).toMatchObject({ status: "busy", holder: "runner-a" });
      const token = first.status === "acquired" ? first.reservation.fencingToken : -1;
      await store.beginEffect("neon:staging", token, "create-db", at(2));
      await expect(store.beginEffect("neon:staging", token, "second", at(3))).rejects.toThrow(/still in flight/u);
      await store.completeEffect("neon:staging", token, "create-db", at(4));
      await store.release("neon:staging", token);
      const second = await store.reserve("neon:staging", "op-2", "runner-b", 30_000, at(5));
      expect(second.status).toBe("acquired");
      await expect(store.beginEffect("neon:staging", token, "stale", at(6))).rejects.toThrow(/stale/u);
    }));

    it("never hands an expired lease with an in-flight effect to another runner (AR-02)", withStore(async (store) => {
      const first = await store.reserve("neon:staging", "op-1", "runner-a", 10_000, t0);
      const token = first.status === "acquired" ? first.reservation.fencingToken : -1;
      await store.beginEffect("neon:staging", token, "create-db", at(1));
      // runner-a stalls; its lease lapses while the provider request is still outstanding.
      expect(await store.reserve("neon:staging", "op-2", "runner-b", 10_000, at(60))).toMatchObject({ status: "uncertain" });
      expect(await store.reserve("neon:staging", "op-2", "runner-b", 10_000, at(3600))).toMatchObject({ status: "uncertain" });
      // The delayed response arrives; the reservation remains uncertain.
      await store.completeEffect("neon:staging", token, "create-db", at(3601));
      expect(await store.getReservation("neon:staging")).toMatchObject({ state: "uncertain", inflightEffect: null });
      await expect(store.release("neon:staging", token)).rejects.toThrow(/reconciled/u);
      await expect(store.beginEffect("neon:staging", token, "retry", at(3602))).rejects.toThrow(/uncertain/u);
      expect(await store.reserve("neon:staging", "op-1", "runner-a", 10_000, at(3603))).toMatchObject({ status: "uncertain" });
      await store.reconcile("neon:staging", "observed database neon-proj-1; bound", "operator", at(3604));
      expect(await store.reserve("neon:staging", "op-2", "runner-b", 10_000, at(3605))).toMatchObject({ status: "acquired" });
    }));

    it("allows takeover of an expired lease only when nothing was in flight", withStore(async (store) => {
      const first = await store.reserve("scope", "op-1", "runner-a", 10_000, t0);
      const takeover = await store.reserve("scope", "op-2", "runner-b", 10_000, at(30));
      expect(takeover.status).toBe("acquired");
      const oldToken = first.status === "acquired" ? first.reservation.fencingToken : -1;
      const newToken = takeover.status === "acquired" ? takeover.reservation.fencingToken : -1;
      expect(newToken).toBeGreaterThan(oldToken);
      await expect(store.beginEffect("scope", oldToken, "late", at(31))).rejects.toThrow(/stale/u);
    }));

    it("advances generations only by compare-and-swap (AR-04)", withStore(async (store) => {
      expect((await store.commitGeneration("credentials:staging:database", 0, "sha256:a", { pointer: "a" })).generation).toBe(1);
      expect((await store.commitGeneration("credentials:staging:database", 1, "sha256:b", { pointer: "b" })).generation).toBe(2);
      await expect(store.commitGeneration("credentials:staging:database", 1, "sha256:stale", { pointer: "stale" })).rejects.toThrow(/generation conflict/u);
      await expect(store.commitGeneration("credentials:staging:database", 0, "sha256:stale", { pointer: "stale" })).rejects.toThrow(/generation conflict/u);
      expect(await store.readGeneration("credentials:staging:database")).toMatchObject({ generation: 2, payloadDigest: "sha256:b" });
    }));

    it("restores without re-enabling replay, releasing uncertainty, or reissuing fencing tokens", withStore(async (store) => {
      const { approval } = await approved(store);
      await store.recordApproval(approval, t0);
      await store.consumeApproval(approval.payload.approvalId, "op-1", PLAN.digest, at(1));
      await store.createOperation({ id: "op-1", environment: "staging", planDigest: PLAN.digest, approvalId: approval.payload.approvalId, state: "running" }, at(1));
      await store.appendEvent("op-1", "infra.apply.started", {}, at(2));
      const released = await store.reserve("other", "op-1", "runner-a", 10_000, at(2));
      if (released.status === "acquired") await store.release("other", released.reservation.fencingToken);
      const held = await store.reserve("neon:staging", "op-1", "runner-a", 10_000, at(3));
      const token = held.status === "acquired" ? held.reservation.fencingToken : -1;
      await store.beginEffect("neon:staging", token, "create-db", at(4));
      await store.commitGeneration("bindings:staging", 0, "sha256:g1", {});
      const snapshot = JSON.parse(JSON.stringify(await store.exportState()));
      const restored = await open();
      try {
        await restored.importState(snapshot);
        expect(await restored.consumeApproval(approval.payload.approvalId, "op-2", PLAN.digest, at(5))).toMatchObject({ status: "rejected" });
        expect(await restored.reserve("neon:staging", "op-2", "runner-b", 10_000, at(600))).toMatchObject({ status: "uncertain" });
        await expect(restored.commitGeneration("bindings:staging", 0, "sha256:old", {})).rejects.toThrow(/generation conflict/u);
        expect((await restored.events("op-1")).map((event) => event.kind)).toEqual(["infra.apply.started"]);
        const fresh = await restored.reserve("new-scope", "op-3", "runner-c", 10_000, at(601));
        expect(fresh.status === "acquired" ? fresh.reservation.fencingToken : -1).toBeGreaterThan(token);
        await expect(restored.importState(snapshot)).rejects.toThrow();
      } finally {
        await (restored as { close?: () => Promise<void> }).close?.();
      }
    }));
  });
}
