import type { ProjectManifest } from "../manifest.js";
import type { CredentialMetadata } from "./credentials.js";
import type { InfrastructureIntent, InfraEnvironment } from "./schema.js";

/**
 * Declared credential consumers (spec §19–§20, plan P08). Each consumer gets
 * only the credentials that name it; operator-only credentials are never
 * projected to an application consumer.
 */

export type ConsumerId = "worker" | "admin" | "jobs" | "migrations" | "ci";

export type ConsumerSpec = Readonly<{
  id: ConsumerId;
  /** True when verification must open a fresh connection (database-backed consumers). */
  requiresNewConnection: boolean;
  /** Application consumers receive host secrets; operator consumers run inside trusted tooling. */
  plane: "application" | "operator";
}>;

export class ConsumerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumerError";
  }
}

/** Consumers the application actually deploys in this environment. */
export function consumerRegistry(manifest: ProjectManifest, intent: InfrastructureIntent, environment: InfraEnvironment): ConsumerSpec[] {
  const enabled = new Map<ConsumerId, ConsumerSpec>();
  if (manifest.apps.worker) enabled.set("worker", { id: "worker", requiresNewConnection: true, plane: "application" });
  if (manifest.capabilities.admin && manifest.apps.admin) enabled.set("admin", { id: "admin", requiresNewConnection: true, plane: "application" });
  enabled.set("migrations", { id: "migrations", requiresNewConnection: true, plane: "operator" });
  enabled.set("ci", { id: "ci", requiresNewConnection: false, plane: "operator" });
  const referenced = new Set<ConsumerId>();
  for (const resource of Object.values(intent.environments[environment]?.resources ?? {})) {
    for (const binding of Object.values(resource.credentialBindings)) for (const consumer of binding.consumers) referenced.add(consumer);
  }
  if (referenced.has("jobs")) enabled.set("jobs", { id: "jobs", requiresNewConnection: true, plane: "application" });
  const missing = [...referenced].filter((consumer) => !enabled.has(consumer));
  if (missing.length) throw new ConsumerError(`credentials target consumers the application does not deploy: ${missing.join(", ")}`);
  return [...enabled.values()].filter((consumer) => referenced.has(consumer.id) || consumer.plane === "application").sort((left, right) => left.id.localeCompare(right.id));
}

/** Values one consumer may receive from a snapshot. */
export function projectionFor(consumer: ConsumerId, values: Readonly<Record<string, string>>, metadata: readonly CredentialMetadata[]): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const entry of metadata) {
    if (!entry.consumers.includes(consumer)) continue;
    if (entry.classification === "operator-only" && consumer !== "migrations") throw new ConsumerError(`${entry.name} is operator-only and cannot be projected to ${consumer}`);
    const value = values[entry.name];
    if (value === undefined) throw new ConsumerError(`${entry.name} is declared for ${consumer} but missing from the snapshot`);
    projected[entry.name] = value;
  }
  return projected;
}

/** Non-secret marker deployed alongside credentials so probes can prove which generation a revision uses. */
export function generationMarker(environment: string, generation: number, artifactDigest: string): string {
  const artifact = artifactDigest.replace(/^sha256:/u, "").slice(0, 12).toLowerCase();
  if (!/^[a-f0-9]{12}$/u.test(artifact)) throw new ConsumerError("artifact digest must be a sha256 digest");
  return `${environment}:g${generation}:${artifact}`;
}
