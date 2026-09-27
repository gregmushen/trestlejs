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

export const secretDeclarationSchema = z
  .object({
    /** Where the value is pushed: the customer Worker, CI only, or the optional platform admin Worker. */
    target: z.enum(["worker", "ci", "admin"]),
    /** Also pushed to the platform admin Worker (admin) or the trigger.dev job runtime's environment (jobs). */
    shareWith: z.array(z.enum(["admin", "jobs"])).min(1).optional(),
    required: z.array(environmentNameSchema),
    rotation: z.enum(["single-value", "dual-value"]).optional(),
  })
  .strict()
  .refine((declaration) => !declaration.shareWith || declaration.target === "worker", { message: "only Worker secrets can be shared with the platform admin", path: ["shareWith"] });

const providerModeSchema = z.enum(["disabled", "fixture", "live"]);

/**
 * An external provider the application depends on. The application supplies
 * the adapter; this declares what each environment needs so readiness can be
 * reported without deploying. Health checks are read-only requests, run only
 * when asked for.
 */
export const providerDeclarationSchema = z
  .object({
    description: z.string().min(1),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).default([]),
    /** Per environment: disabled, fixture (local stand-in, no credentials), or live. Unlisted environments are disabled. */
    mode: z.partialRecord(environmentNameSchema, providerModeSchema).default({}),
    /** Optional format checks for secret values, as regular expressions; values are never printed. */
    patterns: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/u), z.string().min(1)).optional(),
    setup: z.string().min(1),
    health: z.object({
      url: z.string().url().refine((value) => value.startsWith("https://"), "health checks must use https"),
      /** Sends this secret as a bearer token; the URL never carries secrets. */
      bearer: z.string().regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
      expect: z.array(z.number().int().min(100).max(599)).min(1).default([200]),
    }).strict().optional(),
  })
  .strict();

/**
 * Where committed events and scheduled work run. `cloudflare` (the default)
 * uses Queues, Workflows, and the scheduler Durable Object; `trigger` and
 * `inngest` hand the same committed events to trigger.dev or Inngest, hosted
 * (`cloud`) or self-hosted at `endpoint`.
 */
export const jobsDeclarationSchema = z
  .object({
    runtime: z.enum(["cloudflare", "trigger", "inngest"]).default("cloudflare"),
    hosting: z.enum(["cloud", "self-hosted"]).default("cloud"),
    /** The trigger.dev project ref (not a secret). */
    project: z.string().regex(/^proj_[a-z0-9]+$/u).optional(),
    endpoint: z.string().url().refine((value) => value.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/u.test(value), "self-hosted endpoints must use https (http only for localhost)").optional(),
  })
  .strict()
  .superRefine((jobs, context) => {
    if (jobs.runtime === "cloudflare" && (jobs.hosting !== "cloud" || jobs.endpoint)) context.addIssue({ code: "custom", path: ["hosting"], message: "the cloudflare runtime has no hosting or endpoint setting" });
    if (jobs.hosting === "self-hosted" && !jobs.endpoint) context.addIssue({ code: "custom", path: ["endpoint"], message: "self-hosted job runtimes need an endpoint" });
    if (jobs.hosting === "cloud" && jobs.endpoint) context.addIssue({ code: "custom", path: ["endpoint"], message: "hosted job runtimes use the provider's endpoint; set hosting: self-hosted to use your own" });
  });

/**
 * Who holds tenant Connection credentials in deployed environments (local
 * development always uses the deterministic local backend). `nango` is
 * experimental; `host` points at a self-hosted Nango instead of Nango Cloud.
 */
export const integrationsDeclarationSchema = z
  .object({
    backend: z.enum(["none", "nango"]).default("none"),
    host: z.string().url().refine((value) => value.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/u.test(value), "a self-hosted Nango must use https (http only for localhost)").optional(),
  })
  .strict()
  .refine((integrations) => integrations.backend === "nango" || !integrations.host, { message: "host applies only to the nango backend", path: ["host"] });

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
    environments: z.array(environmentNameSchema).min(1),
    secrets: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/u), secretDeclarationSchema).optional(),
    providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/u), providerDeclarationSchema).optional(),
    jobs: jobsDeclarationSchema.optional(),
    integrations: integrationsDeclarationSchema.optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    // The optional platform admin is generated as apps/admin; the capability and the app move together.
    if (manifest.capabilities.admin && !manifest.apps.admin) context.addIssue({ code: "custom", path: ["apps", "admin"], message: "capabilities.admin requires apps.admin (generated with create-trestlejs --admin)" });
    if (manifest.apps.admin && !manifest.capabilities.admin) context.addIssue({ code: "custom", path: ["capabilities", "admin"], message: "apps.admin is declared but capabilities.admin is false" });
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
