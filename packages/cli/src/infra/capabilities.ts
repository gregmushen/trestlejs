/**
 * Operation-scoped Stripe Projects capability evidence (spec §7, plan P01).
 *
 * Support is recorded per provider, service, operation and toolchain. Evidence
 * is invalidated by a toolchain change or expiry; a required unknown blocks the
 * operation instead of defaulting to supported.
 */

export type EvidenceStatus = "documented" | "locally_tested" | "hosted_verified" | "unsupported" | "unknown";

export type InfraOperation =
  | "discover" | "link" | "create" | "adopt" | "inspect" | "delete" | "detach"
  | "credentials_pull" | "rotate" | "tier_change" | "environment_membership";

/** Every effect a plugin command can have, local as well as remote. */
export type CommandEffect =
  | "remote_read" | "remote_link" | "remote_project_create" | "remote_resource_create" | "remote_resource_delete"
  | "remote_tier_change" | "remote_credential_issue" | "remote_secret_store_write" | "remote_membership_change"
  | "local_cache_write" | "local_gitignore_write" | "local_state_write" | "local_plaintext_credentials"
  | "local_vault_write" | "local_agent_skills" | "local_install_command" | "browser_launch" | "may_charge";

export type Toolchain = Readonly<{ pluginVersion: string; pluginSha256: string; envelopeVersion: string }>;

/** D-01: the only toolchain whose observations this module accepts. */
export const SUPPORTED_TOOLCHAIN: Toolchain = Object.freeze({
  pluginVersion: "0.45.0",
  pluginSha256: "187cbb898aed495a54aa357b29d71234105c15d29e1ec195019cc570d9b3bf77",
  envelopeVersion: "0.1",
});

/**
 * Complete effect inventory per plugin command at 0.45.0. Commands absent from
 * this table are never executed by the adapter.
 */
export const COMMAND_EFFECTS: Readonly<Record<string, readonly CommandEffect[]>> = Object.freeze({
  "catalog": ["remote_read", "local_cache_write", "local_gitignore_write"],
  "search": ["remote_read", "local_cache_write", "local_gitignore_write"],
  "status": ["remote_read", "local_cache_write"],
  "list": ["remote_read", "local_cache_write"],
  "services list": ["remote_read", "local_cache_write"],
  "env list": ["remote_read", "local_cache_write"],
  "env show": ["remote_read", "local_cache_write"],
  "init": ["remote_project_create", "local_state_write", "local_gitignore_write", "local_agent_skills", "local_install_command"],
  "link": ["remote_link", "local_state_write"],
  "add": ["remote_link", "remote_resource_create", "remote_secret_store_write", "local_state_write", "local_vault_write", "local_plaintext_credentials", "may_charge"],
  "rotate": ["remote_credential_issue", "remote_secret_store_write", "local_vault_write", "local_plaintext_credentials"],
  "upgrade": ["remote_tier_change", "local_vault_write", "local_plaintext_credentials", "may_charge"],
  "downgrade": ["remote_tier_change", "local_vault_write", "local_plaintext_credentials", "may_charge"],
  "remove": ["remote_resource_delete", "local_state_write"],
  "env pull": ["remote_read", "local_vault_write", "local_plaintext_credentials"],
  "env create": ["remote_membership_change", "local_state_write"],
  "env use": ["local_state_write"],
  "env add": ["remote_membership_change", "local_state_write", "local_vault_write", "local_plaintext_credentials"],
  "env remove": ["remote_membership_change", "local_state_write", "local_vault_write", "local_plaintext_credentials"],
  "open": ["browser_launch"],
});

export const READ_ONLY_REMOTE: readonly CommandEffect[] = ["remote_read", "local_cache_write", "local_gitignore_write"];

/** True when a command touches nothing remote except reads (local scratch writes are still effects). */
export function isRemoteReadOnly(command: string): boolean {
  const effects = COMMAND_EFFECTS[command];
  return effects !== undefined && effects.every((effect) => READ_ONLY_REMOTE.includes(effect));
}

export type CapabilityRow = Readonly<{
  provider: string;
  /** Exact catalog `service_id`; never derived from a provider name. */
  service: string;
  operation: InfraOperation;
  evidence: EvidenceStatus;
  toolchain: Toolchain;
  /** Plugin commands the operation runs; their full effects are part of the row. */
  commands: readonly string[];
  /** Named safety properties that are not yet established. Any entry blocks mutation. */
  unknowns: readonly string[];
  observedAt: string;
  /** Freshness window; evidence older than this is treated as unknown. */
  maxAgeDays: number;
  limitations: readonly string[];
}>;

export type ResolvedCapability = Readonly<{
  row: CapabilityRow;
  evidence: EvidenceStatus;
  effects: readonly CommandEffect[];
  /** Whether Trestle may run this operation now. Mutations need hosted evidence and no unknowns. */
  allowed: boolean;
  reasons: readonly string[];
}>;

export const MUTATING: ReadonlySet<InfraOperation> = new Set(["link", "create", "adopt", "delete", "detach", "rotate", "tier_change", "environment_membership", "credentials_pull"]);

export function effectsOf(commands: readonly string[]): CommandEffect[] {
  const effects = new Set<CommandEffect>();
  for (const command of commands) {
    const known = COMMAND_EFFECTS[command];
    if (!known) throw new Error(`command "${command}" has no recorded effect inventory`);
    for (const effect of known) effects.add(effect);
  }
  return [...effects].sort();
}

/**
 * Re-evaluates a recorded row against the toolchain actually present now.
 * A different plugin, hash, or envelope, or stale evidence, downgrades the row
 * to `unknown` (AR-14). Mutation additionally requires hosted or local test
 * evidence and no outstanding unknowns.
 */
export function resolveCapability(row: CapabilityRow, observed: Toolchain | undefined, now: Date): ResolvedCapability {
  const reasons: string[] = [];
  let evidence = row.evidence;
  let effects: CommandEffect[] = [];
  try {
    effects = effectsOf(row.commands);
  } catch (error) {
    evidence = "unknown";
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  if (!observed) {
    evidence = "unknown";
    reasons.push("Projects toolchain is unavailable or unverified");
  } else {
    if (observed.pluginVersion !== row.toolchain.pluginVersion) reasons.push(`plugin version ${observed.pluginVersion} differs from evidence version ${row.toolchain.pluginVersion}`);
    if (observed.pluginSha256 !== row.toolchain.pluginSha256) reasons.push("plugin executable hash differs from the qualified executable");
    if (observed.envelopeVersion !== row.toolchain.envelopeVersion) reasons.push(`output schema ${observed.envelopeVersion} differs from ${row.toolchain.envelopeVersion}`);
    if (reasons.length > 0 && evidence !== "unsupported") evidence = "unknown";
  }
  const observedAt = Date.parse(row.observedAt);
  if (!Number.isFinite(observedAt)) {
    evidence = "unknown";
    reasons.push("evidence has no valid observation time");
  } else if (now.getTime() - observedAt > row.maxAgeDays * 86_400_000 && evidence !== "unsupported") {
    evidence = "unknown";
    reasons.push(`evidence from ${row.observedAt} is older than ${row.maxAgeDays} days`);
  }
  for (const unknown of row.unknowns) reasons.push(`unknown: ${unknown}`);
  if (evidence === "unsupported") reasons.push(`${row.provider}/${row.service} ${row.operation} is unsupported through Projects`);
  const sufficient = MUTATING.has(row.operation)
    ? evidence === "hosted_verified"
    : evidence === "documented" || evidence === "locally_tested" || evidence === "hosted_verified";
  return { row, evidence, effects, allowed: sufficient && reasons.length === 0, reasons };
}
