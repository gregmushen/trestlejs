import { python } from "@trigger.dev/python";
import { AbortTaskRunError, task } from "@trigger.dev/sdk";

import { resolveApprovedScript, UnapprovedScriptError } from "../scripts.js";

/**
 * Runs one approved Python script (src/scripts.ts) on whichever machine runs
 * this project's trigger.dev tasks: trigger.dev's cloud, or your own servers
 * and machines through a self-hosted trigger.dev worker. An unapproved script
 * or invalid input ends the run without retries.
 */
export const trestleScript = task({
  id: "trestle-script",
  retry: { maxAttempts: 3 },
  run: async (payload: { script: string; input: unknown }) => {
    let resolved: { file: string; argument: string };
    try { resolved = resolveApprovedScript(payload); }
    catch (error) { if (error instanceof UnapprovedScriptError) throw new AbortTaskRunError(error.message); throw error; }
    const result = await python.runScript(resolved.file, [resolved.argument]);
    return { stdout: result.stdout };
  },
});
