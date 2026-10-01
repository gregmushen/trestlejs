import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { environmentNameSchema } from "../manifest.js";
import { findCredentialLeaves, redact } from "./redaction.js";

/**
 * Infrastructure intent, bindings and observations (spec §9–§10, plan P02).
 * Parsed independently of SetupPlan v1, whose external/destructive lists stay
 * rejected.
 */

export const logicalIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u, "must be a lowercase logical identifier");
const envKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/u, "must be an uppercase environment variable name");
const providerSchema = z.enum(["neon", "cloudflare", "resend"]);
/** Opaque external identifiers: bounded, printable, no whitespace or shell metacharacters. */
export const externalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u, "must be an opaque provider identifier");

export const credentialBindingSchema = z.object({
  /** Output variable name produced by the provider through Projects. */
  output: envKeySchema,
  /**
   * operator-only: available to the infrastructure process, never deployed.
   * provider-managed: synchronized into the encrypted deployment snapshot for
   * the listed consumers after privilege validation.
   */
  classification: z.enum(["operator-only", "provider-managed"]),
  consumers: z.array(z.enum(["worker", "admin", "jobs", "migrations", "ci"])).default([]),
  /** Snapshot variable name, when different from the provider output. */
  as: envKeySchema.optional(),
}).strict().superRefine((binding, context) => {
  if (binding.classification === "operator-only" && binding.consumers.some((consumer) => consumer !== "migrations")) {
    context.addIssue({ code: "custom", path: ["consumers"], message: "operator-only credentials cannot be deployed to application consumers" });
  }
  if (binding.classification === "provider-managed" && binding.consumers.length === 0) {
    context.addIssue({ code: "custom", path: ["consumers"], message: "provider-managed credentials must name their consumers" });
  }
});

const costLimitSchema = z.object({
  currency: z.string().regex(/^[a-z]{3}$/u),
  /** Recurring monthly limit in minor units the operator is willing to approve. */
  monthlyMinor: z.number().int().min(0),
}).strict();

export const desiredResourceSchema = z.object({
  provider: providerSchema,
  /** Exact catalog service_id of the deployable resource. */
  service: z.string().min(1),
  /** Exact catalog plan service_id, when the provider sells plans. */
  plan: z.string().min(1).optional(),
  lifecycleOwner: z.enum(["stripe-projects", "direct", "external"]).default("stripe-projects"),
  disposition: z.enum(["create", "adopt"]).default("create"),
  /** Required for adopt: the exact external resource identity, never a display name. */
  externalId: externalIdSchema.optional(),
  deletionPolicy: z.enum(["retain", "delete"]).default("retain"),
  dependsOn: z.array(logicalIdSchema).default([]),
  /** Environments that intentionally share this exact resource. */
  sharedWith: z.array(environmentNameSchema).default([]),
  credentialBindings: z.record(logicalIdSchema, credentialBindingSchema).default({}),
  costLimit: costLimitSchema.optional(),
  /** Records that a generated direct-provider writer for this kind has been disabled for this environment. */
  directWriterDisabled: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(10).max(3600).default(300),
}).strict().superRefine((resource, context) => {
  if (resource.disposition === "adopt" && !resource.externalId) context.addIssue({ code: "custom", path: ["externalId"], message: "adoption requires an exact externalId" });
  if (resource.disposition === "create" && resource.externalId) context.addIssue({ code: "custom", path: ["externalId"], message: "externalId is only accepted for adoption; created resources are bound from the operation journal" });
  const outputs = Object.values(resource.credentialBindings).map((binding) => binding.as ?? binding.output);
  if (new Set(outputs).size !== outputs.length) context.addIssue({ code: "custom", path: ["credentialBindings"], message: "credential bindings map two outputs to the same name" });
});

export const environmentIntentSchema = z.object({
  /** Logical name of the Projects project/environment pairing; resolved through bindings. */
  projectsBinding: logicalIdSchema,
  resources: z.record(logicalIdSchema, desiredResourceSchema).default({}),
}).strict();

export const infrastructureIntentSchema = z.object({
  schemaVersion: z.literal(1),
  backend: z.literal("stripe-projects"),
  environments: z.partialRecord(environmentNameSchema, environmentIntentSchema),
}).strict().superRefine((intent, context) => {
  if (intent.environments.local) context.addIssue({ code: "custom", path: ["environments", "local"], message: "local development never uses remote infrastructure" });
  const leaves = findCredentialLeaves(intent);
  for (const leaf of leaves) context.addIssue({ code: "custom", path: [], message: `infrastructure intent must not contain secret values (${leaf})` });
});

export type InfrastructureIntent = z.infer<typeof infrastructureIntentSchema>;
export type DesiredResource = z.infer<typeof desiredResourceSchema>;
export type InfraEnvironment = z.infer<typeof environmentNameSchema>;

/** Reviewed, safe identities. Repository copies propose; the control store's generation decides. */
export const resourceBindingSchema = z.object({
  provider: providerSchema,
  service: z.string().min(1),
  plan: z.string().min(1).optional(),
  externalId: externalIdSchema,
  providerAccountId: externalIdSchema.optional(),
  lifecycleOwner: z.enum(["stripe-projects", "direct", "external"]),
  boundBy: z.string().min(1),
}).strict();

export const environmentBindingSchema = z.object({
  trestleProjectId: externalIdSchema,
  stripeAccountId: z.string().regex(/^acct_[A-Za-z0-9]{6,}$/u),
  projectsProjectId: externalIdSchema,
  projectsEnvironment: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  generation: z.number().int().min(0),
  resources: z.record(logicalIdSchema, resourceBindingSchema).default({}),
}).strict();

export const infrastructureBindingsSchema = z.object({
  schemaVersion: z.literal(1),
  environments: z.partialRecord(environmentNameSchema, environmentBindingSchema),
}).strict().superRefine((bindings, context) => {
  for (const leaf of findCredentialLeaves(bindings)) context.addIssue({ code: "custom", path: [], message: `bindings must not contain secret values (${leaf})` });
});

export type EnvironmentBinding = z.infer<typeof environmentBindingSchema>;
export type InfrastructureBindings = z.infer<typeof infrastructureBindingsSchema>;

/** A timestamped provider observation for one environment. */
export const observationSchema = z.object({
  observedAt: z.string().datetime(),
  stripeAccountId: z.string().regex(/^acct_[A-Za-z0-9]{6,}$/u),
  projectsProjectId: externalIdSchema,
  projectsEnvironment: z.string().min(1),
  resources: z.array(z.object({
    externalId: externalIdSchema,
    provider: providerSchema,
    service: z.string().min(1),
    plan: z.string().min(1).optional(),
    name: z.string().max(200).optional(),
  }).strict()),
  /** False when discovery was partial; absence then proves nothing. */
  complete: z.boolean(),
}).strict();

export type Observation = z.infer<typeof observationSchema>;

export class InfraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InfraConfigError";
  }
}

export function parseIntent(source: string): InfrastructureIntent {
  let document: unknown;
  try {
    document = parseYaml(source, { uniqueKeys: true });
  } catch (error) {
    // YAML errors quote source lines, which may contain secrets: report position only.
    const position = (error as { linePos?: Array<{ line: number; col: number }> }).linePos?.[0];
    const summary = redact((error instanceof Error ? error.message : String(error)).split("\n")[0]!.replace(/ at line \d+, column \d+:?.*$/u, ""));
    throw new InfraConfigError(`.trestle/infrastructure.yaml is not valid YAML${position ? ` (line ${position.line}, column ${position.col})` : ""}: ${summary}`);
  }
  const result = infrastructureIntentSchema.safeParse(document);
  if (!result.success) throw new InfraConfigError(`.trestle/infrastructure.yaml is invalid:\n${result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}`);
  return result.data;
}

export function parseBindings(source: string): InfrastructureBindings {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new InfraConfigError(".trestle/infrastructure.bindings.json is not valid JSON");
  }
  const result = infrastructureBindingsSchema.safeParse(document);
  if (!result.success) throw new InfraConfigError(`.trestle/infrastructure.bindings.json is invalid:\n${result.error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n")}`);
  return result.data;
}

export const INFRA_PATHS = Object.freeze({
  intent: path.join(".trestle", "infrastructure.yaml"),
  bindings: path.join(".trestle", "infrastructure.bindings.json"),
  local: path.join(".trestle", "infrastructure.local"),
});

export async function readInfrastructure(root: string): Promise<{ intent: InfrastructureIntent; bindings: InfrastructureBindings }> {
  const intentSource = await readFile(path.join(root, INFRA_PATHS.intent), "utf8").catch(() => {
    throw new InfraConfigError("no .trestle/infrastructure.yaml; run trestle infra init --backend stripe-projects");
  });
  const bindingsSource = await readFile(path.join(root, INFRA_PATHS.bindings), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return JSON.stringify({ schemaVersion: 1, environments: {} });
    throw error;
  });
  return { intent: parseIntent(intentSource), bindings: parseBindings(bindingsSource) };
}
