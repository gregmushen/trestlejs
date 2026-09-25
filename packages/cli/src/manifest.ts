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
    /** Also pushed to the platform admin Worker when capabilities.admin is enabled. */
    shareWith: z.array(z.literal("admin")).min(1).optional(),
    required: z.array(environmentNameSchema),
    rotation: z.enum(["single-value", "dual-value"]).optional(),
  })
  .strict()
  .refine((declaration) => !declaration.shareWith || declaration.target === "worker", { message: "only Worker secrets can be shared with the platform admin", path: ["shareWith"] });

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
