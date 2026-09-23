import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const projectPath = z
  .string()
  .min(1)
  .refine((value) => !path.isAbsolute(value), "must be relative to the project root")
  .refine(
    (value) => !value.split(/[\\/]/u).includes(".."),
    "must not traverse outside the project root",
  );

export const environmentNameSchema = z.enum([
  "local",
  "preview",
  "staging",
  "production",
]);

export const secretTargetSchema = z.enum(["worker", "ci", "admin"]);

export const secretDeclarationSchema = z
  .object({
    target: secretTargetSchema,
    /** Additional deployed surfaces that receive the same value, e.g. the admin Worker. */
    shareWith: z.array(z.enum(["worker", "admin"])).min(1).optional(),
    required: z.array(environmentNameSchema),
    rotation: z.enum(["single-value", "dual-value"]).optional(),
  })
  .strict()
  .refine((declaration) => !declaration.shareWith?.includes(declaration.target as "worker" | "admin"), "shareWith must not repeat the primary target");

/** Deployed surfaces that receive a secret: its target plus any shareWith entries. */
export function secretSurfaces(declaration: z.infer<typeof secretDeclarationSchema>): Array<z.infer<typeof secretTargetSchema>> {
  return [declaration.target, ...(declaration.shareWith ?? [])];
}

export const emailProviderSchema = z.enum(["disabled", "local", "resend"]);
export const paymentsProviderSchema = z.enum(["disabled", "local", "stripe", "lago"]);

/** Usage metering: the native usage_aggregate projection, or a provider that rates usage. */
export const meteringProviderSchema = z.enum(["native", "openmeter", "lago"]);
/** Outbound webhook dispatch after the outbox commit: native Worker delivery or Svix. */
export const webhookDispatchSchema = z.enum(["native", "svix"]);

export const integrationProvidersSchema = z
  .object({
    email: emailProviderSchema,
    payments: paymentsProviderSchema,
    metering: meteringProviderSchema.optional(),
    webhooks: webhookDispatchSchema.optional(),
  })
  .strict();

/** Credential mechanisms beyond the password; Better Auth owns the protocols. Omitted means both enabled. */
export const authenticationDeclarationSchema = z
  .object({
    passkeys: z.enum(["disabled", "better-auth"]),
    twoFactor: z.enum(["disabled", "better-auth"]),
  })
  .strict();

export const ssoProviderSchema = z.enum(["disabled", "better-auth", "workos", "stytch"]);
export const directoryProviderSchema = z.enum(["disabled", "better-auth-scim", "workos", "stytch"]);

/** Enterprise identity. Providers supply identities and provisioning facts, never Trestle authority. */
export const identityDeclarationSchema = z
  .object({ sso: ssoProviderSchema, directory: directoryProviderSchema })
  .strict();

export const accessDeclarationSchema = z
  .object({
    customRoles: z.boolean(),
    serviceAccounts: z.boolean(),
    apiKeys: z.boolean(),
    /** Audited tenant-context support sessions in apps/admin. */
    supportSessions: z.boolean().optional(),
    /** User impersonation is a separate capability with its own vocabulary; it is not generated yet. */
    impersonation: z.boolean().optional(),
  })
  .strict();

export const communicationsDeclarationSchema = z
  .object({ webhooks: z.boolean(), notifications: z.boolean() })
  .strict();

export const commercialDeclarationSchema = z
  .object({ plans: z.boolean(), usage: z.boolean() })
  .strict();

export const artifactsDeclarationSchema = z
  .object({ storage: z.enum(["local", "r2"]), retentionDays: z.number().int().min(1).max(3650) })
  .strict();

type OptionalDeclarations = {
  integrations?: z.infer<typeof integrationProvidersSchema> | undefined;
  access?: z.infer<typeof accessDeclarationSchema> | undefined;
  commercial?: z.infer<typeof commercialDeclarationSchema> | undefined;
  communications?: z.infer<typeof communicationsDeclarationSchema> | undefined;
  authentication?: z.infer<typeof authenticationDeclarationSchema> | undefined;
  identity?: z.infer<typeof identityDeclarationSchema> | undefined;
  capabilities?: { admin: boolean } | undefined;
};

export function declarationIssues(value: OptionalDeclarations, providersPath: string): Array<{ path: string[]; message: string }> {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (value.access?.apiKeys && !value.access.serviceAccounts) {
    issues.push({ path: ["access", "apiKeys"], message: "API keys require service accounts" });
  }
  if (value.access?.impersonation) {
    issues.push({ path: ["access", "impersonation"], message: "User impersonation is not available in this TrestleJS version; use access.supportSessions" });
  }
  if (value.access?.supportSessions && value.capabilities && !value.capabilities.admin) {
    issues.push({ path: ["access", "supportSessions"], message: "Support sessions require capabilities.admin" });
  }
  if (value.integrations?.payments === "lago" && !value.commercial?.plans) {
    issues.push({ path: [providersPath, "payments"], message: "Lago payments require commercial.plans" });
  }
  const metering = value.integrations?.metering ?? "native";
  if (metering !== "native" && !value.commercial?.usage) {
    issues.push({ path: [providersPath, "metering"], message: "Provider metering requires commercial.usage" });
  }
  if (metering === "lago" && value.integrations?.payments !== "lago") {
    issues.push({ path: [providersPath, "metering"], message: "Lago metering rates usage inside Lago billing; it requires payments: lago (use openmeter with other payment providers)" });
  }
  if (value.integrations?.webhooks === "svix" && !value.communications?.webhooks) {
    issues.push({ path: [providersPath, "webhooks"], message: "Svix dispatch requires communications.webhooks" });
  }
  // Outside local, sensitive platform actions require multi-factor assurance.
  if (value.capabilities?.admin && value.authentication?.passkeys === "disabled" && value.authentication.twoFactor === "disabled") {
    issues.push({ path: ["authentication"], message: "The platform admin requires passkeys or two-factor authentication; operators could not satisfy step-up outside local" });
  }
  const sso = value.identity?.sso ?? "disabled";
  const directory = value.identity?.directory ?? "disabled";
  if (sso === "stytch" || directory === "stytch") {
    issues.push({ path: ["identity"], message: "The Stytch adapter is not available in this TrestleJS version; use better-auth or workos" });
  }
  if (directory !== "disabled" && sso === "disabled") {
    issues.push({ path: ["identity", "directory"], message: "Directory provisioning requires SSO; provisioned users have no password to sign in with" });
  }
  if (directory === "workos" && sso !== "workos") {
    issues.push({ path: ["identity", "directory"], message: "WorkOS Directory Sync requires WorkOS SSO so provisioned users and connections share one organization binding" });
  }
  if (directory === "better-auth-scim" && sso !== "better-auth") {
    issues.push({ path: ["identity", "directory"], message: "Better Auth SCIM requires Better Auth SSO" });
  }
  return issues;
}

export const projectManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z
      .object({
        name: z.string().min(1),
      })
      .strict(),
    apps: z.record(z.string().min(1), projectPath),
    packages: z.record(z.string().min(1), projectPath),
    tenancy: z
      .object({
        model: z.literal("organization"),
        enforcement: z.literal("postgres-rls"),
      })
      .strict(),
    database: z
      .object({
        engine: z.literal("postgresql"),
        defaultProvider: z.string().min(1),
      })
      .strict(),
    site: z
      .object({
        framework: z.literal("astro"),
        rendering: z.literal("static"),
        starter: z.enum(["southwind", "minimal"]),
      })
      .strict()
      .optional(),
    capabilities: z
      .object({
        r2: z.boolean(),
        queues: z.boolean(),
        workflows: z.boolean(),
        durableObjects: z.boolean(),
        admin: z.boolean(),
      })
      .strict(),
    integrations: integrationProvidersSchema.optional(),
    authentication: authenticationDeclarationSchema.optional(),
    identity: identityDeclarationSchema.optional(),
    access: accessDeclarationSchema.optional(),
    commercial: commercialDeclarationSchema.optional(),
    communications: communicationsDeclarationSchema.optional(),
    artifacts: artifactsDeclarationSchema.optional(),
    environments: z.array(environmentNameSchema).min(1),
    secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/u), secretDeclarationSchema).optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const issue of declarationIssues(manifest, "integrations")) context.addIssue({ code: "custom", ...issue });
    const unique = new Set(manifest.environments);
    if (unique.size !== manifest.environments.length) {
      context.addIssue({
        code: "custom",
        message: "environments must not contain duplicates",
        path: ["environments"],
      });
    }
    if (!unique.has("local")) {
      context.addIssue({
        code: "custom",
        message: "local environment is required",
        path: ["environments"],
      });
    }
  });

export type EnvironmentName = z.infer<typeof environmentNameSchema>;
export type ProjectManifest = z.infer<typeof projectManifestSchema>;

export class ManifestError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(message: string, issues: readonly z.core.$ZodIssue[] = []) {
    super(message);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

export function parseProjectManifest(input: string): ProjectManifest {
  let document: unknown;
  try {
    document = parseYaml(input);
  } catch (error) {
    throw new ManifestError(
      `Project manifest is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = projectManifestSchema.safeParse(document);
  if (!result.success) {
    throw new ManifestError("Project manifest is invalid", result.error.issues);
  }
  return result.data;
}

export async function loadProjectManifest(projectRoot: string): Promise<ProjectManifest> {
  const manifestPath = path.join(projectRoot, ".trestle", "project.yaml");
  let input: string;
  try {
    input = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new ManifestError(`Unable to read ${manifestPath} (${code})`);
  }
  return parseProjectManifest(input);
}
