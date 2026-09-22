import { appendFile } from "node:fs/promises";

const [operation, sourceName, targetName, recoveryPoint] = process.argv.slice(2);
const apiKey = process.env.NEON_API_KEY ?? "";
const projectId = process.env.NEON_PROJECT_ID ?? "";
const database = process.env.NEON_DATABASE ?? "";
const migrationRole = process.env.NEON_MIGRATION_ROLE ?? "";
const runtimeRole = process.env.DATABASE_RUNTIME_ROLE ?? "";
const outputPath = process.env.TRESTLE_RECOVERY_OUTPUT ?? "";
const apiBase = (process.env.NEON_API_BASE ?? "https://console.neon.tech/api/v2").replace(/\/$/u, "");

if (!apiKey || !/^[a-z0-9-]{1,60}$/u.test(projectId)) throw new Error("NEON_API_KEY and NEON_PROJECT_ID are required");
if (!["status", "restore", "delete"].includes(operation ?? "")) throw new Error("expected status, restore, or delete");
const validName = (value) => typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value);
if (!validName(sourceName)) throw new Error("invalid source branch name");
if (operation !== "status" && (!validName(targetName) || targetName === sourceName)) throw new Error("restore target must be a distinct valid branch name");

const headers = { accept: "application/json", authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
async function request(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, { ...options, headers });
  if (!response.ok && response.status !== 404) throw new Error(`Neon API request failed with HTTP ${response.status}`);
  return response;
}
async function branches() { const response = await request(`/projects/${projectId}/branches?limit=100`); return (await response.json()).branches ?? []; }
function exact(values, name) { const matches = values.filter((branch) => branch?.name === name); if (matches.length > 1) throw new Error(`Neon returned multiple branches named ${name}`); return matches[0]; }

const values = await branches();
const source = exact(values, sourceName);
if (!source) throw new Error(`source branch ${sourceName} was not found`);

if (operation === "status") {
  const projectResponse = await request(`/projects/${projectId}`);
  const project = (await projectResponse.json()).project ?? {};
  process.stdout.write(`${JSON.stringify({ provider: "neon", projectId, source: { id: source.id, name: source.name, createdAt: source.created_at, updatedAt: source.updated_at }, historyRetentionSeconds: project.history_retention_seconds ?? null, status: "provider-history-available", restoreVerified: false })}\n`);
} else if (operation === "delete") {
  const target = exact(values, targetName);
  if (!target) process.stdout.write(`${JSON.stringify({ target: targetName, cleanup: "already_absent" })}\n`);
  else { await request(`/projects/${projectId}/branches/${encodeURIComponent(target.id)}`, { method: "DELETE" }); process.stdout.write(`${JSON.stringify({ target: targetName, cleanup: "deleted" })}\n`); }
} else {
  if (!database || !migrationRole || !runtimeRole || !outputPath) throw new Error("NEON_DATABASE, NEON_MIGRATION_ROLE, DATABASE_RUNTIME_ROLE, and TRESTLE_RECOVERY_OUTPUT are required");
  if (exact(values, targetName)) throw new Error(`restore target ${targetName} already exists; delete it explicitly before restoring`);
  const point = recoveryPoint && recoveryPoint !== "latest" ? recoveryPoint : undefined;
  if (point && Number.isNaN(new Date(point).getTime())) throw new Error("invalid recovery point");
  const response = await request(`/projects/${projectId}/branches`, { method: "POST", body: JSON.stringify({ branch: { name: targetName, parent_id: source.id, ...(point ? { parent_timestamp: point } : {}) }, endpoints: [{ type: "read_write" }] }) });
  const branch = (await response.json()).branch;
  if (!branch?.id) throw new Error("Neon restore did not return a branch ID");
  async function connectionUri(roleName, pooled) {
    const query = new URLSearchParams({ branch_id: branch.id, database_name: database, role_name: roleName, pooled: String(pooled) });
    const result = await request(`/projects/${projectId}/connection_uri?${query}`);
    const uri = (await result.json()).uri;
    if (typeof uri !== "string" || !/^postgres(?:ql)?:\/\//u.test(uri) || /[\r\n]/u.test(uri)) throw new Error("Neon connection URI response was invalid");
    return uri;
  }
  const migrationUrl = await connectionUri(migrationRole, false);
  const runtimeUrl = await connectionUri(runtimeRole, false);
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${migrationUrl}\n::add-mask::${runtimeUrl}\n`);
  await appendFile(outputPath, `branch_id=${branch.id}\nmigration_url=${migrationUrl}\nruntime_url=${runtimeUrl}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ provider: "neon", source: source.name, target: branch.name, branchId: branch.id, recoveryPoint: point ?? "latest", isolated: true })}\n`);
}
