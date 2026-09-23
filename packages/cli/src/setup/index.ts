import { setupResourceSchema, type EnvironmentName } from "@trestlejs/core";

import type { ProjectContext } from "../context.js";
import { inspectResources } from "../inspect.js";
import { planFromManifest, readSetupPlan } from "../plan.js";
import { CliFailure, type CliRuntime } from "../runtime.js";
import { createSetupServer, type SetupServerOptions } from "./server.js";

export { createSetupServer, openBrowser, SESSION_COOKIE, type SetupServer, type SetupServerOptions } from "./server.js";
export { testConnection, type ConnectionProvider, type ConnectionResult, type ConnectionStatus } from "./connections.js";
export { secretFingerprint } from "./security.js";

export type SetupCommandOptions = {
  open: boolean;
  resume?: boolean;
  planOnly?: boolean;
  env: EnvironmentName;
  port?: number;
};

export async function runSetup(
  context: ProjectContext,
  options: SetupCommandOptions,
  runtime: CliRuntime,
  extra: Pick<SetupServerOptions, "masterKey" | "opener" | "fetch" | "clock" | "idleTimeoutMs"> = {},
): Promise<void> {
  if (!context.manifest.environments.includes(options.env)) throw new CliFailure(`${options.env} is not declared in .trestle/project.yaml`);
  const initialPlan = options.resume
    ? (await readSetupPlan(context.root, ".trestle/setup.json", runtime)).plan
    : planFromManifest(context.manifest, (await inspectResources(context.root)).map(({ name, tenant, crud }) => setupResourceSchema.parse({ name, tenant, crud })));
  const server = await createSetupServer({
    ...extra,
    root: context.root,
    environment: options.env,
    initialPlan,
    planOnly: Boolean(options.planOnly),
    open: options.open,
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  runtime.stdout(`Trestle setup: ${server.launchUrl}\n${options.planOnly ? "Plan-only mode: credentials and apply are disabled.\n" : ""}Press Ctrl+C or use Close session to stop. The link works once.\n`);
  const interrupt = () => { void server.close(); };
  process.once("SIGINT", interrupt);
  try {
    await server.closed;
  } finally {
    process.off("SIGINT", interrupt);
  }
  runtime.stdout("Setup session closed.\n");
}
