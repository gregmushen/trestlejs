import { z } from "zod";

import { environmentNameSchema } from "./manifest.js";

export const capabilityIds = ["email", "payments", "admin", "queues", "workflows", "r2", "durableObjects", "plans", "serviceAccounts", "apiKeys", "webhooks", "notifications", "supportSessions", "passkeys", "twoFactor", "sso", "directory", "metering"] as const;
export const capabilityIdSchema = z.enum(capabilityIds);
export type CapabilityId = z.infer<typeof capabilityIdSchema>;

export const capabilityEvidenceSchema = z.object({
  deployed: z.boolean().optional(),
  verified: z.boolean().optional(),
  checkedAt: z.string().min(1),
}).strict();

/** Non-secret result of a provider connection check run by setup or doctor. */
export const providerCheckSchema = z.object({
  provider: z.string().min(1),
  ok: z.boolean(),
  checkedAt: z.string().min(1),
  /** A safe failure reason; never a credential, token, or response body. */
  failure: z.string().max(300).optional(),
}).strict();

/**
 * A real create/update/deactivate provisioning run inside interactive
 * transactions. Self-hosted SCIM is only verified for the driver it ran on.
 */
export const transactionTestSchema = z.object({
  driver: z.string().min(1),
  passed: z.boolean(),
  operations: z.array(z.enum(["create", "update", "deactivate"])),
  checkedAt: z.string().min(1),
  failure: z.string().max(300).optional(),
}).strict();

export const evidenceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  environment: environmentNameSchema,
  recordedAt: z.string().min(1),
  doctor: z.object({ passed: z.number().int().min(0), warnings: z.number().int().min(0), failed: z.number().int().min(0) }).strict().optional(),
  capabilities: z.partialRecord(capabilityIdSchema, capabilityEvidenceSchema),
  providerChecks: z.partialRecord(capabilityIdSchema, providerCheckSchema).optional(),
  scimTransactions: transactionTestSchema.optional(),
}).strict();

export type EvidenceDocument = z.infer<typeof evidenceDocumentSchema>;
export type TransactionTest = z.infer<typeof transactionTestSchema>;
export type ProviderCheck = z.infer<typeof providerCheckSchema>;
