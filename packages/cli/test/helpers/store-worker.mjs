// Separate-process client of the PostgreSQL control store, used to prove
// cross-process exclusion. Usage: node store-worker.mjs <url> <schema> <json-command>
import { PostgresOperationStore } from "../../dist/infra/stores/postgres.js";

const [url, schema, raw] = process.argv.slice(2);
const command = JSON.parse(raw);
const store = await PostgresOperationStore.connect(url, { schema });
const at = (iso) => new Date(iso);
let result;
try {
  if (command.action === "reserve") result = await store.reserve(command.scope, command.operationId, command.holder, command.leaseMs, at(command.now));
  else if (command.action === "begin") result = await store.beginEffect(command.scope, command.token, command.effectId, at(command.now)).then(() => ({ status: "begun" }));
  else if (command.action === "complete") result = await store.completeEffect(command.scope, command.token, command.effectId, at(command.now));
  else if (command.action === "commit") result = await store.commitGeneration(command.scope, command.expected, command.digest, {}).then((generation) => ({ status: "committed", generation: generation.generation }));
  else if (command.action === "consume") result = await store.consumeApproval(command.approvalId, command.operationId, command.planDigest, at(command.now));
  else throw new Error(`unknown action ${command.action}`);
} catch (error) {
  result = { status: "error", name: error?.name, message: String(error?.message) };
} finally {
  await store.close();
}
process.stdout.write(JSON.stringify(result));
