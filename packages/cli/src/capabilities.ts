import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { capabilityIds, evidenceDocumentSchema, type CapabilityId, type EnvironmentName, type EvidenceDocument, type ProjectManifest } from "@trestlejs/core";

export { capabilityIds, type CapabilityId, type EvidenceDocument };
export type CapabilityState = "disabled" | "declared" | "configured" | "deployed" | "verified";

export type CapabilityStatus = {
  id: CapabilityId;
  label: string;
  state: CapabilityState;
  healthy: boolean;
  missing: string[];
  repair?: string;
};

export type CapabilityReport = { environment: EnvironmentName; capabilities: CapabilityStatus[] };

const labels: Record<CapabilityId, string> = {
  email: "Email",
  payments: "Payments",
  admin: "Platform admin",
  queues: "Queues",
  workflows: "Workflows",
  r2: "R2 artifacts",
  durableObjects: "Durable Objects",
  plans: "Plans & entitlements",
  serviceAccounts: "Service accounts",
  apiKeys: "API keys",
  webhooks: "Webhooks",
  notifications: "Notifications",
  supportSessions: "Support sessions",
  passkeys: "Passkeys",
  twoFactor: "Two-factor authentication",
  sso: "Enterprise SSO",
  directory: "Directory provisioning",
  metering: "Usage metering",
};

/** Secrets each provider choice needs outside local. Values are never read here, only presence. */
export const providerSecrets = {
  workos: ["WORKOS_API_KEY", "WORKOS_CLIENT_ID"],
  workosDirectory: ["WORKOS_WEBHOOK_SECRET"],
  openmeter: ["OPENMETER_API_KEY"],
  lagoMetering: ["LAGO_API_KEY"],
  svix: ["SVIX_API_KEY"],
} as const;

export function evidencePath(root: string, environment: EnvironmentName): string {
  return path.join(root, ".trestle", "evidence", `${environment}.json`);
}

export async function readEvidence(root: string, environment: EnvironmentName): Promise<EvidenceDocument | undefined> {
  try {
    const result = evidenceDocumentSchema.safeParse(JSON.parse(await readFile(evidencePath(root, environment), "utf8")));
    return result.success && result.data.environment === environment ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeEvidence(root: string, document: EvidenceDocument): Promise<string> {
  const target = evidencePath(root, document.environment);
  const parsed = evidenceDocumentSchema.parse(document);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return target;
}

export function repairCommand(environment: EnvironmentName): string {
  return environment === "local" ? "pnpm exec trestle setup" : `pnpm exec trestle setup --env ${environment}`;
}

const exists = (file: string) => access(file).then(() => true, () => false);

export async function inspectCapabilities(
  root: string,
  manifest: ProjectManifest,
  environment: EnvironmentName,
  options: { secrets?: Record<string, string> | undefined; evidence?: EvidenceDocument | undefined } = {},
): Promise<CapabilityReport> {
  const workerPath = manifest.apps.worker;
  const wrangler = workerPath ? await readFile(path.join(root, workerPath, "wrangler.jsonc"), "utf8").catch(() => undefined) : undefined;
  const binding = (name: string) => wrangler !== undefined && new RegExp(`"binding"\\s*:\\s*"${name}"`, "u").test(wrangler);
  const packagePresent = async (name: string, fallback: string) => exists(path.join(root, manifest.packages[name] ?? fallback, "package.json"));
  const local = environment === "local";

  const secret = (name: string): string | undefined => {
    if (!manifest.secrets?.[name]) return `declaration ${name} in .trestle/project.yaml secrets`;
    if (!options.secrets) return `secret ${name} (status unknown: credentials unavailable)`;
    return options.secrets[name] ? undefined : `secret ${name}`;
  };
  const source = async (name: string, fallback: string) => (await packagePresent(name, fallback)) ? undefined : `source ${manifest.packages[name] ?? fallback}/package.json`;
  const requireBinding = (name: string) => wrangler === undefined ? `binding ${name} (${workerPath ?? "apps/worker"}/wrangler.jsonc unavailable)` : binding(name) ? undefined : `binding ${name}`;

  const email = manifest.integrations?.email ?? "disabled";
  const payments = manifest.integrations?.payments ?? "disabled";
  const metering = manifest.integrations?.metering ?? "native";
  const authentication = manifest.authentication ?? { passkeys: "better-auth", twoFactor: "better-auth" };
  const sso = manifest.identity?.sso ?? "disabled";
  const directory = manifest.identity?.directory ?? "disabled";
  const remoteSecrets = (names: readonly string[]) => local ? [] : names.map(secret);
  // Self-hosted SCIM is verified only by a real transaction test on the environment's own driver.
  const driver = options.secrets?.DATABASE_DRIVER ?? "neon-http";
  const scimEvidence = options.evidence?.environment === environment ? options.evidence.scimTransactions : undefined;
  const scimVerified = Boolean(scimEvidence?.passed && scimEvidence.driver === driver);
  const definitions: Record<CapabilityId, { enabled: boolean; requirements: () => Promise<Array<string | undefined>> }> = {
    email: {
      enabled: email !== "disabled",
      requirements: async () => [await source("integrations", "packages/integrations"), ...(email === "resend" && !local ? ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"].map(secret) : [])],
    },
    payments: {
      enabled: payments !== "disabled",
      requirements: async () => [
        await source("billing", "packages/billing"),
        ...(payments === "stripe" && (environment === "staging" || environment === "production") ? ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].map(secret) : []),
        ...(payments === "lago" && !local ? [secret("LAGO_API_KEY")] : []),
      ],
    },
    admin: {
      enabled: manifest.capabilities.admin,
      requirements: async () => [
        !manifest.apps.admin ? "app declaration apps.admin in .trestle/project.yaml"
          : (await exists(path.join(root, manifest.apps.admin, "package.json"))) ? undefined : `source ${manifest.apps.admin}/package.json`,
      ],
    },
    queues: { enabled: manifest.capabilities.queues, requirements: async () => [requireBinding("QUEUE")] },
    workflows: { enabled: manifest.capabilities.workflows, requirements: async () => [requireBinding("WORKFLOW")] },
    r2: { enabled: manifest.capabilities.r2 || manifest.artifacts?.storage === "r2", requirements: async () => [requireBinding("ARTIFACTS")] },
    durableObjects: {
      enabled: manifest.capabilities.durableObjects,
      requirements: async () => [wrangler !== undefined && /"durable_objects"\s*:/u.test(wrangler) ? undefined : "binding durable_objects"],
    },
    plans: { enabled: Boolean(manifest.commercial?.plans), requirements: async () => [await source("billing", "packages/billing")] },
    serviceAccounts: { enabled: Boolean(manifest.access?.serviceAccounts), requirements: async () => [await source("authz", "packages/authz")] },
    apiKeys: {
      enabled: Boolean(manifest.access?.apiKeys),
      requirements: async () => [await source("authz", "packages/authz"), manifest.access?.serviceAccounts ? undefined : "access.serviceAccounts declaration"],
    },
    webhooks: {
      enabled: Boolean(manifest.communications?.webhooks),
      requirements: async () => [await source("events", "packages/events"), ...(manifest.integrations?.webhooks === "svix" ? remoteSecrets(providerSecrets.svix) : [])],
    },
    notifications: { enabled: Boolean(manifest.communications?.notifications), requirements: async () => [await source("integrations", "packages/integrations")] },
    supportSessions: {
      enabled: Boolean(manifest.access?.supportSessions),
      requirements: async () => [manifest.capabilities.admin ? undefined : "capabilities.admin declaration", await source("authz", "packages/authz")],
    },
    passkeys: { enabled: authentication.passkeys === "better-auth", requirements: async () => [await source("auth", "packages/auth")] },
    twoFactor: { enabled: authentication.twoFactor === "better-auth", requirements: async () => [await source("auth", "packages/auth")] },
    sso: {
      enabled: sso !== "disabled",
      requirements: async () => [await source("auth", "packages/auth"), ...(sso === "workos" ? remoteSecrets(providerSecrets.workos) : [])],
    },
    directory: {
      enabled: directory !== "disabled",
      requirements: async () => [await source("auth", "packages/auth"), ...(directory === "workos" ? remoteSecrets(providerSecrets.workosDirectory) : [])],
    },
    metering: {
      enabled: Boolean(manifest.commercial?.usage),
      requirements: async () => [
        await source("billing", "packages/billing"),
        ...(metering === "openmeter" ? remoteSecrets(providerSecrets.openmeter) : metering === "lago" ? remoteSecrets(providerSecrets.lagoMetering) : []),
      ],
    },
  };

  const capabilities: CapabilityStatus[] = [];
  for (const id of capabilityIds) {
    const definition = definitions[id];
    const base = { id, label: labels[id] };
    if (!definition.enabled) {
      capabilities.push({ ...base, state: "disabled", healthy: true, missing: [] });
      continue;
    }
    const missing = (await definition.requirements()).filter((value): value is string => Boolean(value));
    if (missing.length) {
      capabilities.push({ ...base, state: "declared", healthy: false, missing, repair: repairCommand(environment) });
      continue;
    }
    const evidence = options.evidence?.environment === environment ? options.evidence.capabilities[id] : undefined;
    const provable = id !== "directory" || directory !== "better-auth-scim" || scimVerified;
    const state: CapabilityState = evidence?.verified && provable && (local || evidence.deployed) ? "verified"
      : evidence?.deployed && !local ? "deployed"
        : "configured";
    capabilities.push({ ...base, state, healthy: true, missing: [] });
  }
  return { environment, capabilities };
}

export function formatCapabilities(report: CapabilityReport): string {
  const lines = [`Capabilities (${report.environment})`];
  for (const capability of report.capabilities) {
    const mark = capability.state === "disabled" ? "-" : capability.healthy ? "✓" : "✗";
    const detail = capability.missing.length ? ` missing ${capability.missing.join(", ")}${capability.repair ? ` → ${capability.repair}` : ""}` : "";
    lines.push(`${mark} ${capability.id.padEnd(16)} ${capability.state.padEnd(10)}${detail}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}
