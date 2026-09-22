import { PostgresOutboxStore } from "../src/outbox.js";

const [operation, id] = process.argv.slice(2);
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
if (!operation || !["list", "redrive"].includes(operation)) throw new Error("expected list or redrive");
const store = new PostgresOutboxStore(connectionString);
try {
  if (operation === "list") {
    const entries = await store.listDead();
    process.stdout.write(`${JSON.stringify(entries.map(({ id: entryId, message, status, attempts, availableAt, lastError }) => ({ id: entryId, event: `${message.name}@${message.schemaVersion}`, resource: message.resource, status, attempts, availableAt: availableAt.toISOString(), lastError: lastError ?? null })))}\n`);
  } else {
    if (!id) throw new Error("redrive requires an outbox entry ID");
    const entry = await store.redrive(id);
    process.stdout.write(`${JSON.stringify({ id: entry.id, event: `${entry.message.name}@${entry.message.schemaVersion}`, status: entry.status })}\n`);
  }
} finally { await store.close(); }
