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
    target: z.enum(["worker", "ci"]),
    required: z.array(environmentNameSchema),
    rotation: z.enum(["single-value", "dual-value"]).optional(),
  })
  .strict();

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
