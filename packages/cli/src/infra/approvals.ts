import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";

import type { CommandEffect } from "./capabilities.js";
import { canonicalJson } from "./canonical.js";
import type { InfraPlan } from "./planner.js";

/**
 * Authenticated approval records (spec §12, D-03). The signature authenticates
 * an approver registered in the control store; a digest alone does not.
 */

export type ApprovalPayload = Readonly<{
  approvalId: string;
  operationId: string;
  environment: string;
  planDigest: string;
  sourceDigest: string;
  artifactDigest: string | null;
  target: Readonly<{ stripeAccountId: string; projectsProjectId: string; projectsEnvironment: string }>;
  allowedEffects: readonly CommandEffect[];
  costLimit: Readonly<{ currency: string; monthlyMinor: number }> | null;
  expiresAt: string;
  approverId: string;
  nonce: string;
}>;

export type SignedApproval = Readonly<{ payload: ApprovalPayload; signature: string }>;

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export function generateApproverKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function message(payload: ApprovalPayload): Buffer {
  return Buffer.from(`trestle-infra-approval:v1:${canonicalJson(payload)}`, "utf8");
}

export function signApproval(payload: ApprovalPayload, privateKeyPem: string): SignedApproval {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new ApprovalError("approver keys must be Ed25519");
  return { payload, signature: sign(null, message(payload), key).toString("base64") };
}

export function verifyApprovalSignature(approval: SignedApproval, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, message(approval.payload), key, Buffer.from(approval.signature, "base64"));
  } catch {
    return false;
  }
}

/** Builds the payload an approver signs for one executable plan and operation. */
export function approvalFor(plan: InfraPlan, options: { operationId: string; approverId: string; artifactDigest?: string; ttlSeconds?: number; now: Date }): ApprovalPayload {
  if (!plan.target) throw new ApprovalError("a plan without a reviewed target binding cannot be approved");
  const effects = [...new Set(plan.operations.flatMap((operation) => operation.effects))].sort();
  const limits = plan.operations.map((operation) => operation.cost.limit).filter((limit): limit is NonNullable<typeof limit> => Boolean(limit));
  const currencies = new Set(limits.map((limit) => limit.currency));
  if (currencies.size > 1) throw new ApprovalError("a plan with cost limits in several currencies needs separate approvals");
  return {
    approvalId: randomUUID(), operationId: options.operationId, environment: plan.environment,
    planDigest: plan.digest, sourceDigest: plan.sourceDigest, artifactDigest: options.artifactDigest ?? null,
    target: { stripeAccountId: plan.target.stripeAccountId, projectsProjectId: plan.target.projectsProjectId, projectsEnvironment: plan.target.projectsEnvironment },
    allowedEffects: effects,
    costLimit: limits.length ? { currency: limits[0]!.currency, monthlyMinor: limits.reduce((total, limit) => total + limit.monthlyMinor, 0) } : null,
    expiresAt: new Date(Math.min(options.now.getTime() + (options.ttlSeconds ?? 3600) * 1000, Date.parse(plan.expiresAt))).toISOString(),
    approverId: options.approverId, nonce: randomUUID(),
  };
}

/** Checks an approval covers exactly this plan, target and effect set before any store interaction. */
export function approvalCovers(approval: SignedApproval, plan: InfraPlan, effects: readonly CommandEffect[], now: Date): string[] {
  const problems: string[] = [];
  const payload = approval.payload;
  if (payload.planDigest !== plan.digest) problems.push("approval is for a different plan digest");
  if (payload.sourceDigest !== plan.sourceDigest) problems.push("approval is for different source");
  if (payload.environment !== plan.environment) problems.push("approval is for a different environment");
  if (!plan.target || payload.target.stripeAccountId !== plan.target.stripeAccountId || payload.target.projectsProjectId !== plan.target.projectsProjectId || payload.target.projectsEnvironment !== plan.target.projectsEnvironment) problems.push("approval targets a different account, project or environment");
  if (Date.parse(payload.expiresAt) <= now.getTime()) problems.push("approval has expired");
  const unapproved = effects.filter((effect) => !payload.allowedEffects.includes(effect));
  if (unapproved.length) problems.push(`effects not covered by approval: ${unapproved.join(", ")}`);
  return problems;
}
