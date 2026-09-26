import type { EnvironmentName, ProjectManifest } from "./core.js";
import type { providerDeclarationSchema } from "./manifest.js";
import type { z } from "zod";

export type ProviderDeclaration = z.output<typeof providerDeclarationSchema>;
export type ProviderState = "disabled" | "fixture" | "unconfigured" | "invalid" | "inaccessible" | "healthy";
export type ProviderStatus = Readonly<{
  id: string;
  description: string;
  environment: EnvironmentName;
  mode: "disabled" | "fixture" | "live";
  state: ProviderState;
  detail: string;
  repair?: string;
  /** True when a live health request ran. */
  checkedLive: boolean;
}>;

/**
 * Framework integrations described with the same convention applications use.
 * An application declaration with the same id replaces these.
 */
export const builtInProviders: Readonly<Record<string, ProviderDeclaration>> = {
  resend: {
    description: "Transactional email (Resend); local development captures mail instead",
    secrets: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"],
    mode: { local: "fixture", preview: "live", staging: "live", production: "live" },
    patterns: { RESEND_API_KEY: "^re_", RESEND_WEBHOOK_SECRET: "^whsec_" },
    setup: "Create an API key at https://resend.com/api-keys and a webhook signing secret, then: pnpm exec trestle secrets set RESEND_API_KEY --env <environment>",
    health: { url: "https://api.resend.com/domains", bearer: "RESEND_API_KEY", expect: [200] },
  },
  stripe: {
    description: "Billing (Stripe); local development uses the local billing adapter",
    secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    mode: { local: "fixture", preview: "live", staging: "live", production: "live" },
    patterns: { STRIPE_SECRET_KEY: "^(sk|rk)_(test|live)_", STRIPE_WEBHOOK_SECRET: "^whsec_" },
    setup: "Create a restricted key in the Stripe dashboard, then: pnpm exec trestle secrets set STRIPE_SECRET_KEY --env <environment>; run trestle payments stripe webhook for the signing secret",
    health: { url: "https://api.stripe.com/v1/balance", bearer: "STRIPE_SECRET_KEY", expect: [200] },
  },
};

export type ProviderProbe = (url: string, headers: Record<string, string>) => Promise<{ status: number } | { error: string }>;

const defaultProbe: ProviderProbe = async (url, headers) => {
  try {
    const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(5_000), redirect: "error" });
    await response.body?.cancel();
    return { status: response.status };
  } catch (error) {
    return { error: error instanceof Error ? error.name : "request failed" };
  }
};

/** The trigger.dev job runtime, when selected: the Worker dispatches with the environment's secret key. */
function triggerProvider(manifest: ProjectManifest): Record<string, ProviderDeclaration> {
  if (manifest.jobs?.runtime !== "trigger") return {};
  const apiUrl = (manifest.jobs.endpoint ?? "https://api.trigger.dev").replace(/\/$/u, "");
  return {
    trigger: {
      description: `Background jobs (trigger.dev${manifest.jobs.hosting === "self-hosted" ? `, self-hosted at ${apiUrl}` : ""})`,
      secrets: ["TRIGGER_SECRET_KEY"],
      mode: { local: "live", preview: "live", staging: "live", production: "live" },
      patterns: { TRIGGER_SECRET_KEY: "^tr_(dev|preview|stg|prod)_" },
      setup: "Copy the environment's secret key from the trigger.dev dashboard (API keys), then: pnpm exec trestle secrets set TRIGGER_SECRET_KEY --env <environment>",
      health: { url: `${apiUrl}/api/v1/runs?page%5Bsize%5D=1`, bearer: "TRIGGER_SECRET_KEY", expect: [200] },
    },
  };
}

/** The Inngest job runtime, when selected: the Worker sends with the event key; Inngest calls back with the signing key. */
function inngestProvider(manifest: ProjectManifest): Record<string, ProviderDeclaration> {
  if (manifest.jobs?.runtime !== "inngest") return {};
  const apiUrl = (manifest.jobs.endpoint ?? "https://api.inngest.com").replace(/\/$/u, "");
  return {
    inngest: {
      description: `Background jobs (Inngest${manifest.jobs.hosting === "self-hosted" ? `, self-hosted at ${apiUrl}` : ""}); local development uses the Inngest Dev Server`,
      secrets: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
      mode: { local: "fixture", preview: "live", staging: "live", production: "live" },
      patterns: { INNGEST_SIGNING_KEY: "^signkey-" },
      setup: "Create an event key and copy the signing key in the Inngest dashboard, then: pnpm exec trestle secrets set INNGEST_EVENT_KEY --env <environment> (and INNGEST_SIGNING_KEY)",
      health: { url: `${apiUrl}/v1/events?limit=1`, bearer: "INNGEST_SIGNING_KEY", expect: [200] },
    },
  };
}

export function declaredProviders(manifest: ProjectManifest): Record<string, ProviderDeclaration> {
  const declared = (manifest as { providers?: Record<string, ProviderDeclaration> }).providers ?? {};
  return { ...builtInProviders, ...triggerProvider(manifest), ...inngestProvider(manifest), ...declared };
}

/**
 * Readiness of every provider in one environment. Read-only unless `live` is
 * set, which sends each provider's declared GET health request; nothing is
 * created, purchased, or sent. Secret values are never returned.
 */
export async function providerStatuses(
  manifest: ProjectManifest,
  environment: EnvironmentName,
  secrets: Readonly<Record<string, string>> | { inaccessible: string },
  options: Readonly<{ live?: boolean; probe?: ProviderProbe }> = {},
): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = [];
  for (const [id, provider] of Object.entries(declaredProviders(manifest)).sort(([left], [right]) => left.localeCompare(right))) {
    const mode = provider.mode[environment] ?? "disabled";
    const base = { id, description: provider.description, environment, mode, checkedLive: false } as const;
    if (mode === "disabled") { statuses.push({ ...base, state: "disabled", detail: `not used in ${environment}` }); continue; }
    if (mode === "fixture") { statuses.push({ ...base, state: "fixture", detail: "local stand-in; no credentials needed" }); continue; }
    if ("inaccessible" in secrets) { statuses.push({ ...base, state: "inaccessible", detail: secrets.inaccessible, repair: `set TRESTLE_MASTER_KEY for ${environment}, or run from a machine with config/credentials/${environment}.key` }); continue; }
    const missing = provider.secrets.filter((name) => !secrets[name]);
    if (missing.length) { statuses.push({ ...base, state: "unconfigured", detail: `missing ${missing.join(", ")}`, repair: provider.setup.replaceAll("<environment>", environment) }); continue; }
    const malformed = Object.entries(provider.patterns ?? {}).filter(([name, pattern]) => secrets[name] !== undefined && !new RegExp(pattern, "u").test(secrets[name]!)).map(([name]) => name);
    if (malformed.length) { statuses.push({ ...base, state: "invalid", detail: `${malformed.join(", ")} ${malformed.length === 1 ? "does" : "do"} not have the expected format`, repair: provider.setup.replaceAll("<environment>", environment) }); continue; }
    if (!options.live || !provider.health) { statuses.push({ ...base, state: "healthy", detail: provider.health ? "credentials present (run with --live-check to verify them)" : "credentials present" }); continue; }
    const headers: Record<string, string> = { accept: "application/json", ...(provider.health.bearer ? { authorization: `Bearer ${secrets[provider.health.bearer] ?? ""}` } : {}) };
    const result = await (options.probe ?? defaultProbe)(provider.health.url, headers);
    if ("error" in result) statuses.push({ ...base, checkedLive: true, state: "inaccessible", detail: `health request failed (${result.error})`, repair: "check network access and the provider's status page" });
    else if (provider.health.expect.includes(result.status)) statuses.push({ ...base, checkedLive: true, state: "healthy", detail: `health request returned ${result.status}` });
    else statuses.push({ ...base, checkedLive: true, state: "invalid", detail: `health request returned ${result.status}; the credentials were rejected or lack access`, repair: provider.setup.replaceAll("<environment>", environment) });
  }
  return statuses;
}

export function formatProviderStatuses(statuses: readonly ProviderStatus[]): string {
  const width = Math.max(8, ...statuses.map((status) => status.id.length));
  return statuses.map((status) => `${status.id.padEnd(width)}  ${status.mode.padEnd(8)}  ${status.state.padEnd(12)}  ${status.detail}${status.repair ? `\n${" ".repeat(width + 26)}repair: ${status.repair}` : ""}`).join("\n");
}
