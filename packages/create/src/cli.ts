import { TRESTLEJS_VERSION } from "@trestlejs/core";
import { Command, CommanderError } from "commander";

import { createProject } from "./create-project.js";

export type CreateCliRuntime = {
  cwd: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export const processCreateRuntime: CreateCliRuntime = {
  cwd: () => process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function executeCreateCli(
  arguments_: string[],
  runtime: CreateCliRuntime,
): Promise<number> {
  const program = new Command()
    .name("create-trestlejs")
    .description("Create a conventional TrestleJS application")
    .version(TRESTLEJS_VERSION)
    .argument("<directory>", "project directory")
    .option("--no-install", "skip pnpm install")
    .option("--no-git", "skip git initialization")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride()
    .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
    .action(async (directory: string, options: { install: boolean; git: boolean }) => {
      const result = await createProject({
        cwd: runtime.cwd(),
        directory,
        install: options.install,
        git: options.git,
      });
      runtime.stdout(
        `Created ${result.name} at ${result.directory}\n\nNext:\n  cd ${directory}\n  pnpm dev\n`,
      );
    });

  try {
    await program.parseAsync(["node", "create-trestlejs", ...arguments_]);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    runtime.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
