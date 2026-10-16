import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { approvalCovers, type SignedApproval } from "./approvals.js";
import { canonicalDigest, sha256 } from "./canonical.js";
import { verifyPlanDigest, type InfraPlan } from "./planner.js";
import type { ApplyResult, Outcome } from "./runner.js";
import type { EnvironmentBinding, InfraEnvironment, InfrastructureIntent } from "./schema.js";
import type { OperationStore } from "./store.js";
import { findCredentialLeaves, safeInfraDiagnostic } from "./redaction.js";

/** Pages is a direct host-deployment extension: never pretend it is a
 * Projects catalog service or transfer its lifecycle during a Projects outage. */
const configSchema = z.object({
  $schema: z.string().optional(), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/u),
  pages_build_output_dir: z.literal("./dist"), compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  compatibility_flags: z.array(z.string().regex(/^[a-z0-9_]+$/u)).optional(),
  services: z.array(z.object({ binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/u), service: z.string().regex(/^[a-z0-9-]+$/u) }).strict()).refine(rows => new Set(rows.map(row => row.binding)).size === rows.length, "duplicate Pages service binding").optional(),
}).strict();
type File = { name: string; bytes: Buffer };
export type PagesArtifact = { files: File[]; digest: string; project: string; services: Record<string, string> };
function parsePagesConfig(bytes: string): z.infer<typeof configSchema> {
  let json: unknown;
  try { json = JSON.parse(bytes); } catch { throw new Error("Pages configuration must be plain JSON; source values are withheld"); }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) throw new Error("Pages configuration is outside the supported schema; source values are withheld");
  if (findCredentialLeaves(parsed.data).length) throw new Error("Pages configuration must not contain credential values");
  return parsed.data;
}

/** Snapshot exact bytes before approval/upload; reject symlinks, arbitrary
 * build hooks, credential files, unbounded input and paths outside the app. */
export async function readPagesArtifact(appRoot: string): Promise<PagesArtifact> {
  const files: File[] = [];
  let total = 0;
  let entries = 0;
  const visit = async (relative: string, optional = false): Promise<void> => {
    if (++entries > 10_000 || relative.split("/").length > 64) throw new Error("Pages artifact exceeds the reviewed size/file bounds");
    const file = path.join(appRoot, relative);
    const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (optional && error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error("Pages artifacts cannot contain symlinks");
    if (info.isDirectory()) { for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`); return; }
    if (!info.isFile() || info.size > 25 * 1024 * 1024 || files.length >= 10_000 || total + info.size > 64 * 1024 * 1024) throw new Error("Pages artifact exceeds the reviewed size/file bounds");
    if (relative.split("/").some(part => /^\.env(?:\.|$)|^\.dev\.vars(?:\.|$)/u.test(part)) || relative === "dist/.well-known/trestle-release.json") throw new Error("credential files and pre-existing release markers cannot be uploaded");
    const bytes = await readFile(file);
    if (bytes.length !== info.size) throw new Error("Pages artifact changed while reading");
    total += bytes.length; files.push({ name: relative, bytes });
  };
  const appInfo = await lstat(appRoot);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink() || (await lstat(path.dirname(appRoot))).isSymbolicLink()) throw new Error("Pages application must be a real directory");
  await visit("wrangler.pages.jsonc"); await visit("dist"); await visit("functions", true);
  const config = parsePagesConfig(files.find(file => file.name === "wrangler.pages.jsonc")!.bytes.toString("utf8"));
  if (!files.some(file => file.name.startsWith("dist/"))) throw new Error("build the Pages application before planning deployment");
  if (files.some(file => file.name.startsWith("functions/")) && !files.some(file => file.name === "dist/_worker.js" || file.name.startsWith("dist/_worker.js/"))) throw new Error("compile Pages Functions into dist/_worker.js without provider credentials before planning deployment");
  const digest = canonicalDigest(files.map(file => ({ name: file.name, sha256: sha256(file.bytes) })));
  return { files, digest, project: config.name, services: Object.fromEntries((config.services ?? []).map(service => [service.binding, service.service])) };
}

export function pagesHostScope(applicationId: string, environment: string, app: string): string { return `hosts:pages:${applicationId}:${environment}:${app}`; }
export function pagesOwnerScope(accountId: string, project: string): string { return `owners:pages:${accountId}:${project}`; }

/** Control-store administrator enrollment, like approver registration. This
 * writes no provider resource. A source checkout cannot enroll or retarget a
 * host merely by editing configuration; deployments only read these records. */
export async function registerPagesHost(input: { store: OperationStore; applicationId: string; environment: string; app: string; accountId: string; project: string; services: Record<string, string>; actor: string }): Promise<void> {
  if (findCredentialLeaves({ applicationId: input.applicationId, actor: input.actor, services: input.services }).length) throw new Error("Pages host enrollment must not contain credential values");
  if (!/^(?:preview|staging|production)$/u.test(input.environment) || !/^apps\/[a-z][a-z0-9-]*$/u.test(input.app) || !/^[a-f0-9]{32}$/u.test(input.accountId) || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/u.test(input.project) || !/^[A-Za-z0-9@_.-]{1,100}$/u.test(input.actor)) throw new Error("invalid Pages host enrollment identity");
  const scope = pagesHostScope(input.applicationId, input.environment, input.app);
  const target = { accountId: input.accountId, project: input.project, services: input.services };
  const owner = { applicationId: input.applicationId, environment: input.environment, app: input.app };
  const reverseScope = pagesOwnerScope(input.accountId, input.project);
  const existing = await input.store.readGeneration(scope);
  const reverse = await input.store.readGeneration(reverseScope);
  if (existing && canonicalDigest(existing.data.target) !== canonicalDigest(target)) throw new Error("Pages host is already enrolled differently; retargeting requires a separate migration review");
  if (reverse && canonicalDigest(reverse.data.owner) !== canonicalDigest(owner)) throw new Error("Pages target belongs to another application or environment");
  if (!reverse) await input.store.commitGeneration(reverseScope, 0, canonicalDigest(owner), { owner, actor: input.actor });
  if (!existing) await input.store.commitGeneration(scope, 0, canonicalDigest(target), { target, actor: input.actor });
}

export type PagesPlan = InfraPlan & { pages: { app: string; accountId: string; project: string; artifactDigest: string; commit: string; repository: string; wranglerSha256: string } };
export function planPages(input: { intent: InfrastructureIntent; binding: EnvironmentBinding; environment: InfraEnvironment; app: string; accountId: string; artifact: PagesArtifact; commit: string; repository: string; wranglerSha256: string; now: Date; fakeHost?: boolean }): PagesPlan {
  if (!/^apps\/[a-z][a-z0-9-]*$/u.test(input.app) || !/^[a-f0-9]{32}$/u.test(input.accountId) || !/^[a-f0-9]{40}$/u.test(input.commit) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) || !/^[a-f0-9]{64}$/u.test(input.wranglerSha256)) throw new Error("Pages plans require exact app/account/repository/commit/tool identities");
  const pages = { app: input.app, accountId: input.accountId, project: input.artifact.project, artifactDigest: input.artifact.digest, commit: input.commit, repository: input.repository, wranglerSha256: input.wranglerSha256 };
  const blockers = input.fakeHost ? [] : ["the new Pages host adapter requires hosted qualification; local tests do not enable real deployment"];
  const body = {
    schemaVersion: 1 as const, kind: "trestle.infra.plan" as const, environment: input.environment, sourceDigest: canonicalDigest(input.intent), toolchain: null,
    target: { trestleProjectId: input.binding.trestleProjectId, stripeAccountId: input.binding.stripeAccountId, projectsProjectId: input.binding.projectsProjectId, projectsEnvironment: input.binding.projectsEnvironment, bindingGeneration: input.binding.generation },
    pages, observedAt: null, stale: false, orphans: [], blockers, createdAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + 3_600_000).toISOString(),
    operations: [{ id: "pages-upload", resource: pages.project, classification: "configure" as const, provider: "cloudflare", service: "pages-host-deployment", target: `${pages.accountId}/${pages.project}`, dependsOn: [], effects: ["remote_host_deploy" as const, "local_state_write" as const], capability: { operation: "deploy" as const, evidence: "locally_tested" as const, allowed: blockers.length === 0, reasons: blockers }, cost: { kind: "unknown" as const, recurring: false, accountWide: false, requiresAuthorization: true, notes: ["deploys to an existing Pages project only; no plan upgrade or resource creation", "Functions usage follows the existing Cloudflare account plan; no spend cap is implied"] }, deletionPolicy: "retain" as const, credentialOutputs: [], preconditions: ["registered approval bound to exact artifact and host", "existing project in the exact Cloudflare account", "clean exact Git revision; production requires successful push/main deploy.yml for this SHA"], timeoutSeconds: 300, recovery: "verify the operation marker; never upload again after an uncertain response", blockers }],
  };
  if (findCredentialLeaves(body).length) throw new Error("Pages plan identities must not contain credential values");
  return { ...body, digest: canonicalDigest(body) };
}

export type PagesHost = {
  /** Must check account authorization, project presence, exact clean Git
   * revision and fresh staging evidence before any upload. */
  preflight(plan: PagesPlan): Promise<void>;
  upload(directory: string, plan: PagesPlan): Promise<{ deploymentId: string; url: string } | void>;
  marker(plan: PagesPlan): Promise<{ operationId: string; artifactDigest: string } | null>;
};

/** Uses the same durable signed authority as provisioning. Upload ambiguity
 * never becomes permission for a second deployment. No Projects CLI is needed. */
export async function applyPages(input: { plan: PagesPlan; approval: SignedApproval; intent: InfrastructureIntent; binding: EnvironmentBinding; artifact: PagesArtifact }, deps: { store: OperationStore; host: PagesHost; now: () => Date; simulation?: boolean }): Promise<ApplyResult> {
  const { plan, approval } = input;
  const id = approval.payload.operationId;
  const result = (outcome: Outcome, nextStep: string | null): ApplyResult => ({ outcome, operationId: id, messages: [], completed: outcome === "succeeded" ? [plan.pages.project] : [], unresolved: outcome === "succeeded" ? [] : [plan.pages.project], nextStep });
  if (canonicalDigest(input.artifact.files.map(file => ({ name: file.name, sha256: sha256(file.bytes) }))) !== input.artifact.digest) return result("blocked", "Pages artifact bytes changed after snapshotting");
  let config: z.infer<typeof configSchema>;
  try { config = parsePagesConfig(input.artifact.files.find(file => file.name === "wrangler.pages.jsonc")?.bytes.toString("utf8") ?? "null"); } catch { return result("blocked", "invalid Pages configuration"); }
  if (config.name !== input.artifact.project || canonicalDigest(Object.fromEntries((config.services ?? []).map(service => [service.binding, service.service]))) !== canonicalDigest(input.artifact.services)) return result("blocked", "Pages config identity differs from artifact metadata");
  if (deps.store.kind !== "postgres" && !deps.simulation) return result("blocked", "Pages deployment requires the independent control store");
  const host = await deps.store.readGeneration(pagesHostScope(input.binding.trestleProjectId, plan.environment, plan.pages.app));
  const owner = await deps.store.readGeneration(pagesOwnerScope(plan.pages.accountId, plan.pages.project));
  if (!host || !owner || canonicalDigest(host.data.target) !== canonicalDigest({ accountId: plan.pages.accountId, project: plan.pages.project, services: input.artifact.services }) || canonicalDigest(owner.data.owner) !== canonicalDigest({ applicationId: input.binding.trestleProjectId, environment: plan.environment, app: plan.pages.app })) return result("blocked", "Pages host and service bindings must match protected administrator enrollment for this environment");
  if (!verifyPlanDigest(plan) || plan.sourceDigest !== canonicalDigest(input.intent) || plan.pages.artifactDigest !== input.artifact.digest || approval.payload.artifactDigest !== input.artifact.digest || Date.parse(plan.expiresAt) <= deps.now().getTime()) return result("blocked", "Pages source, artifact, approval or expiry does not match");
  const rebuilt = planPages({ intent: input.intent, binding: input.binding, environment: plan.environment, ...plan.pages, artifact: input.artifact, now: new Date(plan.createdAt), ...(deps.simulation ? { fakeHost: true } : {}) });
  if (rebuilt.digest !== plan.digest || plan.blockers.length) return result("blocked", "Pages target, binding or qualification changed since review");
  const coverage = approvalCovers(approval, plan, plan.operations[0]!.effects, deps.now());
  if (coverage.length) return result("blocked", coverage.join("; "));
  try { await deps.store.recordApproval(approval, deps.now()); } catch { return result("blocked", "Pages approval rejected"); }
  const consumed = await deps.store.consumeApproval(approval.payload.approvalId, id, plan.digest, deps.now());
  if (consumed.status === "rejected") return result("blocked", consumed.reason);
  const existing = await deps.store.getOperation(id);
  if (existing && existing.planDigest !== plan.digest) return result("blocked", "operation belongs to another deployment");
  if (existing?.state === "succeeded") return result("succeeded", null);
  try { await deps.host.preflight(plan); } catch { return result("blocked", "Pages account/project/revision/staging preflight failed"); }
  if (!existing) await deps.store.createOperation({ id, environment: plan.environment, planDigest: plan.digest, approvalId: approval.payload.approvalId, state: "running" }, deps.now());
  const scope = `pages:${plan.pages.accountId}:${plan.pages.project}`;
  const reserved = await deps.store.reserve(scope, id, `pages-${randomUUID()}`, 600_000, deps.now());
  if (reserved.status === "busy") return result("failed_retryable", "another Pages operation holds the target");
  if (reserved.status === "uncertain" && reserved.reservation.operationId !== id) return result("outcome_unknown", "the preceding Pages upload is uncertain; reconcile it first");
  const started = (await deps.store.events(id)).some(event => event.kind === "infra.pages.intent");
  if (!started) {
    if (reserved.status !== "acquired") return result("outcome_unknown", "Pages reservation is uncertain");
    const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-pages-upload-"));
    try {
      for (const file of input.artifact.files) {
        if (file.name.split("/").some(part => part === ".." || part === "") || !/^(?:dist\/|functions\/|wrangler\.pages\.jsonc$)/u.test(file.name)) throw new Error("unconfined Pages artifact path");
        if (file.name.startsWith("functions/")) continue; // provenance only; never compile source with deploy credentials
        const target = path.join(directory, file.name === "wrangler.pages.jsonc" ? "wrangler.jsonc" : file.name);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
      }
      await mkdir(path.join(directory, "dist/.well-known"), { recursive: true });
      await writeFile(path.join(directory, "dist/.well-known/trestle-release.json"), JSON.stringify({ operationId: id, artifactDigest: input.artifact.digest }), { flag: "wx" });
      await deps.store.beginEffect(scope, reserved.reservation.fencingToken, `${id}:upload`, deps.now());
      await deps.store.appendEvent(id, "infra.pages.intent", { accountId: plan.pages.accountId, project: plan.pages.project, artifactDigest: input.artifact.digest }, deps.now());
      try {
        const receipt = await deps.host.upload(directory, plan);
        if (receipt) await deps.store.appendEvent(id, "infra.pages.receipt", receipt, deps.now());
      } catch (error) {
        await deps.store.appendEvent(id, "infra.pages.result", { status: "unknown", reason: safeInfraDiagnostic(error) }, deps.now());
      }
      await deps.store.markUncertain(scope, reserved.reservation.fencingToken, deps.now());
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const marker = await deps.host.marker(plan).catch(() => null);
  if (marker?.operationId !== id || marker.artifactDigest !== input.artifact.digest) {
    await deps.store.setOperationState(id, "outcome_unknown", deps.now());
    return result("outcome_unknown", "the exact Pages artifact is not observed; resume verification without uploading again");
  }
  await deps.store.appendEvent(id, "infra.pages.artifact_verified", { artifactDigest: marker.artifactDigest, project: plan.pages.project }, deps.now());
  await deps.store.reconcile(scope, `observed Pages operation marker ${id}`, id, deps.now());
  await deps.store.setOperationState(id, "succeeded", deps.now());
  return result("succeeded", "artifact delivery verified; API, database, auth, browser and clinical readiness remain separate");
}
