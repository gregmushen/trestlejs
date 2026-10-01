// Runs applyPlan in its own OS process against the PostgreSQL control store and
// the fake Projects provider. With KILL_AT set, the process SIGKILLs itself at
// that persistence boundary, so recovery is proven across real process death.
import { readFile } from "node:fs/promises";

import { StripeProjectsAdapter, verifyToolchain } from "../../dist/infra/adapters/stripe-projects.js";
import { SUPPORTED_TOOLCHAIN } from "../../dist/infra/capabilities.js";
import { capabilityFor } from "../../dist/infra/capability-matrix.js";
import { nodeProcessRunner } from "../../dist/infra/process.js";
import { applyPlan } from "../../dist/infra/runner.js";
import { PostgresOperationStore } from "../../dist/infra/stores/postgres.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const location = { stripePath: config.stripePath, pluginRoot: config.pluginRoot, home: config.home };
const check = await verifyToolchain(location, nodeProcessRunner, { ...SUPPORTED_TOOLCHAIN, pluginSha256: config.pluginSha256 });
if (!check.ok) throw new Error(check.reasons.join("; "));
const store = await PostgresOperationStore.connect(config.url, { schema: config.schema });
const now = () => new Date(config.now);
const capabilities = (provider, service, operation) => {
  const row = capabilityFor(provider, service, operation);
  return row && row.evidence !== "unsupported" ? { ...row, evidence: "hosted_verified", unknowns: [], toolchain: check.toolchain, observedAt: config.now, credentialScopes: { RESEND_API_KEY: "least_privilege" } } : row;
};
const killAt = config.killAt;
const result = await applyPlan(
  { plan: config.plan, approval: config.approval, intent: config.intent, bindings: config.bindings },
  {
    store, adapter: new StripeProjectsAdapter(check.toolchain, location, nodeProcessRunner), workspace: config.workspace, projectRoot: config.root,
    masterKey: config.masterKey, now, sleep: async () => {}, holder: config.holder, leaseMs: 60_000, capabilities,
    ...(config.confirmAbsent ? { confirmAbsent: config.confirmAbsent } : {}),
    hooks: { at: (boundary, context) => { if (boundary === killAt && context.resource === config.killResource) process.kill(process.pid, "SIGKILL"); } },
  },
);
await store.close();
process.stdout.write(JSON.stringify(result));
