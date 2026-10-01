import { verifyApprovalSignature, type SignedApproval } from "../approvals.js";
import type { Reservation } from "../store.js";

/**
 * Decision rules shared by every store backend, so the in-memory test store and
 * the PostgreSQL store cannot drift apart semantically.
 */

export type ReserveDecision =
  | Readonly<{ action: "insert" }>
  | Readonly<{ action: "renew" }>
  | Readonly<{ action: "takeover" }>
  | Readonly<{ action: "busy" }>
  | Readonly<{ action: "uncertain"; mark: boolean }>;

export function decideReserve(existing: Reservation | undefined, operationId: string, holder: string, now: Date): ReserveDecision {
  if (!existing) return { action: "insert" };
  if (existing.state === "uncertain") return { action: "uncertain", mark: false };
  const expired = Date.parse(existing.leaseExpiresAt) <= now.getTime();
  if (existing.operationId === operationId && existing.holder === holder) {
    // The holder may renew only while its lease is live; a lapsed lease with an
    // effect in flight is uncertain even for the original holder.
    if (!expired) return { action: "renew" };
    return existing.inflightEffect ? { action: "uncertain", mark: true } : { action: "renew" };
  }
  if (!expired) return { action: "busy" };
  // A lost lease does not cancel an in-flight provider request.
  return existing.inflightEffect ? { action: "uncertain", mark: true } : { action: "takeover" };
}

export function assertEffectAllowed(existing: Reservation | undefined, fencingToken: number, now: Date): string | undefined {
  if (!existing) return "no reservation is held for this scope";
  if (existing.fencingToken !== fencingToken) return `fencing token ${fencingToken} is stale (current ${existing.fencingToken})`;
  if (existing.state !== "active") return "reservation is uncertain and must be reconciled";
  if (Date.parse(existing.leaseExpiresAt) <= now.getTime()) return "lease has expired; renew before starting another effect";
  if (existing.inflightEffect) return `effect ${existing.inflightEffect} is still in flight`;
  return undefined;
}

export type ApproverRecord = Readonly<{ id: string; publicKeyPem: string; environments: readonly string[]; revokedAt: string | null }>;

export function approvalProblems(approval: SignedApproval, approver: ApproverRecord | undefined, now: Date): string | undefined {
  if (!approver) return `approver ${approval.payload.approverId} is not registered in the control store`;
  if (approver.revokedAt && Date.parse(approver.revokedAt) <= now.getTime()) return `approver ${approver.id} is revoked`;
  if (!approver.environments.includes(approval.payload.environment)) return `approver ${approver.id} may not approve ${approval.payload.environment}`;
  if (!verifyApprovalSignature(approval, approver.publicKeyPem)) return "approval signature is invalid";
  if (Date.parse(approval.payload.expiresAt) <= now.getTime()) return "approval has expired";
  return undefined;
}
