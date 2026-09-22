import path from "node:path";

export type FreshDevelopmentPlan = Readonly<{ composeFile: string; stateDirectories: readonly string[] }>;

export function freshDevelopmentPlan(root: string, workerPath: string): FreshDevelopmentPlan {
  const resolvedRoot = path.resolve(root);
  const stateDirectories = [path.resolve(resolvedRoot, workerPath, ".wrangler", "state")];
  for (const target of stateDirectories) {
    const relative = path.relative(resolvedRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("refusing to reset unresolved or non-project local state");
  }
  return { composeFile: path.join(resolvedRoot, "compose.yaml"), stateDirectories };
}

export function assertLocalDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("fresh local development refuses a remote database URL");
  return url;
}
