import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function resourceName(value, maximum = 63) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, maximum - digest.length - 1).replace(/-+$/u, "")}-${digest}`;
}

export function createPreviewContext({ project, pullRequest, workersSubdomain }) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(project)) throw new Error("project must be a lowercase DNS-safe name");
  if (!/^[1-9][0-9]*$/u.test(String(pullRequest))) throw new Error("pull request number must be a positive integer");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(workersSubdomain)) throw new Error("workers subdomain must be a lowercase DNS label");

  const suffix = `pr-${pullRequest}`;
  const workerName = resourceName(`${project}-worker-${suffix}`);
  const appProject = resourceName(`${project}-app-${suffix}`);
  const siteProject = resourceName(`${project}-site-${suffix}`);
  return {
    environment: `preview-${suffix}`,
    branch: suffix,
    workerName,
    appProject,
    siteProject,
    apiUrl: `https://${workerName}.${workersSubdomain}.workers.dev`,
    appUrl: `https://${appProject}.pages.dev`,
    siteUrl: `https://${siteProject}.pages.dev`,
  };
}

function githubOutput(context) {
  return Object.entries({
    environment: context.environment,
    branch: context.branch,
    worker_name: context.workerName,
    app_project: context.appProject,
    site_project: context.siteProject,
    api_url: context.apiUrl,
    app_url: context.appUrl,
    site_url: context.siteUrl,
  }).map(([name, value]) => `${name}=${value}`).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const context = createPreviewContext({
      project: argument("project") ?? "",
      pullRequest: argument("pr") ?? "",
      workersSubdomain: argument("workers-subdomain") ?? "",
    });
    process.stdout.write(`${argument("format") === "github" ? githubOutput(context) : JSON.stringify(context, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
