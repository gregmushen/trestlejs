import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";

import { projectContext } from "../context.js";
import { environmentNameSchema } from "../manifest.js";
import { CliFailure, type CliRuntime } from "../runtime.js";
import { structuredOutput } from "../structured-output.js";
import { defaultToolchainLocation, StripeProjectsAdapter, verifyToolchain, type ToolchainCheck } from "./adapters/stripe-projects.js";
import { resolveCapability, SUPPORTED_TOOLCHAIN } from "./capabilities.js";
import { PROJECTS_CAPABILITIES } from "./capability-matrix.js";
import { formatDoctor, runInfraDoctor } from "./doctor.js";
import { DASHBOARD_URLS } from "./endpoints.js";
import { planInfrastructure, planIsExecutable, type InfraPlan } from "./planner.js";
import { nodeProcessRunner, type ProcessRunner } from "./process.js";
import { INFRA_PATHS, readInfrastructure, type InfraEnvironment } from "./schema.js";
import { approvalFor, generateApproverKeys, signApproval, type SignedApproval } from "./approvals.js";
import { applyPlan, OUTCOME_EXIT, type ApplyResult } from "./runner.js";
import { resolveMasterKey } from "../secrets.js";
import { projectsWorkspace } from "./doctor.js";

/** Test seams; production uses the real process runner and clock. */
export type InfraRuntime = Readonly<{ runner?: ProcessRunner; now?: () => Date }>;

function remoteEnvironment(value: string): InfraEnvironment {
  const parsed = environmentNameSchema.safeParse(value);
  if (!parsed.success || parsed.data === "local") throw new InvalidArgumentError("expected preview, staging, or production");
  return parsed.data;
}

const INTENT_TEMPLATE = `# Infrastructure intent for trestle infra (Stripe Projects backend).
# Desired configuration only: never put secret values here.
# Resources and credential bindings are added per environment; see
# docs/STRIPE_PROJECTS_PROVISIONING_SPEC.md section 10.
schemaVersion: 1
backend: stripe-projects
environments: {}
`;

/** Mutation commands stay registered but unavailable until their gates pass. */
const PENDING: ReadonlyArray<[name: string, args: string, description: string, gate: string]> = [
  ["link", "<provider>", "link a provider account to the Projects project for an environment", "approval authority and durable control state (P04) are not enabled"],
  ["adopt", "<resource>", "plan association with an existing exact resource identity", "Projects reports existing-resource linking unsupported for Neon, Cloudflare and Resend"],
  ["rotate", "<credential-binding>", "plan a provider credential rotation", "rotation invalidation and response-loss recovery are unknown (D-05)"],
  ["upgrade", "<resource>", "plan a reviewed tier change", "tier changes require cost authorization and hosted evidence"],
  ["detach", "<resource>", "plan association removal while retaining the resource", "no non-destructive detach is proven"],
  ["destroy", "<resource>", "plan destructive removal with explicit safeguards", "exact-ID deletion is not proven (P13)"],
];

export function registerInfraCommands(infra: Command, runtime: CliRuntime & { infra?: InfraRuntime }): void {
  const runner = () => runtime.infra?.runner ?? nodeProcessRunner;
  const now = () => runtime.infra?.now?.() ?? new Date();
  const environmentOf = (name: string) => runtime.environment?.(name) ?? process.env[name];
  const toolchain = async (): Promise<{ check: ToolchainCheck; adapter?: StripeProjectsAdapter }> => {
    const location = defaultToolchainLocation(environmentOf);
    // An operator-supplied plugin hash makes reads possible against another build,
    // but capability rows stay pinned to the qualified hash, so nothing becomes mutable.
    const overrideHash = environmentOf("TRESTLE_PROJECTS_PLUGIN_SHA256");
    const expected = overrideHash && /^[a-f0-9]{64}$/u.test(overrideHash) ? { ...SUPPORTED_TOOLCHAIN, pluginSha256: overrideHash } : SUPPORTED_TOOLCHAIN;
    const check = await verifyToolchain(location, runner(), expected);
    return check.ok ? { check, adapter: new StripeProjectsAdapter(check.toolchain, location, runner()) } : { check };
  };

  const controlStore = async () => {
    const url = environmentOf("TRESTLE_INFRA_CONTROL_DATABASE_URL");
    if (!url) throw new CliFailure("remote mutation requires TRESTLE_INFRA_CONTROL_DATABASE_URL naming an independent PostgreSQL control store; local files are never used as the journal", 2);
    const { PostgresOperationStore } = await import("./stores/postgres.js");
    return PostgresOperationStore.connect(url);
  };

  const execute = async (root: string, environment: InfraEnvironment, planFile: string, approvalFile: string, operationId?: string, confirmAbsent?: { actor: string; reason: string }): Promise<ApplyResult> => {
    if (!environmentOf("TRESTLE_INFRA_CONTROL_DATABASE_URL")) await controlStore();
    const plan = JSON.parse(await readFile(path.resolve(root, planFile), "utf8")) as InfraPlan;
    const approval = JSON.parse(await readFile(path.resolve(root, approvalFile), "utf8")) as SignedApproval;
    if (operationId && approval.payload.operationId !== operationId) throw new CliFailure(`approval is for ${approval.payload.operationId}, not ${operationId}`);
    if (plan.environment !== environment) throw new CliFailure(`plan is for ${plan.environment}, not ${environment}`);
    const { intent, bindings } = await readInfrastructure(root);
    const { check, adapter } = await toolchain();
    if (!adapter) throw new CliFailure(`Projects toolchain is not qualified: ${check.ok ? "" : check.reasons.join("; ")}`, 2);
    const workspace = projectsWorkspace(root, environment);
    if (!(await stat(path.join(workspace, ".projects")).then(() => true, () => false))) throw new CliFailure(`${environment} has no linked Projects workspace; link the environment before applying`, 2);
    const masterKey = await resolveMasterKey(root, environment, environmentOf("TRESTLE_MASTER_KEY"));
    const store = await controlStore();
    try {
      return await applyPlan({ plan, approval, intent, bindings }, { store, adapter, workspace, projectRoot: root, masterKey, now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ...(confirmAbsent ? { confirmAbsent } : {}) });
    } finally {
      await store.close();
    }
  };

  const report = (result: ApplyResult) => {
    runtime.stdout(`${JSON.stringify(structuredOutput(result), null, 2)}\n`);
    if (result.outcome !== "succeeded") throw new CliFailure(`operation ${result.operationId}: ${result.outcome}${result.nextStep ? ` — ${result.nextStep}` : ""}`, OUTCOME_EXIT[result.outcome]);
  };

  infra.command("init")
    .description("write local infrastructure configuration; creates no remote resources and makes no purchases")
    .requiredOption("--backend <backend>", "provisioning backend (stripe-projects)")
    .action(async (options: { backend: string }, command: Command) => {
      if (options.backend !== "stripe-projects") throw new CliFailure("the only supported backend is stripe-projects");
      const context = await projectContext(command, runtime);
      const intentPath = path.join(context.root, INFRA_PATHS.intent);
      const existing = await readFile(intentPath, "utf8").catch(() => undefined);
      if (existing !== undefined) throw new CliFailure(`${INFRA_PATHS.intent} already exists; edit it instead of reinitializing`);
      await mkdir(path.dirname(intentPath), { recursive: true });
      await writeFile(intentPath, INTENT_TEMPLATE, { flag: "wx" });
      await writeFile(path.join(context.root, INFRA_PATHS.bindings), `${JSON.stringify({ schemaVersion: 1, environments: {} }, null, 2)}\n`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const gitignore = path.join(context.root, ".gitignore");
      const ignored = await readFile(gitignore, "utf8").catch(() => "");
      const entry = `${INFRA_PATHS.local.split(path.sep).join("/")}/`;
      if (!ignored.split(/\r?\n/u).includes(entry)) await appendFile(gitignore, `${ignored === "" || ignored.endsWith("\n") ? "" : "\n"}${entry}\n`);
      runtime.stdout(`Initialized Stripe Projects infrastructure configuration\n  intent   ${INFRA_PATHS.intent}\n  bindings ${INFRA_PATHS.bindings}\n  ignored  ${entry}\nNo remote resources were created.\n`);
    });

  infra.command("catalog")
    .description("show recorded Projects capability evidence per service and operation; --live also reads the current catalog")
    .argument("[provider]")
    .option("--live", "read the provider catalog through the qualified Projects CLI (read-only, isolated directory)")
    .option("--json", "emit versioned structured output")
    .action(async (provider: string | undefined, options: { live?: boolean; json?: boolean }) => {
      const { check, adapter } = await toolchain();
      const rows = PROJECTS_CAPABILITIES.filter((row) => !provider || row.provider === provider).map((row) => {
        const resolved = resolveCapability(row, check.ok ? check.toolchain : undefined, now());
        return { provider: row.provider, service: row.service, operation: row.operation, evidence: resolved.evidence, allowed: resolved.allowed, reasons: resolved.reasons, limitations: row.limitations };
      });
      if (provider && rows.length === 0) throw new CliFailure(`no recorded capabilities for ${provider}`);
      let live: unknown = null;
      if (options.live) {
        if (!provider) throw new CliFailure("--live requires a provider");
        if (!adapter) throw new CliFailure(`Projects toolchain is not qualified: ${check.ok ? "" : check.reasons.join("; ")}`);
        const result = await adapter.catalog(provider);
        if (result.status !== "ok") throw new CliFailure(`live catalog read failed: ${result.status === "failure" ? result.reason : `${result.code}: ${result.message}`}`);
        live = result.data;
      }
      if (options.json) {
        runtime.stdout(`${JSON.stringify(structuredOutput({ toolchain: check.ok ? { pluginVersion: check.toolchain.pluginVersion, qualified: check.toolchain.pluginSha256 === SUPPORTED_TOOLCHAIN.pluginSha256 } : { unavailable: check.reasons }, capabilities: rows, live }), null, 2)}\n`);
        return;
      }
      const lines = rows.map((row) => `${row.allowed ? "✓" : "✗"} ${row.provider}/${row.service} ${row.operation}: ${row.evidence}${row.allowed ? "" : ` — ${row.reasons[0] ?? "not enabled"}`}`);
      if (!check.ok) lines.unshift(`? toolchain: ${check.reasons.join("; ")}`);
      if (live) lines.push("", `Live catalog for ${provider}:`, ...(live as { services: Array<{ serviceId: string; kind: string; pricing: string }> }).services.map((service) => `  ${service.serviceId} (${service.kind}, ${service.pricing})`));
      runtime.stdout(`${lines.join("\n")}\n`);
    });

  infra.command("plan")
    .description("produce a secret-free, digest-bound infrastructure plan; never provisions, rotates or pulls credentials")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: InfraEnvironment; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const { intent, bindings } = await readInfrastructure(context.root);
      const { check } = await toolchain();
      const plan = planInfrastructure({ intent, bindings, environment: options.env, ...(check.ok ? { toolchain: check.toolchain } : {}), now: now() });
      const plans = path.join(context.root, INFRA_PATHS.local, "plans");
      await mkdir(plans, { recursive: true, mode: 0o700 });
      const file = path.join(plans, `${plan.digest.replace("sha256:", "")}.json`);
      await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
      if (options.json) runtime.stdout(`${JSON.stringify(structuredOutput({ plan, executable: planIsExecutable(plan), file: path.relative(context.root, file) }), null, 2)}\n`);
      else runtime.stdout(formatPlan(plan, path.relative(context.root, file)));
    });

  infra.command("status")
    .description("show bindings, toolchain qualification, orphans and unresolved operations without contacting providers for writes")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: InfraEnvironment; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const { intent, bindings } = await readInfrastructure(context.root);
      const { check } = await toolchain();
      const binding = bindings.environments[options.env] ?? null;
      const plan = intent.environments[options.env] ? planInfrastructure({ intent, bindings, environment: options.env, ...(check.ok ? { toolchain: check.toolchain } : {}), now: now() }) : null;
      const summary = {
        environment: options.env,
        toolchain: check.ok ? { qualified: true, pluginVersion: check.toolchain.pluginVersion } : { qualified: false, reasons: check.reasons },
        binding: binding ? { stripeAccountId: binding.stripeAccountId, projectsProjectId: binding.projectsProjectId, projectsEnvironment: binding.projectsEnvironment, generation: binding.generation, resources: Object.fromEntries(Object.entries(binding.resources).map(([name, resource]) => [name, { provider: resource.provider, service: resource.service, externalId: resource.externalId, lifecycleOwner: resource.lifecycleOwner }])) } : null,
        observed: "not_observed",
        orphans: plan?.orphans ?? [],
        declared: plan?.operations.map((operation) => ({ resource: operation.resource, classification: operation.classification })) ?? [],
      };
      if (options.json) { runtime.stdout(`${JSON.stringify(structuredOutput(summary), null, 2)}\n`); return; }
      runtime.stdout([
        `Environment ${options.env}`,
        `  toolchain: ${check.ok ? `qualified (plugin ${check.toolchain.pluginVersion})` : `unavailable — ${check.reasons.join("; ")}`}`,
        `  binding:   ${binding ? `${binding.stripeAccountId} / ${binding.projectsProjectId} (${binding.projectsEnvironment}), generation ${binding.generation}` : "none (unlinked)"}`,
        "  observed:  not observed (remote state is unknown, not empty)",
        ...summary.declared.map((entry) => `  ${entry.resource}: ${entry.classification}`),
        ...(summary.orphans.length ? [`  orphans:   ${summary.orphans.join(", ")} (reported only)`] : []),
        "",
      ].join("\n"));
    });

  infra.command("doctor")
    .description("read-only infrastructure readiness checks; never repairs, pulls secrets, sends email, charges or rotates")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .option("--json", "emit versioned structured output")
    .action(async (options: { env: InfraEnvironment; json?: boolean }, command: Command) => {
      const context = await projectContext(command, runtime);
      const { intent, bindings } = await readInfrastructure(context.root);
      const { check, adapter } = await toolchain();
      const checks = await runInfraDoctor({ root: context.root, environment: options.env, intent, bindings, toolchain: check, ...(adapter ? { adapter } : {}), now: now() });
      const failed = checks.filter((entry) => entry.status === "fail");
      if (options.json) runtime.stdout(`${JSON.stringify(structuredOutput({ environment: options.env, ok: failed.length === 0, checks }), null, 2)}\n`);
      else runtime.stdout(formatDoctor(checks));
      if (failed.length > 0) throw new CliFailure(`${failed.length} infrastructure check(s) failed for ${options.env}`);
    });

  infra.command("open")
    .description("print an allowlisted provider dashboard URL; never follows provider-supplied links")
    .argument("<provider>")
    .action((provider: string) => {
      const url = DASHBOARD_URLS[provider];
      if (!url) throw new CliFailure(`no allowlisted dashboard for ${provider}; known: ${Object.keys(DASHBOARD_URLS).join(", ")}`);
      runtime.stdout(`${url}\n`);
    });

  const operation = infra.command("operation").description("inspect infrastructure operation records");
  operation.command("show")
    .description("show sanitized checkpoints and recovery requirements for an operation")
    .argument("<id>")
    .action(async (id: string, _options: unknown, command: Command) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id)) throw new CliFailure("operation IDs are alphanumeric");
      const context = await projectContext(command, runtime);
      const record = await readFile(path.join(context.root, INFRA_PATHS.local, "operations", `${id}.json`), "utf8").catch(() => undefined);
      if (!record) throw new CliFailure(`no operation record ${id}`);
      runtime.stdout(record.endsWith("\n") ? record : `${record}\n`);
    });
  operation.command("resume")
    .description("resume an operation from its journal: reconcile uncertain steps by observation, never repeat committed effects")
    .argument("<id>")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .requiredOption("--plan <file>", "the plan the operation was approved for")
    .requiredOption("--approval <file>", "the original approval, or a renewal for the same operation")
    .option("--confirm-absent <reason>", "assert, as the recorded operator, that no earlier request for an uncertain target can still complete")
    .option("--actor <name>", "operator name recorded with --confirm-absent")
    .action(async (id: string, options: { env: InfraEnvironment; plan: string; approval: string; confirmAbsent?: string; actor?: string }, command: Command) => {
      const context = await projectContext(command, runtime);
      if (options.confirmAbsent && !options.actor) throw new CliFailure("--confirm-absent requires --actor");
      const result = await execute(context.root, options.env, options.plan, options.approval, id, options.confirmAbsent ? { actor: options.actor!, reason: options.confirmAbsent } : undefined);
      report(result);
    });

  infra.command("apply")
    .description("execute an approved plan with fresh preconditions; requires an independent PostgreSQL control store")
    .argument("<plan-file>")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .requiredOption("--approval <file>", "signed approval for this plan and operation")
    .action(async (planFile: string, options: { env: InfraEnvironment; approval: string }, command: Command) => {
      const context = await projectContext(command, runtime);
      report(await execute(context.root, options.env, planFile, options.approval));
    });

  infra.command("approve")
    .description("sign an approval for one plan and operation with an approver key kept outside the repository")
    .argument("<plan-file>")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .requiredOption("--approver <id>", "approver ID registered in the control store")
    .requiredOption("--key <file>", "Ed25519 private key (PEM, mode 0600, outside the project)")
    .option("--operation-id <id>", "operation ID to bind (default: new)")
    .option("--artifact-digest <digest>", "immutable artifact digest to bind")
    .action(async (planFile: string, options: { env: InfraEnvironment; approver: string; key: string; operationId?: string; artifactDigest?: string }, command: Command) => {
      const context = await projectContext(command, runtime);
      const plan = JSON.parse(await readFile(path.resolve(context.root, planFile), "utf8")) as InfraPlan;
      if (plan.environment !== options.env) throw new CliFailure(`plan is for ${plan.environment}, not ${options.env}`);
      const keyPath = path.resolve(runtime.cwd(), options.key);
      if (!path.relative(context.root, keyPath).startsWith("..")) throw new CliFailure("approver keys must live outside the project directory");
      const info = await stat(keyPath).catch(() => { throw new CliFailure("approver key not found"); });
      if ((info.mode & 0o077) !== 0) throw new CliFailure("approver key must not be readable by group or others (chmod 600)");
      const operationId = options.operationId ?? `op-${randomUUID()}`;
      if (!/^op-[A-Za-z0-9-]{1,80}$/u.test(operationId)) throw new CliFailure("operation IDs look like op-<id>");
      const approval = signApproval(approvalFor(plan, { operationId, approverId: options.approver, now: now(), ...(options.artifactDigest ? { artifactDigest: options.artifactDigest } : {}) }), await readFile(keyPath, "utf8"));
      const directory = path.join(context.root, INFRA_PATHS.local, "approvals");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${operationId}.json`);
      await writeFile(file, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      runtime.stdout(`Signed approval ${approval.payload.approvalId} for ${operationId}\n  plan     ${plan.digest}\n  effects  ${approval.payload.allowedEffects.join(", ") || "none"}\n  expires  ${approval.payload.expiresAt}\n  saved    ${path.relative(context.root, file)}\n`);
    });

  const approver = infra.command("approver").description("manage infrastructure approvers");
  approver.command("keygen")
    .description("create an Ed25519 approver key pair outside the project")
    .requiredOption("--out <file>", "private key path (public key is written beside it with .pub)")
    .action(async (options: { out: string }) => {
      const out = path.resolve(runtime.cwd(), options.out);
      const keys = generateApproverKeys();
      await mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
      await writeFile(out, keys.privateKeyPem, { mode: 0o600, flag: "wx" });
      await writeFile(`${out}.pub`, keys.publicKeyPem, { mode: 0o644, flag: "wx" });
      runtime.stdout(`Wrote ${out} (private, 0600) and ${out}.pub\nRegister the public key with: trestle infra approver register <id> --public-key ${out}.pub --env <environment>\n`);
    });
  approver.command("register")
    .description("register an approver public key in the control store (control-store administrators only)")
    .argument("<id>")
    .requiredOption("--public-key <file>", "PEM public key")
    .option("--env <environment>", "an environment this approver may approve (repeatable)", (value: string, previous: string[]) => [...previous, remoteEnvironment(value)], [] as string[])
    .action(async (id: string, options: { publicKey: string; env: string[] }) => {
      if (options.env.length === 0) throw new CliFailure("name at least one --env <environment>");
      const store = await controlStore();
      try {
        await store.registerApprover(id, await readFile(path.resolve(runtime.cwd(), options.publicKey), "utf8"), options.env, now());
        runtime.stdout(`Registered approver ${id} for ${options.env.join(", ")}\n`);
      } finally {
        await store.close();
      }
    });

  const credentials = infra.command("credentials").description("Projects-managed credential import");
  credentials.command("pull")
    .description("import validated declared credentials; never rotates provider keys")
    .requiredOption("--env <environment>", "target environment", remoteEnvironment)
    .action(() => { throw new CliFailure("trestle infra credentials pull is not available yet: credential generations and concurrent-edit coordination (P05/P06) are not enabled", 2); });

  for (const [name, args, description, gate] of PENDING) {
    infra.command(name)
      .description(`[unavailable] ${description}`)
      .argument(args)
      .requiredOption("--env <environment>", "target environment", remoteEnvironment)
      .action(() => { throw new CliFailure(`trestle infra ${name} is not available yet: ${gate}`, 2); });
  }
}

function formatPlan(plan: InfraPlan, file: string): string {
  const lines = [
    `Infrastructure plan for ${plan.environment} (${plan.digest.slice(0, 19)}…)`,
    `  observed:   ${plan.stale ? "stale — no live observation; apply would refresh and reject drift" : plan.observedAt}`,
    `  expires:    ${plan.expiresAt}`,
  ];
  for (const operation of plan.operations) {
    lines.push(`  ${operation.classification.padEnd(9)} ${operation.resource} (${operation.provider}/${operation.service}${operation.plan ? ` plan ${operation.plan}` : ""}) → ${operation.target}`);
    lines.push(`             cost ${operation.cost.kind}${operation.cost.accountWide ? ", account-wide" : ""}; evidence ${operation.capability.evidence}`);
    for (const blocker of operation.blockers) lines.push(`             blocked: ${blocker}`);
  }
  for (const orphan of plan.orphans) lines.push(`  orphan    ${orphan} (reported only; never deleted by planning)`);
  for (const blocker of plan.blockers) lines.push(`  blocked: ${blocker}`);
  lines.push(`  executable: ${planIsExecutable(plan) ? "yes" : "no"}`, `  saved:      ${file}`, "");
  return lines.join("\n");
}
