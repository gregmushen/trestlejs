import { spawn } from "node:child_process";

/**
 * Trusted child-process boundary (spec §24, plan P03): argument arrays only,
 * explicit working directory, caller-supplied minimal environment, bounded
 * time and output. Output is returned privately; callers sanitize before any
 * display.
 */

export type ProcessSpec = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type ProcessResult = Readonly<{
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}>;

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
}

export class ProcessSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessSpecError";
  }
}

const SAFE_ARGUMENT = /^[A-Za-z0-9@%+=:,./_-]{1,512}$/u;

/** Arguments are data, never shell syntax: reject control characters, whitespace and metacharacters. */
export function assertSafeArguments(args: readonly string[]): void {
  for (const argument of args) {
    if (!SAFE_ARGUMENT.test(argument)) throw new ProcessSpecError(`unsafe process argument rejected: ${JSON.stringify(argument.slice(0, 40))}`);
  }
}

export const nodeProcessRunner: ProcessRunner = {
  async run(spec) {
    if (!spec.executable.startsWith("/")) throw new ProcessSpecError("executables must be absolute paths; PATH lookup is not used");
    assertSafeArguments(spec.args);
    return await new Promise((resolve, reject) => {
      const child = spawn(spec.executable, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const collect = (sink: Buffer[]) => (chunk: Buffer) => {
        if (truncated) return;
        bytes += chunk.length;
        if (bytes > spec.maxOutputBytes) {
          truncated = true;
          kill();
          return;
        }
        sink.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, spec.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), timedOut, truncated });
      });
    });
  },
};
