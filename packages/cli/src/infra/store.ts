import type { SignedApproval } from "./approvals.js";

/**
 * Durable control-state contract (spec §9, §11, §25; D-02). Implementations
 * must make every method atomic. Times are passed in so tests control the
 * clock; implementations never read wall time themselves.
 */

export type ReservationState = "active" | "uncertain";

export type Reservation = Readonly<{
  scope: string;
  operationId: string;
  holder: string;
  fencingToken: number;
  leaseExpiresAt: string;
  state: ReservationState;
  inflightEffect: string | null;
}>;

export type OperationRecord = Readonly<{
  id: string;
  environment: string;
  planDigest: string;
  approvalId: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
}>;

export type OperationEvent = Readonly<{ seq: number; operationId: string; at: string; kind: string; data: Readonly<Record<string, unknown>> }>;

export type Generation = Readonly<{ scope: string; generation: number; payloadDigest: string; data: Readonly<Record<string, unknown>> }>;

export type ConsumeResult =
  | Readonly<{ status: "consumed" }>
  | Readonly<{ status: "already_consumed_by_operation" }>
  | Readonly<{ status: "rejected"; reason: string }>;

export type ReserveResult =
  | Readonly<{ status: "acquired"; reservation: Reservation }>
  | Readonly<{ status: "busy"; holder: string; leaseExpiresAt: string }>
  | Readonly<{ status: "uncertain"; reservation: Reservation }>;

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export type ControlSnapshot = Readonly<{
  approvers: readonly Readonly<{ id: string; publicKeyPem: string; environments: readonly string[]; revokedAt: string | null }>[];
  approvals: readonly Readonly<{ approval: SignedApproval; consumedBy: string | null; consumedAt: string | null }>[];
  operations: readonly OperationRecord[];
  events: readonly OperationEvent[];
  reservations: readonly Reservation[];
  generations: readonly Generation[];
  /** Highest fencing token ever issued; restored stores never reissue a lower one. */
  fencingHighWater: number;
}>;

export interface OperationStore {
  /** Identifies the backend; only durable shared stores may govern remote mutation. */
  readonly kind: "memory" | "postgres";

  registerApprover(id: string, publicKeyPem: string, environments: readonly string[], now: Date): Promise<void>;
  revokeApprover(id: string, now: Date): Promise<void>;
  /** Verifies the signature against the registry and stores the approval unconsumed. */
  recordApproval(approval: SignedApproval, now: Date): Promise<void>;
  /** Atomic single use, bound to the operation and plan digest. */
  consumeApproval(approvalId: string, operationId: string, planDigest: string, now: Date): Promise<ConsumeResult>;

  createOperation(record: Omit<OperationRecord, "createdAt" | "updatedAt">, now: Date): Promise<OperationRecord>;
  getOperation(id: string): Promise<OperationRecord | undefined>;
  setOperationState(id: string, state: string, now: Date): Promise<void>;
  appendEvent(operationId: string, kind: string, data: Record<string, unknown>, now: Date): Promise<OperationEvent>;
  events(operationId: string): Promise<OperationEvent[]>;

  /**
   * Acquire or renew the mutation reservation for a scope. An expired lease is
   * taken over only when no effect was in flight; otherwise the reservation
   * becomes uncertain and is never handed out until reconciled (AR-02).
   */
  reserve(scope: string, operationId: string, holder: string, leaseMs: number, now: Date): Promise<ReserveResult>;
  /** Must be called, and succeed, immediately before every external effect. */
  beginEffect(scope: string, fencingToken: number, effectId: string, now: Date): Promise<void>;
  completeEffect(scope: string, fencingToken: number, effectId: string, now: Date): Promise<Reservation>;
  markUncertain(scope: string, fencingToken: number, now: Date): Promise<void>;
  release(scope: string, fencingToken: number): Promise<void>;
  /** Explicit operator reconciliation of an uncertain or orphaned reservation. */
  reconcile(scope: string, resolution: string, actor: string, now: Date): Promise<void>;
  getReservation(scope: string): Promise<Reservation | undefined>;

  readGeneration(scope: string): Promise<Generation | undefined>;
  /** Compare-and-swap: succeeds only when the current generation equals `expected` (0 = absent). */
  commitGeneration(scope: string, expected: number, payloadDigest: string, data: Record<string, unknown>): Promise<Generation>;

  exportState(): Promise<ControlSnapshot>;
  importState(snapshot: ControlSnapshot): Promise<void>;
}
