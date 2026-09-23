export type CommandRunner = (
  command: string,
  arguments_: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string; stdio?: "inherit" | "pipe" },
) => Promise<{ stdout: string; stderr: string }>;

export type CliRuntime = {
  cwd: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  environment?: (name: string) => string | undefined;
  stdin?: () => Promise<string>;
  isTTY?: () => boolean;
  /** Overrides subprocess execution for read-only inspection commands (tests). */
  run?: CommandRunner;
};

export const processRuntime: CliRuntime = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  environment: (name) => process.env[name],
  stdin: async () => {
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    return input;
  },
  isTTY: () => Boolean(process.stdout.isTTY),
};

export class CliFailure extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliFailure";
    this.exitCode = exitCode;
  }
}
