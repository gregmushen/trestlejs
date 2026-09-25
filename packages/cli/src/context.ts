import path from "node:path";

import { findProjectRoot, loadProjectManifest, type ProjectManifest } from "./core.js";
import type { Command } from "commander";

import type { CliRuntime } from "./runtime.js";

export type ProjectContext = {
  root: string;
  manifest: ProjectManifest;
};

export async function projectContext(command: Command, runtime: CliRuntime): Promise<ProjectContext> {
  const options = command.optsWithGlobals<{ cwd?: string }>();
  const start = options.cwd ? path.resolve(runtime.cwd(), options.cwd) : runtime.cwd();
  const root = await findProjectRoot(start);
  return { root, manifest: await loadProjectManifest(root) };
}
