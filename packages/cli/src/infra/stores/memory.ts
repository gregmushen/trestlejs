import type { SignedApproval } from "../approvals.js";
import { StoreConflictError, type ConsumeResult, type ControlSnapshot, type Generation, type OperationEvent, type OperationRecord, type OperationStore, type Reservation, type ReserveResult } from "../store.js";
import { approvalProblems, assertEffectAllowed, decideReserve, type ApproverRecord } from "./rules.js";

/**
 * Deterministic in-process store for tests and simulation only. It cannot
 * coordinate separate processes and is refused for real remote mutation.
 */
export class MemoryOperationStore implements OperationStore {
  readonly kind = "memory" as const;
  private approvers = new Map<string, ApproverRecord>();
  private approvals = new Map<string, { approval: SignedApproval; consumedBy: string | null; consumedAt: string | null }>();
  private operations = new Map<string, OperationRecord>();
  private eventLog: OperationEvent[] = [];
  private reservations = new Map<string, Reservation>();
  private generations = new Map<string, Generation>();
  private fencing = 0;

  async registerApprover(id: string, publicKeyPem: string, environments: readonly string[]): Promise<void> {
    this.approvers.set(id, { id, publicKeyPem, environments: [...environments], revokedAt: null });
  }

  async revokeApprover(id: string, now: Date): Promise<void> {
    const approver = this.approvers.get(id);
    if (approver) this.approvers.set(id, { ...approver, revokedAt: now.toISOString() });
  }

  async recordApproval(approval: SignedApproval, now: Date): Promise<void> {
    const recorded = this.approvals.get(approval.payload.approvalId);
    // Re-recording the identical approval is a no-op; consumption is the authoritative check.
    if (recorded && recorded.approval.signature === approval.signature) return;
    const problem = approvalProblems(approval, this.approvers.get(approval.payload.approverId), now);
    if (problem) throw new StoreConflictError(problem);
    if (this.approvals.has(approval.payload.approvalId)) throw new StoreConflictError("approval is already recorded");
    this.approvals.set(approval.payload.approvalId, { approval, consumedBy: null, consumedAt: null });
  }

  async consumeApproval(approvalId: string, operationId: string, planDigest: string, now: Date): Promise<ConsumeResult> {
    const entry = this.approvals.get(approvalId);
    if (!entry) return { status: "rejected", reason: "approval is not recorded" };
    if (entry.consumedBy && entry.consumedBy !== operationId) return { status: "rejected", reason: "approval was already consumed by another operation" };
    if (entry.approval.payload.operationId !== operationId) return { status: "rejected", reason: "approval is bound to a different operation" };
    if (entry.approval.payload.planDigest !== planDigest) return { status: "rejected", reason: "approval is bound to a different plan digest" };
    // Resume re-checks current authority: a revoked approver or expired approval stops it.
    const problem = approvalProblems(entry.approval, this.approvers.get(entry.approval.payload.approverId), now);
    if (problem) return { status: "rejected", reason: problem };
    if (entry.consumedBy === operationId) return { status: "already_consumed_by_operation" };
    this.approvals.set(approvalId, { ...entry, consumedBy: operationId, consumedAt: now.toISOString() });
    return { status: "consumed" };
  }

  async createOperation(record: Omit<OperationRecord, "createdAt" | "updatedAt">, now: Date): Promise<OperationRecord> {
    if (this.operations.has(record.id)) throw new StoreConflictError(`operation ${record.id} already exists`);
    const created = { ...record, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    this.operations.set(record.id, created);
    return created;
  }

  async getOperation(id: string): Promise<OperationRecord | undefined> { return this.operations.get(id); }

  async setOperationState(id: string, state: string, now: Date): Promise<void> {
    const operation = this.operations.get(id);
    if (!operation) throw new StoreConflictError(`operation ${id} does not exist`);
    this.operations.set(id, { ...operation, state, updatedAt: now.toISOString() });
  }

  async appendEvent(operationId: string, kind: string, data: Record<string, unknown>, now: Date): Promise<OperationEvent> {
    if (!this.operations.has(operationId)) throw new StoreConflictError(`operation ${operationId} does not exist`);
    const event = { seq: this.eventLog.length + 1, operationId, at: now.toISOString(), kind, data: structuredClone(data) };
    this.eventLog.push(event);
    return event;
  }

  async events(operationId: string): Promise<OperationEvent[]> { return this.eventLog.filter((event) => event.operationId === operationId); }

  async reserve(scope: string, operationId: string, holder: string, leaseMs: number, now: Date): Promise<ReserveResult> {
    const existing = this.reservations.get(scope);
    const decision = decideReserve(existing, operationId, holder, now);
    const lease = new Date(now.getTime() + leaseMs).toISOString();
    switch (decision.action) {
      case "busy": return { status: "busy", holder: existing!.holder, leaseExpiresAt: existing!.leaseExpiresAt };
      case "uncertain": {
        const reservation = decision.mark ? { ...existing!, state: "uncertain" as const } : existing!;
        this.reservations.set(scope, reservation);
        return { status: "uncertain", reservation };
      }
      case "renew": {
        const reservation = { ...existing!, leaseExpiresAt: lease };
        this.reservations.set(scope, reservation);
        return { status: "acquired", reservation };
      }
      default: {
        const reservation: Reservation = { scope, operationId, holder, fencingToken: ++this.fencing, leaseExpiresAt: lease, state: "active", inflightEffect: null };
        this.reservations.set(scope, reservation);
        return { status: "acquired", reservation };
      }
    }
  }

  async beginEffect(scope: string, fencingToken: number, effectId: string, now: Date): Promise<void> {
    const existing = this.reservations.get(scope);
    const problem = assertEffectAllowed(existing, fencingToken, now);
    if (problem) throw new StoreConflictError(problem);
    this.reservations.set(scope, { ...existing!, inflightEffect: effectId });
  }

  async completeEffect(scope: string, fencingToken: number, effectId: string): Promise<Reservation> {
    const existing = this.reservations.get(scope);
    if (!existing || existing.fencingToken !== fencingToken) throw new StoreConflictError("fencing token is stale");
    if (existing.inflightEffect !== effectId) throw new StoreConflictError(`effect ${effectId} is not in flight`);
    // An uncertain reservation stays uncertain: another runner may already have observed the lapse.
    const reservation = { ...existing, inflightEffect: null };
    this.reservations.set(scope, reservation);
    return reservation;
  }

  async markUncertain(scope: string, fencingToken: number): Promise<void> {
    const existing = this.reservations.get(scope);
    if (!existing || existing.fencingToken !== fencingToken) throw new StoreConflictError("fencing token is stale");
    this.reservations.set(scope, { ...existing, state: "uncertain" });
  }

  async release(scope: string, fencingToken: number): Promise<void> {
    const existing = this.reservations.get(scope);
    if (!existing) return;
    if (existing.fencingToken !== fencingToken) throw new StoreConflictError("fencing token is stale");
    if (existing.state !== "active" || existing.inflightEffect) throw new StoreConflictError("an uncertain or in-flight reservation can only be reconciled");
    this.reservations.delete(scope);
  }

  async reconcile(scope: string, resolution: string, actor: string, now: Date): Promise<void> {
    const existing = this.reservations.get(scope);
    if (!existing) return;
    if (this.operations.has(existing.operationId)) await this.appendEvent(existing.operationId, "infra.operation.reconciled", { scope, resolution, actor }, now);
    this.reservations.delete(scope);
  }

  async getReservation(scope: string): Promise<Reservation | undefined> { return this.reservations.get(scope); }

  async readGeneration(scope: string): Promise<Generation | undefined> { return this.generations.get(scope); }

  async commitGeneration(scope: string, expected: number, payloadDigest: string, data: Record<string, unknown>): Promise<Generation> {
    const current = this.generations.get(scope)?.generation ?? 0;
    if (current !== expected) throw new StoreConflictError(`generation conflict for ${scope}: expected ${expected}, current ${current}`);
    const next = { scope, generation: current + 1, payloadDigest, data: structuredClone(data) };
    this.generations.set(scope, next);
    return next;
  }

  async exportState(): Promise<ControlSnapshot> {
    return structuredClone({
      approvers: [...this.approvers.values()], approvals: [...this.approvals.values()], operations: [...this.operations.values()],
      events: this.eventLog, reservations: [...this.reservations.values()], generations: [...this.generations.values()],
      fencingHighWater: this.fencing,
    });
  }

  async importState(snapshot: ControlSnapshot): Promise<void> {
    if (this.operations.size > 0 || this.approvals.size > 0 || this.generations.size > 0) throw new StoreConflictError("restore target control store is not empty");
    const copy = structuredClone(snapshot);
    this.approvers = new Map(copy.approvers.map((approver) => [approver.id, approver]));
    this.approvals = new Map(copy.approvals.map((entry) => [entry.approval.payload.approvalId, entry]));
    this.operations = new Map(copy.operations.map((operation) => [operation.id, operation]));
    this.eventLog = [...copy.events];
    this.reservations = new Map(copy.reservations.map((reservation) => [reservation.scope, reservation]));
    this.generations = new Map(copy.generations.map((generation) => [generation.scope, generation]));
    this.fencing = Math.max(copy.fencingHighWater, ...copy.reservations.map((reservation) => reservation.fencingToken));
  }
}
