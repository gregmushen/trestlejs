import type { WorkerEnvironment } from "../../worker/src/worker-environment.js";

/**
 * The Worker environment, read from this trigger.dev environment's variables
 * (pushed with `trestle jobs env push`). DATABASE_URL is the same restricted
 * runtime login the Worker uses: tenant work still runs under forced RLS.
 */
export function jobEnvironment(): WorkerEnvironment {
  const environment = process.env as unknown as WorkerEnvironment;
  if (!environment.DATABASE_URL) throw new Error("DATABASE_URL is not set for this trigger.dev environment; run trestle jobs env push");
  return environment;
}
