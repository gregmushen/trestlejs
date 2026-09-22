import { access } from "node:fs/promises";
import path from "node:path";

import type { EnvironmentName, ProjectManifest } from "@trestlejs/core";

export type EnvironmentStatus = {
  environment: EnvironmentName;
  declared: boolean;
  applications: Array<{ name: string; path: string; present: boolean }>;
  capabilities: Array<{ name: keyof ProjectManifest["capabilities"]; state: "declared" | "unavailable" }>;
  requiredSecrets: Array<{ name: string; target: "worker" | "ci" }>;
  requiredVariables: string[];
};

export async function inspectEnvironmentStatus(root: string, manifest: ProjectManifest, environment: EnvironmentName): Promise<EnvironmentStatus> {
  const applications = await Promise.all(Object.entries(manifest.apps).map(async ([name, relativePath]) => ({
    name,
    path: relativePath,
    present: await access(path.join(root, relativePath)).then(() => true, () => false),
  })));
  const capabilities = Object.entries(manifest.capabilities).map(([name, enabled]) => ({
    name: name as keyof ProjectManifest["capabilities"],
    state: enabled ? "declared" as const : "unavailable" as const,
  }));
  const requiredSecrets = Object.entries(manifest.secrets ?? {})
    .filter(([, declaration]) => declaration.required.includes(environment))
    .map(([name, declaration]) => ({ name, target: declaration.target }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    environment,
    declared: manifest.environments.includes(environment),
    applications,
    capabilities,
    requiredSecrets,
    requiredVariables: environment === "local"
      ? []
      : ["API_URL", "APP_URL", ...(environment === "preview" ? ["CLOUDFLARE_WORKERS_SUBDOMAIN"] : []), "DATABASE_RUNTIME_ROLE", "SITE_URL"],
  };
}

export function formatEnvironmentStatus(status: EnvironmentStatus): string {
  return [
    `${status.environment}  ${status.declared ? "declared" : "not declared"}`,
    "Applications",
    ...status.applications.map((app) => `  ${app.present ? "✓" : "✗"} ${app.name.padEnd(10)} ${app.path}`),
    "Capabilities",
    ...status.capabilities.map((capability) => `  ${capability.name.padEnd(16)} ${capability.state}`),
    "Required secrets",
    ...status.requiredSecrets.map((secret) => `  ${secret.name.padEnd(28)} ${secret.target}`),
    ...(status.requiredVariables.length ? ["Required variables", ...status.requiredVariables.map((name) => `  ${name}`)] : []),
    "",
  ].join("\n");
}
