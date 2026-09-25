import { z } from "zod";

import { environmentNameSchema } from "./manifest.js";

export const setupResourceFieldSchema = z.object({
  name: z.string().regex(/^[a-z][A-Za-z0-9]*$/u, "must be camelCase"),
  type: z.enum(["string", "text", "integer", "boolean", "datetime", "relation"]),
  required: z.boolean().default(true),
  references: z.object({ resource: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u), onDelete: z.enum(["restrict", "cascade", "set-null"]).default("restrict") }).strict().optional(),
}).strict().superRefine((field, context) => {
  if (field.type === "relation" && !field.references) context.addIssue({ code: "custom", path: ["references"], message: "relation fields require a resource reference" });
  if (field.type === "relation" && field.required) context.addIssue({ code: "custom", path: ["required"], message: "generated relationships must initially be optional for migration safety" });
  if (field.type !== "relation" && field.references) context.addIssue({ code: "custom", path: ["references"], message: "only relation fields accept references" });
  if (field.references?.onDelete === "set-null" && field.required) context.addIssue({ code: "custom", path: ["required"], message: "set-null relationships must be optional" });
});

export const setupResourceSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/u, "must be PascalCase"),
  tenant: z.literal(true).default(true),
  crud: z.literal(true).default(true),
  fields: z.array(setupResourceFieldSchema).min(1).default([{ name: "name", type: "string", required: true }]),
  webhookEvents: z.array(z.enum(["created", "updated", "deleted"])).default([]),
  authorization: z.object({ read: z.string().min(1), write: z.string().min(1) }).strict().optional(),
  pagination: z.object({ defaultLimit: z.number().int().min(1).max(100), maxLimit: z.number().int().min(1).max(250) }).strict().default({ defaultLimit: 25, maxLimit: 100 }),
}).strict();

export const setupPlanSchema = z.object({
  schemaVersion: z.literal(1),
  minimumTrestleVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  project: z.object({ name: z.string().min(1) }).strict(),
  // Optional for plans created before the admin application was part of SetupPlan.
  // When omitted, capabilities.admin remains the source of the desired state.
  apps: z.object({ site: z.boolean(), app: z.boolean(), worker: z.boolean(), admin: z.boolean().optional() }).strict(),
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
    target: z.enum(["worker", "ci", "admin"]),
    required: z.array(environmentNameSchema),
  }).strict()).default([]),
  resources: z.array(setupResourceSchema).default([]),
  // Accepted only when empty, so schemaVersion 1 plans written by earlier releases still parse.
  externalResources: z.array(z.unknown()).max(0, "externalResources are not supported; provision provider resources outside the SetupPlan").optional(),
  destructiveOperations: z.array(z.unknown()).max(0, "destructiveOperations are not supported; perform destructive changes explicitly outside the SetupPlan").optional(),
  // Accepted for schemaVersion 1 compatibility; ignored by plan/apply.
  verification: z.object({ commands: z.array(z.string().min(1)).default([]) }).strict().optional(),
}).strict().superRefine((plan, context) => {
  if (plan.apps.admin !== undefined && plan.apps.admin !== plan.capabilities.admin) {
    context.addIssue({ code: "custom", path: ["apps", "admin"], message: "apps.admin and capabilities.admin must agree" });
  }
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
  plan.resources.forEach((resource, index) => {
    const fields = resource.fields.map(({ name }) => name);
    if (new Set(fields).size !== fields.length) context.addIssue({ code: "custom", path: ["resources", index, "fields"], message: "resource fields must not contain duplicates" });
    if (new Set(resource.webhookEvents).size !== resource.webhookEvents.length) context.addIssue({ code: "custom", path: ["resources", index, "webhookEvents"], message: "public webhook events must not contain duplicates" });
    if (fields.some((name) => ["id", "organizationId", "revision", "createdAt", "updatedAt"].includes(name))) context.addIssue({ code: "custom", path: ["resources", index, "fields"], message: "resource fields cannot use generated identity or versioning names" });
    if (!resource.fields.some((field) => field.name === "name" && field.type === "string" && field.required)) context.addIssue({ code: "custom", path: ["resources", index, "fields"], message: "generated CRUD screens require a required name:string field" });
    if (resource.fields.some((field) => field.name !== "name" && field.required)) context.addIssue({ code: "custom", path: ["resources", index, "fields"], message: "additional generated fields must initially be optional for additive migration safety" });
    if (resource.pagination.defaultLimit > resource.pagination.maxLimit) context.addIssue({ code: "custom", path: ["resources", index, "pagination"], message: "default pagination limit cannot exceed max limit" });
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
