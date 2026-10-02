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

const HOSTED_AT = "2026-10-02T02:31:46.000Z";

/**
 * Hosted observations for neon/postgres through Projects 0.45.0 in an
 * authorized free-plan sandbox (docs/STRIPE_PROJECTS_CAPABILITIES.md).
 */
function neonHosted(row: CapabilityRow): CapabilityRow {
  if (row.operation === "create") return { ...row, evidence: "hosted_verified", unknowns: [], observedAt: HOSTED_AT, credentialScopes: { "*_CONNECTION_STRING": "owner" }, limitations: ["add is not idempotent: repeating it creates a suffixed duplicate (database-2); Trestle journals intent and reconciles by observation instead of retrying", "outputs are prefixed by the logical name, e.g. DATABASE_CONNECTION_STRING", "the automatic pull can rename sibling outputs (NEON_ORG_ID became NEON_PLAN_ORG_ID)", "the connection string is neondb_owner with BYPASSRLS and CREATEROLE: operator-only"] };
  if (row.operation === "inspect") return { ...row, evidence: "hosted_verified", observedAt: HOSTED_AT };
  if (row.operation === "rotate") return { ...row, evidence: "hosted_verified", unknowns: [], observedAt: HOSTED_AT, limitations: ["new connections with the old password fail with 28P01 immediately; existing pooled connections keep working on the old credential", "only <NAME>_CONNECTION_STRING changes", "env pull re-retrieves the newly issued value; the response-loss window itself was not exercised hosted"] };
  if (row.operation === "link") return { ...row, unknowns: ["link created a Neon account without a browser step (observed); provider account creation needs its own approved plan"] };
  if (row.operation === "delete") return { ...row, unknowns: ["exact immutable-ID targeting (remove takes a name; observed)"] };
  return row;
}

const HOSTED_AT_2 = "2026-10-02T04:00:00.000Z";

/** Hosted observations for resend/email (2026-10-02, free plan, no email sent). */
function resendHosted(row: CapabilityRow): CapabilityRow {
  if (row.operation === "create") return { ...row, evidence: "hosted_verified", unknowns: [], observedAt: HOSTED_AT_2, credentialScopes: { RESEND_API_KEY: "owner" }, limitations: ["link created a Resend account without a browser step and materialized the account-wide free plan", "RESEND_API_KEY is not prefixed by the resource name", "the key has full account access (lists domains, audiences and API keys): operator-only"] };
  if (row.operation === "inspect") return { ...row, evidence: "hosted_verified", observedAt: HOSTED_AT_2 };
  if (row.operation === "rotate") return { ...row, evidence: "hosted_verified", unknowns: [], observedAt: HOSTED_AT_2, limitations: ["the old key is rejected immediately with 400 validation_error \"API key is invalid\" (a missing key is 401 missing_api_key)", "env pull re-retrieves the new key"] };
  if (row.operation === "link") return { ...row, unknowns: ["link created a Resend account without a browser step (observed); provider account creation needs its own approved plan"] };
  return row;
}

/** Hosted observations for cloudflare/workers (2026-10-02, workers:free). */
function cloudflareHosted(row: CapabilityRow): CapabilityRow {
  if (row.operation === "create") return { ...row, evidence: "hosted_verified", unknowns: [], observedAt: HOSTED_AT_2, limitations: ["link requires browser authentication with Cloudflare", "outputs are non-secret only (account ID, API base URL, dashboard URL, plan ID, workers.dev subdomain): no deploy token is issued, so deployment still needs direct Cloudflare authentication"] };
  if (row.operation === "inspect") return { ...row, evidence: "hosted_verified", observedAt: HOSTED_AT_2 };
  if (row.operation === "rotate") return { ...row, evidence: "unsupported", unknowns: [], observedAt: HOSTED_AT_2, limitations: ["rotate fails with provider_failure 404 Route not found; there is no credential to rotate"] };
  return row;
}

export const PROJECTS_CAPABILITIES: readonly CapabilityRow[] = Object.freeze([
  ...rows("neon", "postgres", common(notLinkable)).map(neonHosted),
  ...rows("cloudflare", "workers", common(notLinkable)).map(cloudflareHosted),
  ...rows("cloudflare", "hyperdrive", common(notLinkable)),
  ...rows("cloudflare", "queues", common(notLinkable)),
  ...rows("cloudflare", "r2:bucket", common(notLinkable)),
  ...rows("resend", "email", common(notLinkable)).map(resendHosted),
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

/**
 * Qualified rotation profiles by provider/service (D-05). Empty until a hosted
 * rotation qualification (P10) proves invalidation, bundle and re-retrieval
 * behavior for a specific tuple; rotation plans are blocked meanwhile.
 */
export function rotationProfileFor(provider: string, service: string, resourceName: string): import("./rotation.js").RotationProfile | undefined {
  // Hosted 2026-10-02: immediate invalidation for new connections, single-output bundle, re-retrieval via env pull, 28P01 distinguishes rejection.
  if (provider === "neon" && service === "postgres") return { invalidation: "immediate", bundle: [`${resourceName.toUpperCase().replace(/-/gu, "_")}_CONNECTION_STRING`], reRetrieval: "proven", retirementProbe: true };
  // Hosted 2026-10-02: immediate invalidation, single output, re-retrieval via env pull, 400 validation_error identifies a rejected key.
  if (provider === "resend" && service === "email") return { invalidation: "immediate", bundle: ["RESEND_API_KEY"], reRetrieval: "proven", retirementProbe: true };
  return undefined;
}

/**
 * Resource kinds that generated direct-provider scripts already write. A
 * Projects-owned resource of the same kind needs that writer disabled first, so
 * each resource keeps exactly one lifecycle owner (spec §5, plan P11).
 */
export const DIRECT_WRITERS: Readonly<Record<string, string>> = Object.freeze({
  "cloudflare/r2:bucket": "scripts/cloudflare-r2.mjs creates and deletes R2 buckets",
  "cloudflare/queues": "scripts/cloudflare-queues.mjs creates and deletes queues",
  "cloudflare/workers": "scripts/cloudflare-worker.mjs updates Worker settings and deletes preview Workers",
});
