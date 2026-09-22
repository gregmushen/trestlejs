const [operation, environment, ref, environmentUrl] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY ?? "";
const token = process.env.GITHUB_TOKEN ?? "";
const apiBase = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/u, "");

if (!['create', 'deactivate'].includes(operation ?? '')) throw new Error("expected create or deactivate");
if (!/^[a-z0-9][a-z0-9-]*$/u.test(environment ?? "")) throw new Error("invalid deployment environment");
if (!/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Error("GITHUB_REPOSITORY is required");
if (!token) throw new Error("GITHUB_TOKEN is required");
if (operation === "create" && (!/^[0-9a-f]{40}$/u.test(ref ?? "") || !/^https:\/\//u.test(environmentUrl ?? ""))) throw new Error("create requires a commit SHA and HTTPS environment URL");

const headers = {
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
};

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok) throw new Error(`GitHub deployment request failed with HTTP ${response.status}`);
  return response;
}

async function status(deploymentId, state, url) {
  await request(`${apiBase}/repos/${repository}/deployments/${deploymentId}/statuses`, {
    method: "POST",
    body: JSON.stringify({
      state,
      ...(url ? { environment_url: url } : {}),
      ...(process.env.GITHUB_RUN_ID ? { log_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` } : {}),
      description: state === "success" ? "Preview smoke gate passed" : "Preview resources removed",
      auto_inactive: state === "success",
    }),
  });
}

if (operation === "create") {
  const response = await request(`${apiBase}/repos/${repository}/deployments`, {
    method: "POST",
    body: JSON.stringify({
      ref,
      environment,
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
      description: "Trestle isolated pull-request preview",
    }),
  });
  const deployment = await response.json();
  if (typeof deployment.id !== "number") throw new Error("GitHub deployment response did not contain an ID");
  await status(deployment.id, "success", environmentUrl);
  process.stdout.write(`Recorded ${environment} deployment ${deployment.id}\n`);
} else {
  const response = await request(`${apiBase}/repos/${repository}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`);
  const deployments = await response.json();
  if (!Array.isArray(deployments)) throw new Error("GitHub deployment list was invalid");
  await Promise.all(deployments.map(async (deployment) => {
    if (typeof deployment.id !== "number") throw new Error("GitHub deployment response did not contain an ID");
    await status(deployment.id, "inactive");
  }));
  process.stdout.write(`Deactivated ${deployments.length} ${environment} deployment(s)\n`);
}
