import { appendFile } from "node:fs/promises";

const [operation, branchName] = process.argv.slice(2);
const apiKey = process.env.NEON_API_KEY ?? "";
const projectId = process.env.NEON_PROJECT_ID ?? "";
const apiBase = (process.env.NEON_API_BASE ?? "https://console.neon.tech/api/v2").replace(/\/$/u, "");

if (!['ensure', 'runtime', 'delete'].includes(operation ?? '')) throw new Error("expected ensure, runtime, or delete");
if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(branchName ?? "")) throw new Error("invalid Neon branch name");
if (!/^[a-z0-9-]{1,60}$/u.test(projectId)) throw new Error("NEON_PROJECT_ID is required");
if (!apiKey) throw new Error("NEON_API_KEY is required");

const headers = { accept: "application/json", authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok && response.status !== 404) throw new Error(`Neon API request failed with HTTP ${response.status}`);
  return response;
}

async function exactBranch() {
  const query = new URLSearchParams({ search: branchName, limit: "100" });
  const response = await request(`${apiBase}/projects/${projectId}/branches?${query}`);
  const body = await response.json();
  const matches = Array.isArray(body.branches) ? body.branches.filter((branch) => branch?.name === branchName) : [];
  if (matches.length > 1) throw new Error(`Neon returned multiple exact branches named ${branchName}`);
  return matches[0];
}

if (operation === "delete") {
  const branch = await exactBranch();
  if (!branch) {
    process.stdout.write(`${branchName} already absent\n`);
  } else {
    const response = await request(`${apiBase}/projects/${projectId}/branches/${encodeURIComponent(branch.id)}`, { method: "DELETE" });
    if (response.status === 404) process.stdout.write(`${branchName} already absent\n`);
    else process.stdout.write(`Deleted ${branchName}\n`);
  }
} else {
  const database = process.env.NEON_DATABASE ?? "";
  const outputPath = process.env.GITHUB_OUTPUT ?? "";
  if (!database || !outputPath) throw new Error("Neon database and GITHUB_OUTPUT are required");

  let branch = await exactBranch();
  if (!branch && operation === "runtime") throw new Error(`Neon branch ${branchName} does not exist`);
  if (!branch) {
    const response = await request(`${apiBase}/projects/${projectId}/branches`, {
      method: "POST",
      body: JSON.stringify({ branch: { name: branchName }, endpoints: [{ type: "read_write" }] }),
    });
    const body = await response.json();
    branch = body.branch;
    if (!branch?.id) throw new Error("Neon branch response did not contain an ID");
  }

  async function connectionUri(roleName, pooled) {
    const query = new URLSearchParams({ branch_id: branch.id, database_name: database, role_name: roleName, pooled: String(pooled) });
    const response = await request(`${apiBase}/projects/${projectId}/connection_uri?${query}`);
    const body = await response.json();
    if (typeof body.uri !== "string" || !/^postgres(?:ql)?:\/\//u.test(body.uri) || /[\r\n]/u.test(body.uri)) throw new Error("Neon connection URI response was invalid");
    return body.uri;
  }

  if (operation === "ensure") {
    const migrationRole = process.env.NEON_MIGRATION_ROLE ?? "";
    if (!migrationRole) throw new Error("NEON_MIGRATION_ROLE is required");
    const migrationUrl = await connectionUri(migrationRole, false);
    if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${migrationUrl}\n`);
    await appendFile(outputPath, `branch_id=${branch.id}\nmigration_url=${migrationUrl}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`Ready ${branchName}\n`);
  } else {
    const runtimeRole = process.env.NEON_RUNTIME_ROLE ?? "";
    if (!runtimeRole) throw new Error("NEON_RUNTIME_ROLE is required");
    const runtimeUrl = await connectionUri(runtimeRole, true);
    if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::add-mask::${runtimeUrl}\n`);
    await appendFile(outputPath, `runtime_url=${runtimeUrl}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`Resolved runtime connection for ${branchName}\n`);
  }
}
