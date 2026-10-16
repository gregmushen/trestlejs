import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { canonicalDigest, sha256 } from "./canonical.js";
import type { PagesHost, PagesPlan } from "./pages.js";
import { nodeProcessRunner, type ProcessRunner } from "./process.js";

const GITHUB_CLI = process.platform === "darwin" ? "/opt/homebrew/bin/gh" : "/usr/bin/gh";

/** Exact pinned host implementation inspected against Wrangler 4.135.0.
 * Structured JSONL receipts avoid parsing success banners or assuming a 200. */
export async function pagesWranglerDigest(binary: string): Promise<string> {
  const directory = path.dirname(path.dirname(binary));
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")) as { version: string };
  if (metadata.version !== "4.135.0") throw new Error("Pages deployment is qualified only for Wrangler 4.135.0");
  return canonicalDigest({ binary: sha256(await readFile(binary)), implementation: sha256(await readFile(path.join(directory, "wrangler-dist/cli.js"))), version: metadata.version }).slice(7);
}

export function stagingRunMatches(run: unknown, repository: string, commit: string): boolean {
  const r = run as { head_sha?: unknown; event?: unknown; head_branch?: unknown; status?: unknown; conclusion?: unknown; path?: unknown; repository?: { full_name?: unknown } } | null;
  return Boolean(r && r.head_sha === commit && r.event === "push" && r.head_branch === "main" && r.status === "completed" && r.conclusion === "success" && r.path === ".github/workflows/deploy.yml" && r.repository?.full_name === repository);
}

export class WranglerPagesHost implements PagesHost {
  constructor(private readonly root: string, private readonly binary: string, private readonly environment: Readonly<Record<string, string>>, private readonly runner: ProcessRunner = nodeProcessRunner) {}
  private async command(executable: string, args: string[], cwd: string, extra: Record<string, string> = {}): Promise<string> {
    const env = Object.fromEntries(Object.entries({ ...this.environment, ...extra }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    // Build/upload processes never receive GitHub's authorization credential.
    if (executable !== GITHUB_CLI) { delete env.GH_TOKEN; delete env.GITHUB_TOKEN; }
    if (executable === GITHUB_CLI || executable === "/usr/bin/git") delete env.CLOUDFLARE_API_TOKEN;
    const response = await this.runner.run({ executable, args, cwd, env, timeoutMs: 300_000, maxOutputBytes: 2_000_000 });
    if (response.exitCode !== 0 || response.timedOut || response.truncated) throw new Error("Pages host command failed or its outcome is unknown");
    return response.stdout;
  }
  async preflight(plan: PagesPlan): Promise<void> {
    if (await pagesWranglerDigest(this.binary) !== plan.pages.wranglerSha256) throw new Error("Wrangler implementation changed");
    const git = (args: string[]) => this.command("/usr/bin/git", args, this.root, { PATH: "/usr/bin:/bin" });
    if ((await git(["rev-parse", "HEAD"])).trim() !== plan.pages.commit || (await git(["status", "--porcelain"])).trim()) throw new Error("Pages deployment requires the clean exact reviewed revision");
    const remote = (await git(["remote", "get-url", "origin"])).trim().replace(/\.git$/u, "");
    if (remote !== `https://github.com/${plan.pages.repository}` && remote !== `git@github.com:${plan.pages.repository}`) throw new Error("GitHub repository identity differs from the plan");
    await this.inspectTarget(plan.pages.accountId, plan.pages.project);
    if (plan.environment === "production") {
      const output = await this.command(GITHUB_CLI, ["api", "--method", "GET", `repos/${plan.pages.repository}/actions/runs`, "-f", `head_sha=${plan.pages.commit}`, "-f", "per_page=100"], this.root);
      const runs = (JSON.parse(output) as { workflow_runs?: unknown[] }).workflow_runs;
      if (!runs?.some(run => stagingRunMatches(run, plan.pages.repository, plan.pages.commit))) throw new Error("no exact-SHA successful staging push/main deployment");
    }
  }
  async inspectTarget(accountId: string, project: string): Promise<void> {
    await pagesWranglerDigest(this.binary);
    const cwd = await mkdtemp(path.join(os.tmpdir(), "trestle-pages-inspect-"));
    const account = { CLOUDFLARE_ACCOUNT_ID: accountId, CI: "true" };
    try {
      const identity = JSON.parse(await this.command(process.execPath, [this.binary, "whoami", "--json"], cwd, account)) as { accounts?: { id: string }[] };
      if (!identity.accounts?.some(row => row.id === accountId)) throw new Error("Cloudflare account not authorized");
      const projects = JSON.parse(await this.command(process.execPath, [this.binary, "pages", "project", "list", "--json"], cwd, account)) as { "Project Name": string }[];
      if (!projects.some(row => row["Project Name"] === project)) throw new Error("Pages project must be provisioned separately before deployment");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }
  async upload(directory: string, plan: PagesPlan): Promise<{ deploymentId: string; url: string }> {
    // Caller snapshots only reviewed config/assets/functions into this private
    // directory; no .env, Worker config or project install hook is copied.
    const output = path.join(directory, "receipt.jsonl");
    await this.command(process.execPath, [this.binary, "pages", "deploy", "dist", "--project-name", plan.pages.project, "--branch", "main", "--commit-hash", plan.pages.commit, "--commit-dirty=false", "--no-bundle"], directory, { CLOUDFLARE_ACCOUNT_ID: plan.pages.accountId, CI: "true", WRANGLER_OUTPUT_FILE_PATH: output });
    const rows = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string; pages_project: string; deployment_id: string; url: string; environment?: string; deployment_trigger?: { metadata?: { commit_hash?: string } } });
    const receipt = rows.find(row => row.type === "pages-deploy-detailed" && row.pages_project === plan.pages.project && row.environment === "production" && row.deployment_trigger?.metadata?.commit_hash === plan.pages.commit);
    if (!receipt || !/^[A-Za-z0-9-]{1,100}$/u.test(receipt.deployment_id)) throw new Error("unrecognized Pages deployment receipt");
    const url = new URL(receipt.url);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.endsWith(`.${plan.pages.project}.pages.dev`) || url.port) throw new Error("Pages receipt targets an unexpected host");
    return { deploymentId: receipt.deployment_id, url: receipt.url };
  }
  async marker(plan: PagesPlan): Promise<{ operationId: string; artifactDigest: string } | null> {
    const response = await fetch(`https://${plan.pages.project}.pages.dev/.well-known/trestle-release.json`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1024) { await reader.cancel(); return null; }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8");
    const result = JSON.parse(text) as { operationId?: unknown; artifactDigest?: unknown };
    return typeof result.operationId === "string" && typeof result.artifactDigest === "string" ? result as { operationId: string; artifactDigest: string } : null;
  }
}
