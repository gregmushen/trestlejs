import { z } from "zod";

/**
 * Scripts this project allows its job runners to execute, by name. A task
 * payload selects a script by name and supplies input validated against its
 * schema; it can never supply a path, a command, or arguments. Add a script by
 * putting it under apps/jobs/python/ and registering it here in review.
 */
export const approvedScripts = {
  "echo-input": {
    file: "./python/echo_input.py",
    description: "Example: reads validated JSON input and writes it back",
    input: z.object({ message: z.string().max(1_000) }).strict(),
  },
} as const satisfies Record<string, { file: `./python/${string}.py`; description: string; input: z.ZodType }>;

export type ApprovedScriptName = keyof typeof approvedScripts;

export class UnapprovedScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedScriptError";
  }
}

/** Resolves a request to an approved script and its validated input, or throws. */
export function resolveApprovedScript(request: { script: unknown; input: unknown }): { file: string; argument: string } {
  if (typeof request.script !== "string" || !Object.hasOwn(approvedScripts, request.script)) throw new UnapprovedScriptError("script is not approved");
  const script = approvedScripts[request.script as ApprovedScriptName];
  const parsed = script.input.safeParse(request.input);
  if (!parsed.success) throw new UnapprovedScriptError(`input for ${request.script} is invalid`);
  // Input reaches the script as one JSON argument, never through a shell.
  return { file: script.file, argument: JSON.stringify(parsed.data) };
}
