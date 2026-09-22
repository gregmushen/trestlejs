import { z } from "zod";

import { environmentNameSchema } from "./manifest.js";

const namedIntent = z.object({
  name: z.string().min(1),
  environment: environmentNameSchema,
  paid: z.boolean().default(false),
  estimatedMonthlyCost: z.string().min(1).optional(),
  approved: z.boolean().default(false),
}).strict();

export const setupResourceSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u, "must be PascalCase"),
  tenant: z.boolean().default(true),
  crud: z.boolean().default(true),
}).strict();

export const setupPlanSchema = z.object({
  schemaVersion: z.literal(1),
  minimumTrestleVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  project: z.object({ name: z.string().min(1) }).strict(),
  apps: z.object({ site: z.boolean(), app: z.boolean(), worker: z.boolean() }).strict(),
  tenancy: z.object({
    model: z.literal("organization"),
    enforcement: z.literal("postgres-rls"),
  }).strict(),
  database: z.object({
    engine: z.literal("postgresql"),
    provider: z.string().min(1),
  }).strict(),
  capabilities: z.object({
    r2: z.boolean(),
    queues: z.boolean(),
    workflows: z.boolean(),
    durableObjects: z.boolean(),
    admin: z.boolean(),
  }).strict(),
  integrations: z.object({ email: z.boolean(), billing: z.boolean() }).strict(),
  environments: z.array(environmentNameSchema).min(1),
  secrets: z.array(z.object({
    name: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    target: z.enum(["worker", "ci"]),
    required: z.array(environmentNameSchema).min(1),
  }).strict()).default([]),
  resources: z.array(setupResourceSchema).default([]),
  externalResources: z.array(namedIntent).default([]),
  destructiveOperations: z.array(z.object({
    description: z.string().min(1),
    environment: environmentNameSchema,
    approved: z.boolean().default(false),
  }).strict()).default([]),
  verification: z.object({ commands: z.array(z.string().min(1)).default([]) }).strict(),
}).strict().superRefine((plan, context) => {
  const uniqueEnvironments = new Set(plan.environments);
  if (uniqueEnvironments.size !== plan.environments.length) {
    context.addIssue({ code: "custom", path: ["environments"], message: "environments must not contain duplicates" });
  }
  if (!uniqueEnvironments.has("local")) {
    context.addIssue({ code: "custom", path: ["environments"], message: "local environment is required" });
  }
  for (const [field, values] of [["resources", plan.resources], ["secrets", plan.secrets]] as const) {
    const names = values.map(({ name }) => name);
    if (new Set(names).size !== names.length) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicate names` });
    }
  }
  plan.externalResources.forEach((resource, index) => {
    if (resource.paid && !resource.estimatedMonthlyCost) {
      context.addIssue({ code: "custom", path: ["externalResources", index, "estimatedMonthlyCost"], message: "paid resources require an estimated cost" });
    }
    if (resource.paid && !resource.approved) {
      context.addIssue({ code: "custom", path: ["externalResources", index, "approved"], message: "paid resources require explicit approval" });
    }
  });
  plan.resources.forEach((resource, index) => {
    if (!resource.tenant || !resource.crud) {
      context.addIssue({ code: "custom", path: ["resources", index], message: "the v1 resource generator currently requires tenant=true and crud=true" });
    }
  });
  plan.destructiveOperations.forEach((operation, index) => {
    if (!operation.approved) {
      context.addIssue({ code: "custom", path: ["destructiveOperations", index, "approved"], message: "destructive operations require explicit approval" });
    }
  });
});

export type SetupPlan = z.infer<typeof setupPlanSchema>;
export type SetupResource = z.infer<typeof setupResourceSchema>;

export class SetupPlanError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, issues: readonly z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "SetupPlanError";
    this.issues = issues;
  }
}

export function parseSetupPlan(input: string): SetupPlan {
  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch (error) {
    throw new SetupPlanError(`SetupPlan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = setupPlanSchema.safeParse(document);
  if (!result.success) throw new SetupPlanError("SetupPlan is invalid", result.error.issues);
  return result.data;
}
