import { stringify } from "yaml";

import { CATALOG_SERVICES } from "./capability-matrix.js";
import { findCredentialLeaves } from "./redaction.js";

/**
 * Stripe Projects template-registry manifest for a materialized Trestle
 * starter (spec §30, D-06). Generated from one pinned release; validated
 * against the documented field reference and the recorded catalog.
 */

export type RegistryManifest = Readonly<{
  guided: Readonly<{ category: string; framework: string }>;
  template: string;
  variant: string;
  default: boolean;
  variant_description: string;
  install_command: string;
  metadata: Readonly<{ name: string; description: string; owner: string; tags: readonly string[] }>;
  repo: string;
  ref: string;
  services: readonly string[];
  next_steps: ReadonlyArray<Readonly<{ label: string; command: string }>>;
}>;

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]*$/u;

/** Builds the manifest for one pinned commit of a materialized starter. */
export function registryManifest(options: { repo: string; ref: string; trestleVersion: string; services: readonly string[] }): RegistryManifest {
  return {
    guided: { category: "saas", framework: "astro" },
    template: "trestlejs/trestle-saas",
    variant: "neon",
    default: true,
    variant_description: "Cloudflare Workers • Neon • Resend",
    // Lifecycle scripts stay off: install runs before credentials exist and must not grant later authority.
    install_command: "pnpm install --frozen-lockfile --ignore-scripts",
    metadata: {
      name: "TrestleJS SaaS",
      description: `Multi-tenant SaaS on Cloudflare with PostgreSQL row-level security (trestlejs ${options.trestleVersion})`,
      owner: "gregmushen",
      tags: ["SaaS", "Cloudflare", "PostgreSQL", "Astro", "TanStack Router", "Hono"],
    },
    repo: options.repo,
    ref: options.ref,
    services: [...options.services],
    next_steps: [
      { label: "Check infrastructure readiness (read-only)", command: "pnpm trestle --experimental infra doctor --env staging" },
      { label: "Run locally (no provider accounts needed)", command: "pnpm dev" },
    ],
  };
}

export function validateRegistryManifest(manifest: RegistryManifest): string[] {
  const problems: string[] = [];
  if (!IDENTIFIER.test(manifest.guided.category)) problems.push("guided.category must be a lowercase identifier");
  if (!IDENTIFIER.test(manifest.guided.framework)) problems.push("guided.framework must be a lowercase identifier");
  if (manifest.guided.framework === "tanstack-start") problems.push("Trestle uses TanStack Router, not TanStack Start; do not classify it as tanstack-start");
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/u.test(manifest.template)) problems.push("template must be owner/name");
  if (!IDENTIFIER.test(manifest.variant)) problems.push("variant must be a lowercase identifier");
  for (const field of ["variant_description", "install_command"] as const) if (!manifest[field].trim()) problems.push(`${field} is required`);
  for (const field of ["name", "description", "owner"] as const) if (!manifest.metadata[field].trim()) problems.push(`metadata.${field} is required`);
  if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\/tree\/[^\s]+)?$/u.test(manifest.repo)) problems.push("repo must be a public GitHub repository or tree URL");
  if (!/^[a-f0-9]{40}$/u.test(manifest.ref)) problems.push("ref must pin a full 40-character commit SHA");
  if (manifest.services.length === 0) problems.push("at least one Projects service is required");
  for (const service of manifest.services) {
    const [provider, id] = service.split("/");
    if (!provider || !id || !CATALOG_SERVICES[provider]?.[id]) problems.push(`${service} is not a service identifier in the recorded catalog`);
  }
  if (new Set(manifest.services).size !== manifest.services.length) problems.push("services must not repeat");
  if (!/--ignore-scripts\b/u.test(manifest.install_command)) problems.push("install_command must disable dependency lifecycle scripts");
  if (/\b(?:stripe\s+projects|trestle\b[^\n]*\binfra\s+apply)\b/u.test(manifest.install_command)) problems.push("install_command must not provision or apply infrastructure");
  if (findCredentialLeaves(manifest).length) problems.push("manifest contains credential-like values");
  return problems;
}

export function renderRegistryManifest(manifest: RegistryManifest): string {
  const problems = validateRegistryManifest(manifest);
  if (problems.length) throw new Error(`registry manifest is invalid:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  return stringify(manifest, { lineWidth: 0 });
}
