import { SUPPORTED_TOOLCHAIN, type CapabilityRow, type EvidenceStatus, type InfraOperation } from "./capabilities.js";

/**
 * Recorded P01 observations (docs/STRIPE_PROJECTS_CAPABILITIES.md). No row is
 * hosted_verified yet, so every mutating operation resolves as not allowed.
 */
const OBSERVED_AT = "2026-10-01T21:29:36.000Z";
const MAX_AGE_DAYS = 30;

type Entry = [operation: InfraOperation, evidence: EvidenceStatus, commands: string[], unknowns: string[], limitations?: string[]];

const common = (adoption: string): Entry[] => [
  ["discover", "locally_tested", ["catalog"], [], ["catalog writes .gitignore and .projects/cache into its working directory"]],
  ["inspect", "documented", ["status", "services list"], [], ["requires an authenticated Stripe session"]],
  ["link", "documented", ["link"], ["whether link can create a provider account without separate consent", "unattended authentication and renewal"]],
  ["create", "documented", ["add"], ["stable resource identity fields in output", "response-loss reconciliation", "duplicate request behavior"], ["automatic env pull writes plaintext credentials to the active output file"]],
  ["adopt", "unsupported", ["add"], [], [adoption]],
  ["delete", "documented", ["remove"], ["exact immutable-ID targeting", "credential cleanup on removal"], ["remove targets a name or provider/service, not an immutable ID"]],
  ["detach", "unknown", [], ["a non-destructive detach operation"], ["remove --untrack is local-only and is not detach proof"]],
  ["credentials_pull", "documented", ["env pull"], ["structured non-plaintext delivery channel"], ["delivers dotenv plaintext only"]],
  ["rotate", "documented", ["rotate"], ["invalidation timing", "overlap support", "rotation bundle unit", "re-retrieval after response loss"]],
  ["tier_change", "documented", ["upgrade", "downgrade"], ["current price at apply time"]],
  ["environment_membership", "documented", ["env add", "env remove"], ["isolation of active-environment selection"]],
];

function rows(provider: string, service: string, entries: Entry[]): CapabilityRow[] {
  return entries.map(([operation, evidence, commands, unknowns, limitations = []]) => ({
    provider, service, operation, evidence, toolchain: SUPPORTED_TOOLCHAIN, commands, unknowns,
    observedAt: OBSERVED_AT, maxAgeDays: MAX_AGE_DAYS, limitations,
  }));
}

const notLinkable = "catalog reports existing_resource_linking: unsupported";

export const PROJECTS_CAPABILITIES: readonly CapabilityRow[] = Object.freeze([
  ...rows("neon", "postgres", common(notLinkable)),
  ...rows("cloudflare", "workers", common(notLinkable)),
  ...rows("cloudflare", "hyperdrive", common(notLinkable)),
  ...rows("cloudflare", "queues", common(notLinkable)),
  ...rows("cloudflare", "r2:bucket", common(notLinkable)),
  ...rows("resend", "email", common(notLinkable)),
]);

export type CatalogService = Readonly<{ kind: "plan" | "deployable"; scope: "project" | "account"; pricing: "free" | "paid" | "component" }>;

/** Catalog services observed at the recorded toolchain (fixtures/stripe-projects/0.45.0). */
export const CATALOG_SERVICES: Readonly<Record<string, Readonly<Record<string, CatalogService>>>> = Object.freeze({
  neon: {
    free: { kind: "plan", scope: "project", pricing: "free" },
    launch: { kind: "plan", scope: "project", pricing: "paid" },
    postgres: { kind: "deployable", scope: "project", pricing: "component" },
  },
  cloudflare: {
    "browser-run": { kind: "deployable", scope: "project", pricing: "component" },
    containers: { kind: "deployable", scope: "project", pricing: "component" },
    d1: { kind: "deployable", scope: "project", pricing: "component" },
    hyperdrive: { kind: "deployable", scope: "project", pricing: "component" },
    kv: { kind: "deployable", scope: "project", pricing: "component" },
    queues: { kind: "deployable", scope: "project", pricing: "component" },
    "r2:bucket": { kind: "deployable", scope: "project", pricing: "paid" },
    "registrar:domain": { kind: "deployable", scope: "project", pricing: "paid" },
    workers: { kind: "deployable", scope: "project", pricing: "component" },
    "workers-ai": { kind: "deployable", scope: "project", pricing: "component" },
    "workers:free": { kind: "plan", scope: "project", pricing: "free" },
    "workers:paid": { kind: "plan", scope: "project", pricing: "paid" },
  },
  resend: {
    email: { kind: "deployable", scope: "project", pricing: "component" },
    free: { kind: "plan", scope: "account", pricing: "free" },
    pro: { kind: "plan", scope: "account", pricing: "paid" },
  },
});

export function capabilityFor(provider: string, service: string, operation: InfraOperation): CapabilityRow | undefined {
  return PROJECTS_CAPABILITIES.find((row) => row.provider === provider && row.service === service && row.operation === operation);
}
