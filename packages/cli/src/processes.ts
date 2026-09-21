import { spawn } from "node:child_process";

export async function runCommand(
  command: string,
  arguments_: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; stdio?: "inherit" | "pipe" },
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const piped = options.stdio === "pipe" || options.input !== undefined;
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${arguments_.join(" ")} failed (${signal ?? `exit ${String(code)}`})${stderr ? `\n${stderr.trim()}` : ""}`));
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export async function runDevelopment(root: string, environment: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["--parallel", "--filter", "./apps/*", "dev"], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
    child.once("error", reject);
    child.once("exit", (code) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? 1);
    });
  });
}
