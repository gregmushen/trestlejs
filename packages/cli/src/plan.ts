import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parseSetupPlan, projectManifestSchema, structuredOutput, type ProjectManifest, type SetupPlan, TRESTLEJS_VERSION } from "@trestlejs/core";
import { parseDocument } from "yaml";

import { generateResource, generateResourceMigration } from "./generate-resource.js";
import { CliFailure, type CliRuntime } from "./runtime.js";

export type PlanClassification = "already correct" | "create" | "update" | "delete" | "blocked" | "unknown";
export type PlanDiffItem = { id: string; classification: PlanClassification; summary: string };
export type PlanDiff = { planHash: string; items: PlanDiffItem[]; converged: boolean };

type ParsedVersion = { release: [number, number, number]; prerelease: string[] };

function versionParts(version: string): ParsedVersion {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u);
  if (!match) return { release: [0, 0, 0], prerelease: [] };
  return { release: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index]! !== b.release[index]!) return a.release[index]! > b.release[index]!;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return a.prerelease.length === 0;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return right === undefined;
    if (left === right) continue;
    const leftNumber = /^\d+$/u.test(left) ? Number(left) : undefined;
    const rightNumber = /^\d+$/u.test(right) ? Number(right) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber;
    if (leftNumber !== undefined || rightNumber !== undefined) return rightNumber !== undefined;
    return left > right;
  }
  return true;
}

export async function readSetupPlan(root: string, file: string, runtime: CliRuntime): Promise<{ plan: SetupPlan; input: string; source: string }> {
  const source = file === "-" ? "stdin" : path.resolve(root, file);
  const input = file === "-"
    ? await runtime.stdin?.() ?? (() => { throw new CliFailure("reading a SetupPlan from stdin is not available"); })()
    : await readFile(source, "utf8").catch((error) => { throw new CliFailure(`Unable to read SetupPlan ${source}: ${error instanceof Error ? error.message : String(error)}`); });
  try {
    const plan = parseSetupPlan(input);
    if (!versionAtLeast(TRESTLEJS_VERSION, plan.minimumTrestleVersion)) {
      throw new CliFailure(`SetupPlan requires TrestleJS ${plan.minimumTrestleVersion} or newer; installed ${TRESTLEJS_VERSION}`);
    }
    return { plan, input, source };
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    const issues = error instanceof Error && "issues" in error && Array.isArray(error.issues)
      ? error.issues.map((issue: { path?: PropertyKey[]; message?: string }) => `${issue.path?.join(".") || "plan"}: ${issue.message ?? "invalid"}`).join("; ")
      : error instanceof Error ? error.message : String(error);
    throw new CliFailure(issues);
  }
}

function planHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

type ResourceState = {
  tenant?: boolean;
  crud?: boolean;
  persistence?: { table?: string };
  files?: string[];
  registrations?: string[];
};

async function declaration(root: string, name: string): Promise<ResourceState | undefined> {
  const kebab = name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
  try { return JSON.parse(await readFile(path.join(root, ".trestle", "resources", `${kebab}.json`), "utf8")) as ResourceState; }
  catch { return undefined; }
}

async function hasMigration(root: string, manifest: ProjectManifest, state: ResourceState): Promise<boolean> {
  const table = state.persistence?.table;
  if (!table) return false;
  try {
    const dbPath = manifest.packages.db ?? "packages/db";
    await access(path.join(root, dbPath, "package.json"));
    const directory = path.join(root, dbPath, "migrations");
    const sql = (await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".sql")).map((file) => readFile(path.join(directory, file), "utf8")))).join("\n");
    return sql.includes(`CREATE TABLE "${table}"`) && sql.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && !manifest.packages.db) return true;
    return false;
  }
}

function resourceNames(name: string): { camel: string; kebab: string; pluralKebab: string } {
  const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(" ").map((word) => word.toLowerCase());
  const kebab = words.join("-");
  return {
    camel: `${words[0]}${words.slice(1).map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`).join("")}`,
    kebab,
    pluralKebab: kebab.endsWith("s") ? `${kebab}es` : `${kebab}s`,
  };
}

async function resourceArtifactsComplete(root: string, manifest: ProjectManifest, name: string, state: ResourceState): Promise<boolean> {
  const resource = resourceNames(name);
  const contractsPath = manifest.packages.contracts ?? "packages/contracts";
  const domainPath = manifest.packages.domain ?? "packages/domain";
  const dataPath = manifest.packages.data ?? "packages/data";
  const dbPath = manifest.packages.db ?? "packages/db";
  const workerPath = manifest.apps.worker ?? "apps/worker";
  const appPath = manifest.apps.app ?? "apps/app";
  const expectedFiles = state.files ?? [
    path.join(contractsPath, "src", "resources", `${resource.kebab}.ts`),
    path.join(domainPath, "src", "resources", `${resource.kebab}.ts`),
    path.join(dataPath, "src", "resources", `${resource.kebab}-repository.ts`),
    path.join(dbPath, "src", `${resource.kebab}-schema.ts`),
    path.join(workerPath, "src", "resources", `${resource.kebab}-routes.ts`),
    path.join(appPath, "src", "resources", `${resource.kebab}.tsx`),
    path.join(contractsPath, "src", "resources", `${resource.kebab}.test.ts`),
    path.join(dbPath, "src", `${resource.kebab}-rls.integration.test.ts`),
  ];
  if ((await Promise.all(expectedFiles.map((file) => access(path.join(root, file)).then(() => true, () => false)))).some((present) => !present)) return false;
  try {
    const [contracts, domain, data, database, worker, app] = await Promise.all([
      readFile(path.join(root, contractsPath, "src", "index.ts"), "utf8"),
      readFile(path.join(root, domainPath, "src", "index.ts"), "utf8"),
      readFile(path.join(root, dataPath, "src", "index.ts"), "utf8"),
      readFile(path.join(root, dbPath, "src", "index.ts"), "utf8"),
      readFile(path.join(root, workerPath, "src", "index.ts"), "utf8"),
      readFile(path.join(root, appPath, "src", "main.tsx"), "utf8"),
    ]);
    return contracts.includes(`./resources/${resource.kebab}.js`)
      && domain.includes(`./resources/${resource.kebab}.js`)
      && data.includes(`./resources/${resource.kebab}-repository.js`)
      && database.includes(`./${resource.kebab}-schema.js`)
      && worker.includes(`./resources/${resource.kebab}-routes.js`)
      && worker.includes(`app.route("/", ${resource.camel}Routes);`)
      && app.includes(`./resources/${resource.kebab}.js`)
      && app.includes(`path: "/${resource.pluralKebab}"`);
  } catch {
    return false;
  }
}

export async function diffSetupPlan(root: string, manifest: ProjectManifest, plan: SetupPlan, input: string): Promise<PlanDiff> {
  const items: PlanDiffItem[] = [];
  const compare = (id: string, actual: unknown, expected: unknown, summary: string) => items.push({ id, classification: JSON.stringify(actual) === JSON.stringify(expected) ? "already correct" : "update", summary });
  compare("project.name", manifest.project.name, plan.project.name, `project name is ${plan.project.name}`);
  for (const [name, expected] of Object.entries(plan.apps)) {
    const present = Boolean(manifest.apps[name]);
    items.push({ id: `apps.${name}`, classification: present === expected ? "already correct" : expected ? "blocked" : "delete", summary: `${name} application ${expected ? "enabled" : "disabled"}` });
  }
  compare("tenancy", manifest.tenancy, plan.tenancy, "organization tenancy uses forced PostgreSQL RLS");
  compare("database", { engine: manifest.database.engine, provider: manifest.database.defaultProvider }, plan.database, `${plan.database.provider} ${plan.database.engine} database`);
  compare("capabilities", manifest.capabilities, plan.capabilities, "declared Cloudflare capabilities match");
  compare("integrations", { email: Boolean(manifest.packages.integrations), billing: Boolean(manifest.packages.billing) }, plan.integrations, "declared application integrations match");
  if (plan.providers) compare("providers", manifest.integrations, plan.providers, `email ${plan.providers.email}; payments ${plan.providers.payments}; metering ${plan.providers.metering ?? "native"}; webhooks ${plan.providers.webhooks ?? "native"}`);
  if (plan.authentication) compare("authentication", manifest.authentication, plan.authentication, `passkeys ${plan.authentication.passkeys}; two-factor ${plan.authentication.twoFactor}`);
  if (plan.identity) compare("identity", manifest.identity, plan.identity, `SSO ${plan.identity.sso}; directory ${plan.identity.directory}`);
  if (plan.access) compare("access", manifest.access, plan.access, `custom roles ${plan.access.customRoles}; service accounts ${plan.access.serviceAccounts}; API keys ${plan.access.apiKeys}`);
  if (plan.commercial) compare("commercial", manifest.commercial, plan.commercial, `plans ${plan.commercial.plans}; usage ${plan.commercial.usage}`);
  if (plan.communications) compare("communications", manifest.communications, plan.communications, `webhooks ${plan.communications.webhooks}; notifications ${plan.communications.notifications}`);
  if (plan.artifacts) compare("artifacts", manifest.artifacts, plan.artifacts, `${plan.artifacts.storage} artifact storage retained ${plan.artifacts.retentionDays} days`);
  if (plan.regional) compare("regional", manifest.regional, plan.regional, `${plan.regional.language}, ${plan.regional.locale}, ${plan.regional.timeZone}, ${plan.regional.currency}; i18n ${plan.regional.i18n.enabled ? plan.regional.i18n.languages.join("/") : "off"}`);
  compare("environments", manifest.environments, plan.environments, "declared environments match");
  for (const secret of plan.secrets) {
    const actual = manifest.secrets?.[secret.name];
    compare(`secrets.${secret.name}`, actual ? { target: actual.target, required: actual.required } : undefined, { target: secret.target, required: secret.required }, `${secret.name} declaration`);
  }
  for (const resource of plan.resources) {
    const current = await declaration(root, resource.name);
    items.push({
      id: `resources.${resource.name}`,
      classification: !current ? "create" : current.tenant === resource.tenant && current.crud === resource.crud ? "already correct" : "update",
      summary: `${resource.name} tenant=${resource.tenant} crud=${resource.crud}`,
    });
    if (current && current.tenant === resource.tenant && current.crud === resource.crud && !(await resourceArtifactsComplete(root, manifest, resource.name, current))) {
      items.push({ id: `resources.${resource.name}.sources`, classification: "create", summary: `${resource.name} missing generated sources or registrations` });
    }
    if (current && current.tenant === resource.tenant && current.crud === resource.crud && !(await hasMigration(root, manifest, current))) {
      items.push({ id: `resources.${resource.name}.migration`, classification: "create", summary: `${resource.name} journaled forced-RLS migration` });
    }
  }
  for (const external of plan.externalResources) {
    items.push({ id: `external.${external.environment}.${external.name}`, classification: external.environment === "local" ? "unknown" : "blocked", summary: `${external.name} requires provider reconciliation in ${external.environment}` });
  }
  for (const [index, operation] of plan.destructiveOperations.entries()) {
    items.push({ id: `destructive.${index}`, classification: "delete", summary: `${operation.environment}: ${operation.description}` });
  }
  return { planHash: planHash(input), items, converged: items.every(({ classification }) => classification === "already correct") };
}

export function formatPlanDiff(diff: PlanDiff): string {
  return `${diff.items.map((item) => `${item.classification.padEnd(15)} ${item.id}  ${item.summary}`).join("\n")}\n\n${diff.converged ? "Plan converged." : "Plan has pending or blocked changes."}\n`;
}

type ApplyState = { schemaVersion: 1; planHash: string; updatedAt: string; operations: Array<{ id: string; status: "completed" | "blocked"; files?: string[]; reason?: string }> };

export async function applySetupPlan(root: string, manifest: ProjectManifest, plan: SetupPlan, input: string): Promise<ApplyState> {
  const diff = await diffSetupPlan(root, manifest, plan, input);
  const operations: ApplyState["operations"] = [];
  const declarations = diff.items.filter((item) => item.classification === "update" && MANIFEST_DECLARATIONS.has(item.id));
  const unsafe = diff.items.filter((item) => !declarations.includes(item) && (!["already correct", "create"].includes(item.classification) || (item.classification === "create" && !item.id.startsWith("resources."))));
  if (unsafe.length) {
    for (const item of unsafe) operations.push({ id: item.id, status: "blocked", reason: `${item.classification}: ${item.summary}` });
    const state = { schemaVersion: 1 as const, planHash: diff.planHash, updatedAt: new Date().toISOString(), operations };
    await writeApplyState(root, state);
    throw new CliFailure(`apply is blocked:\n${unsafe.map((item) => `${item.classification} ${item.id}: ${item.summary}`).join("\n")}`);
  }
  if (declarations.length) {
    await updateManifestDeclarations(root, plan, declarations.map(({ id }) => id));
    for (const item of declarations) operations.push({ id: item.id, status: "completed", files: [path.join(".trestle", "project.yaml")] });
  }
  const migrations = new Map<string, SetupPlan["resources"][number]>();
  for (const resource of plan.resources) {
    const item = diff.items.find(({ id }) => id === `resources.${resource.name}`);
    const sources = diff.items.find(({ id }) => id === `resources.${resource.name}.sources`);
    if (item?.classification === "create" || sources?.classification === "create") {
      if (item?.classification === "create") migrations.set(resource.name, resource);
      const files = await generateResource(root, manifest, resource);
      operations.push({ id: item?.classification === "create" ? item.id : sources!.id, status: "completed", ...(files.length ? { files } : {}) });
    }
    else operations.push({ id: `resources.${resource.name}`, status: "completed" });
    if (diff.items.some(({ id, classification }) => id === `resources.${resource.name}.migration` && classification === "create")) migrations.set(resource.name, resource);
  }
  if (migrations.size) {
    const migrationFiles = await generateResourceMigration(root, manifest, [...migrations.values()]);
    if (migrationFiles.length) operations.push({ id: "database.migration", status: "completed", files: migrationFiles });
  }
  const state = { schemaVersion: 1 as const, planHash: diff.planHash, updatedAt: new Date().toISOString(), operations };
  await writeApplyState(root, state);
  return state;
}

const MANIFEST_DECLARATIONS = new Set(["capabilities", "providers", "authentication", "identity", "access", "commercial", "communications", "artifacts", "regional"]);

async function updateManifestDeclarations(root: string, plan: SetupPlan, ids: string[]): Promise<void> {
  const manifestPath = path.join(root, ".trestle", "project.yaml");
  const document = parseDocument(await readFile(manifestPath, "utf8"));
  for (const id of ids) {
    if (id === "capabilities") for (const [name, enabled] of Object.entries(plan.capabilities)) document.setIn(["capabilities", name], enabled);
    else if (id === "providers" && plan.providers) document.set("integrations", { ...plan.providers });
    else if (id === "authentication" && plan.authentication) document.set("authentication", { ...plan.authentication });
    else if (id === "identity" && plan.identity) document.set("identity", { ...plan.identity });
    else if (id === "communications" && plan.communications) document.set("communications", { ...plan.communications });
    else if (id === "access" && plan.access) document.set("access", { ...plan.access });
    else if (id === "commercial" && plan.commercial) document.set("commercial", { ...plan.commercial });
    else if (id === "artifacts" && plan.artifacts) document.set("artifacts", { ...plan.artifacts });
    else if (id === "regional" && plan.regional) document.set("regional", { ...plan.regional, i18n: { ...plan.regional.i18n, languages: [...plan.regional.i18n.languages] } });
  }
  const result = projectManifestSchema.safeParse(document.toJS());
  if (!result.success) throw new CliFailure(`apply would produce an invalid manifest: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  await writeFile(manifestPath, document.toString(), "utf8");
}

export function planFromManifest(manifest: ProjectManifest, resources: SetupPlan["resources"] = []): SetupPlan {
  return {
    schemaVersion: 1,
    minimumTrestleVersion: TRESTLEJS_VERSION,
    project: { name: manifest.project.name },
    apps: {
      site: Boolean(manifest.apps.site),
      app: Boolean(manifest.apps.app),
      worker: Boolean(manifest.apps.worker),
      ...(manifest.apps.admin || manifest.capabilities.admin ? { admin: Boolean(manifest.apps.admin) && manifest.capabilities.admin } : {}),
    },
    tenancy: { ...manifest.tenancy },
    database: { engine: manifest.database.engine, provider: manifest.database.defaultProvider },
    capabilities: { ...manifest.capabilities },
    integrations: { email: Boolean(manifest.packages.integrations), billing: Boolean(manifest.packages.billing) },
    ...(manifest.integrations ? { providers: { ...manifest.integrations } } : {}),
    ...(manifest.authentication ? { authentication: { ...manifest.authentication } } : {}),
    ...(manifest.identity ? { identity: { ...manifest.identity } } : {}),
    ...(manifest.access ? { access: { ...manifest.access } } : {}),
    ...(manifest.commercial ? { commercial: { ...manifest.commercial } } : {}),
    ...(manifest.communications ? { communications: { ...manifest.communications } } : {}),
    ...(manifest.artifacts ? { artifacts: { ...manifest.artifacts } } : {}),
    ...(manifest.regional ? { regional: { ...manifest.regional, i18n: { ...manifest.regional.i18n, languages: [...manifest.regional.i18n.languages] } } } : {}),
    environments: [...manifest.environments],
    secrets: Object.entries(manifest.secrets ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, declaration]) => ({ name, target: declaration.target, required: [...declaration.required] })),
    resources: resources.map((resource) => ({ ...resource })),
    externalResources: [],
    destructiveOperations: [],
    verification: { commands: ["pnpm exec trestle doctor"] },
  };
}

async function writeApplyState(root: string, state: ApplyState): Promise<void> {
  const statePath = path.join(root, ".trestle", "setup.state.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readApplyState(root: string): Promise<ApplyState | undefined> {
  try { return JSON.parse(await readFile(path.join(root, ".trestle", "setup.state.json"), "utf8")) as ApplyState; }
  catch { return undefined; }
}

export function formatPlanJson(data: unknown): string {
  return `${JSON.stringify(structuredOutput(data), null, 2)}\n`;
}
